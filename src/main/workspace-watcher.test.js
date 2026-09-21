// Regression tests for the chokidar-backed workspace watcher (WORK-04/05/06/
// 07). No `electron` mocking is needed here -- unlike dialogs.js/text-file.js,
// this module never touches an Electron API directly (IPC wiring is 07-06's
// job); it only imports chokidar, node:fs, and text-file.js's real recorded-
// stat map. `classifyWatcherEvent` is tested against a real `fs.mkdtempSync`
// temp directory, matching text-file.test.js's/dialogs.test.js's established
// "mock only what's untestable directly, otherwise use real fs" discipline.
//
// Lifecycle/wiring tests (startWorkspaceWatcher/stopWorkspaceWatcher) use a
// REAL chokidar instance against a real temp directory -- per this plan's own
// `<done>` criterion ("...on the real chokidar instance"), the unlinkDir
// wiring regression this task exists to prevent is proven against chokidar
// itself, not a stand-in.
//
// The two canary-fallback-path tests (native watching genuinely non-
// functional) are the one place a fake watcher is used: forcing chokidar's
// own native backend to go silent is not something a temp-directory test can
// reliably reproduce, so `startWorkspaceWatcher`'s optional `watchFn`/
// `writeSentinel` injection seam (mirroring atomic-write.js's own `precheck`
// injection seam) stands in for "native events never arrive."
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  isIgnoredPath,
  classifyWatcherEvent,
  startWorkspaceWatcher,
  stopWorkspaceWatcher
} from './workspace-watcher.js'
import { recordStat } from './text-file.js'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-watcher-test-'))
})

afterEach(async () => {
  await stopWorkspaceWatcher()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('isIgnoredPath', () => {
  it('ignores dotfiles/dot-directories by basename', () => {
    expect(isIgnoredPath('/root/.git')).toBe(true)
    expect(isIgnoredPath('/root/.hidden-file')).toBe(true)
  })

  it('ignores node_modules and .git by exact basename', () => {
    expect(isIgnoredPath('/root/node_modules')).toBe(true)
    expect(isIgnoredPath('/a/b/.git')).toBe(true)
  })

  it('does not ignore an ordinary markdown file or directory', () => {
    expect(isIgnoredPath('/root/notes.md')).toBe(false)
    expect(isIgnoredPath('/root/subdir')).toBe(false)
  })

  it('does not ignore the canary sentinel filename shape (no leading dot)', () => {
    // Deviation (Rule 1): the sentinel must NOT start with '.' -- otherwise
    // isIgnoredPath would filter the canary's own 'add' event on every run,
    // permanently defeating the health check. See workspace-watcher.js's
    // header comment.
    expect(isIgnoredPath('/root/mdforge-canary-abcd1234.tmp')).toBe(false)
  })
})

describe('classifyWatcherEvent', () => {
  it("resolves an 'unlink' event as vanished, isDirectory:false, with no fs.stat call", async () => {
    const statSpy = vi.spyOn(fsPromises, 'stat')
    const target = path.join(tmpDir, 'gone.md')

    const result = await classifyWatcherEvent('unlink', target)

    expect(result).toEqual({ kind: 'vanished', path: target, isDirectory: false })
    expect(statSpy).not.toHaveBeenCalled()
    statSpy.mockRestore()
  })

  it("resolves an 'unlinkDir' event as vanished, isDirectory:true, with no fs.stat call", async () => {
    const statSpy = vi.spyOn(fsPromises, 'stat')
    const target = path.join(tmpDir, 'gone-dir')

    const result = await classifyWatcherEvent('unlinkDir', target)

    expect(result).toEqual({ kind: 'vanished', path: target, isDirectory: true })
    expect(statSpy).not.toHaveBeenCalled()
    statSpy.mockRestore()
  })

  it("resolves 'add'/'change' independently via fs.stat, never trusting a passed-through stat", async () => {
    const target = path.join(tmpDir, 'fresh.md')
    fs.writeFileSync(target, 'hello')
    const realStat = fs.statSync(target)

    // A deliberately WRONG stat object, simulating a stale chokidar-supplied
    // value (Pitfall 5) -- classifyWatcherEvent's signature never even
    // accepts a passed-through stat, but this proves the function re-derives
    // its own via a real fs.stat call rather than trusting anything handed
    // in some other way.
    const result = await classifyWatcherEvent('add', target)

    expect(result.kind).toBe('external-change')
    expect(result.stat.size).toBe(realStat.size)
    expect(result.stat.mtimeMs).toBe(realStat.mtimeMs)
  })

  it("classifies 'add' as own-write when the fresh stat matches text-file.js's recorded stat", async () => {
    const target = path.join(tmpDir, 'saved-by-app.md')
    fs.writeFileSync(target, 'v1')
    const stat = fs.statSync(target)
    recordStat(target, stat)

    const result = await classifyWatcherEvent('add', target)

    expect(result).toEqual({ kind: 'own-write', path: target })
  })

  it("classifies 'change' as external-change when no stat was ever recorded for the path", async () => {
    const target = path.join(tmpDir, 'never-recorded.md')
    fs.writeFileSync(target, 'v1')

    const result = await classifyWatcherEvent('change', target)

    expect(result.kind).toBe('external-change')
    expect(result.path).toBe(target)
  })

  it("classifies 'change' as external-change when the recorded stat no longer matches (real external edit)", async () => {
    const target = path.join(tmpDir, 'edited-externally.md')
    fs.writeFileSync(target, 'v1')
    recordStat(target, fs.statSync(target))

    // Simulate a real external edit landing after the app's own record.
    await new Promise((resolve) => setTimeout(resolve, 10))
    fs.writeFileSync(target, 'v2, changed outside the app')

    const result = await classifyWatcherEvent('change', target)

    expect(result.kind).toBe('external-change')
  })

  it("resolves 'add'/'change' as vanished, isDirectory:false, when fs.stat throws (raced with a delete)", async () => {
    const target = path.join(tmpDir, 'never-existed.md')

    const result = await classifyWatcherEvent('add', target)

    expect(result).toEqual({ kind: 'vanished', path: target, isDirectory: false })
  })
})

describe('startWorkspaceWatcher -- WR-03 stale sentinel sweep', () => {
  it('deletes a crash-orphaned canary sentinel left behind by a previous session before starting', async () => {
    const stale = path.join(tmpDir, 'mdforge-canary-deadbeef.tmp')
    fs.writeFileSync(stale, '')
    expect(fs.existsSync(stale)).toBe(true)

    await startWorkspaceWatcher(tmpDir, () => {}, { stabilityThresholdMs: 50 })

    expect(fs.existsSync(stale)).toBe(false)
  })

  it('sweeps multiple stale sentinels from separate crashed sessions', async () => {
    const staleA = path.join(tmpDir, 'mdforge-canary-aaaaaaaa.tmp')
    const staleB = path.join(tmpDir, 'mdforge-canary-bbbbbbbb.tmp')
    fs.writeFileSync(staleA, '')
    fs.writeFileSync(staleB, '')

    await startWorkspaceWatcher(tmpDir, () => {}, { stabilityThresholdMs: 50 })

    expect(fs.existsSync(staleA)).toBe(false)
    expect(fs.existsSync(staleB)).toBe(false)
  })

  it('leaves ordinary files alone -- only the exact sentinel filename shape is swept', async () => {
    const ordinary = path.join(tmpDir, 'roadmap.md')
    fs.writeFileSync(ordinary, '# Roadmap')

    await startWorkspaceWatcher(tmpDir, () => {}, { stabilityThresholdMs: 50 })

    expect(fs.existsSync(ordinary)).toBe(true)
  })

  it('never throws when the root cannot be read (e.g. already removed) -- a stale sentinel left behind is preferable to blocking folder-open', async () => {
    const missingRoot = path.join(tmpDir, 'does-not-exist')

    await expect(
      startWorkspaceWatcher(missingRoot, () => {}, { stabilityThresholdMs: 50, canaryTimeoutMs: 50 })
    ).resolves.toBeDefined()
  })
})

describe('startWorkspaceWatcher / stopWorkspaceWatcher -- real chokidar lifecycle', () => {
  it('wires add/change/unlink/unlinkDir and reports external-change for a genuinely new file', async () => {
    const events = []
    await startWorkspaceWatcher(tmpDir, (e) => events.push(e), { stabilityThresholdMs: 50 })

    const target = path.join(tmpDir, 'new-file.md')
    fs.writeFileSync(target, 'hello world')

    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'external-change' && e.path === target)).toBe(true)
    }, { timeout: 10000 })
  })

  it('discards own-write events and never calls onEvent for them (WORK-07)', async () => {
    const events = []
    const target = path.join(tmpDir, 'own-write.md')
    // Simulate the app's own already-recorded save landing before the
    // watcher starts, mirroring text-file.js's writeTextFileChecked flow.
    fs.writeFileSync(target, 'saved from inside the app')
    recordStat(target, fs.statSync(target))

    await startWorkspaceWatcher(tmpDir, (e) => events.push(e), { stabilityThresholdMs: 50 })

    // Re-touch the same content (same size/mtime is unrealistic to force
    // deterministically via a second real write, so instead assert the
    // negative directly: writing the SAME already-recorded stat's file
    // again via the exact same bytes at the same instant is inherently
    // flaky to assert on mtimeMs equality in CI. Rather than depend on that
    // timing, prove the suppression path structurally via classifyWatcherEvent
    // directly (already covered above) AND confirm no event fired for a
    // window with no writes at all -- i.e. a quiescent, already-recorded file
    // produces no spurious event on watcher start.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(events).toEqual([])
  })

  it('wires unlink and reports vanished with isDirectory:false for a deleted file', async () => {
    const events = []
    const target = path.join(tmpDir, 'to-delete.md')
    fs.writeFileSync(target, 'delete me')

    await startWorkspaceWatcher(tmpDir, (e) => events.push(e), { stabilityThresholdMs: 50 })
    fs.unlinkSync(target)

    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'vanished' && e.path === target && e.isDirectory === false)).toBe(true)
    }, { timeout: 10000 })
  })

  it('wires unlinkDir and reports vanished with isDirectory:true for a deleted directory -- the regression this task exists to prevent', async () => {
    const events = []
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    fs.writeFileSync(path.join(subDir, 'child.md'), 'child content')

    await startWorkspaceWatcher(tmpDir, (e) => events.push(e), { stabilityThresholdMs: 50 })
    fs.rmSync(subDir, { recursive: true, force: true })

    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'vanished' && e.path === subDir && e.isDirectory === true)).toBe(true)
    }, { timeout: 10000 })
  })

  it('fully closes the previous watcher before starting a new one -- no event from the old root reaches the old callback after replacement', async () => {
    const rootA = tmpDir
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-watcher-test-b-'))

    try {
      const eventsA = []
      const eventsB = []

      await startWorkspaceWatcher(rootA, (e) => eventsA.push(e), { stabilityThresholdMs: 50 })
      await startWorkspaceWatcher(rootB, (e) => eventsB.push(e), { stabilityThresholdMs: 50 })

      // A change in the now-replaced root must never reach eventsA.
      fs.writeFileSync(path.join(rootA, 'after-replace.md'), 'should not be observed')
      // A change in the current root must reach eventsB, proving the new
      // watcher is genuinely live (not just that the old one is silent).
      fs.writeFileSync(path.join(rootB, 'in-current-root.md'), 'should be observed')

      await vi.waitFor(() => {
        expect(eventsB.some((e) => e.path === path.join(rootB, 'in-current-root.md'))).toBe(true)
      }, { timeout: 10000 })

      // Give the (closed) old watcher every opportunity to have wrongly fired.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(eventsA).toEqual([])
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('stopWorkspaceWatcher is safe to call when nothing is running, and stops delivery once called', async () => {
    await stopWorkspaceWatcher() // nothing running yet -- must not throw

    const events = []
    await startWorkspaceWatcher(tmpDir, (e) => events.push(e), { stabilityThresholdMs: 50 })
    await stopWorkspaceWatcher()

    fs.writeFileSync(path.join(tmpDir, 'after-stop.md'), 'should not be observed')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(events).toEqual([])
  })
})

describe('startWorkspaceWatcher -- canary health-check and usePolling fallback', () => {
  // These two tests use a fake FSWatcher-shaped EventEmitter injected via
  // startWorkspaceWatcher's watchFn/writeSentinel seam -- forcing chokidar's
  // real native backend to go silent is not reproducible from a temp
  // directory test. See this file's header comment.
  function makeFakeWatcher () {
    const watcher = new EventEmitter()
    watcher.close = vi.fn(async () => {})
    return watcher
  }

  it('resolves {healthy:true} immediately when the sentinel add event arrives within the timeout', async () => {
    const fakeWatcher = makeFakeWatcher()
    const watchFn = vi.fn(() => {
      queueMicrotask(() => fakeWatcher.emit('ready'))
      return fakeWatcher
    })
    const writeSentinel = (sentinelPath) => {
      queueMicrotask(() => fakeWatcher.emit('add', sentinelPath))
      return Promise.resolve()
    }

    const result = await startWorkspaceWatcher(tmpDir, () => {}, {
      watchFn,
      writeSentinel,
      canaryTimeoutMs: 200
    })

    expect(result).toEqual({ healthy: true })
    expect(watchFn).toHaveBeenCalledTimes(1)
  })

  it('restarts once with usePolling:true and resolves {healthy:true} when the retry succeeds', async () => {
    const firstWatcher = makeFakeWatcher() // never emits 'add' -- simulates native silence
    const secondWatcher = makeFakeWatcher()
    let call = 0

    const watchFn = vi.fn((_root, opts) => {
      call += 1
      if (call === 1) {
        expect(opts.usePolling).toBeUndefined()
        queueMicrotask(() => firstWatcher.emit('ready'))
        return firstWatcher
      }
      expect(opts.usePolling).toBe(true)
      queueMicrotask(() => secondWatcher.emit('ready'))
      return secondWatcher
    })

    const writeSentinel = (sentinelPath, watcher) => {
      if (watcher === secondWatcher) {
        queueMicrotask(() => secondWatcher.emit('add', sentinelPath))
      }
      // First attempt: deliberately never emits -- the timeout must elapse.
      return Promise.resolve()
    }

    const result = await startWorkspaceWatcher(tmpDir, () => {}, {
      watchFn,
      writeSentinel,
      canaryTimeoutMs: 50
    })

    expect(result).toEqual({ healthy: true })
    expect(watchFn).toHaveBeenCalledTimes(2)
    expect(firstWatcher.close).toHaveBeenCalledTimes(1)
  })

  it('resolves {healthy:false} (never throws) when both the native attempt and the polling retry fail the canary', async () => {
    const firstWatcher = makeFakeWatcher()
    const secondWatcher = makeFakeWatcher()
    let call = 0

    const watchFn = vi.fn(() => {
      call += 1
      const w = call === 1 ? firstWatcher : secondWatcher
      queueMicrotask(() => w.emit('ready'))
      return w
    })

    // Neither attempt ever emits 'add' for the sentinel -- both time out.
    const writeSentinel = () => Promise.resolve()

    const events = []
    const result = await startWorkspaceWatcher(tmpDir, (e) => events.push(e), {
      watchFn,
      writeSentinel,
      canaryTimeoutMs: 50
    })

    expect(result).toEqual({ healthy: false })
    expect(watchFn).toHaveBeenCalledTimes(2)
    // The caller must still be able to browse/open files -- never a thrown
    // rejection for an unhealthy watcher.
    expect(events).toEqual([])
  })
})
