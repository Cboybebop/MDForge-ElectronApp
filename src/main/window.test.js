// Regression test for WR-01 (06-REVIEW.md): the show-gate's own fallback
// setTimeout must never call an almost-any BrowserWindow method (including
// .show()) on a window the user has already closed/destroyed by the time
// the timer fires -- Electron throws "Object has been destroyed" for
// exactly that. `electron` is mocked with a minimal, real EventEmitter-
// backed fake BrowserWindow (mirrors export.test.js's own
// "instrument the constructor, fake just enough of the API" idiom), so
// `win.once('ready-to-show', ...)`/`win.once('closed', ...)` behave like
// the real thing without needing a real Electron process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// No external import inside the factory below -- vi.mock() factories are
// hoisted above this file's own top-level imports, so a module-level
// `import { EventEmitter } from 'node:events'` would not yet be
// initialized when the factory runs. A tiny hand-rolled once()/emit() is
// all this test actually needs.
vi.mock('electron', () => {
  class FakeBrowserWindow {
    constructor (options) {
      this.destroyed = false
      this.shown = false
      this._onceListeners = {}
      // WR-01 (10-02-PLAN.md Task 3 extension): captures the constructor's
      // options argument so the dev-mode icon test below can inspect it,
      // without changing any existing test's behavior.
      this.options = options
      // PERS-05 (11-02-PLAN.md Task 2): records show()/maximize() call
      // order so a unit test can lock in "show, then maximize" as a fast,
      // deterministic, real-Electron-independent regression guard --
      // the real fake previously could not distinguish "maximized before
      // show" from "maximized after show" at all (maximize() was a no-op).
      this.callOrder = []
    }

    once (event, cb) {
      (this._onceListeners[event] ||= []).push(cb)
    }

    on () {
      // window.js's own 'page-title-updated' listener -- never fired by
      // this test, no behaviour needed.
    }

    show () {
      if (this.destroyed) throw new Error('Object has been destroyed')
      this.shown = true
      this.callOrder.push('show')
    }

    maximize () {
      this.callOrder.push('maximize')
    }

    setTitle () {}
    loadURL () {}
    isDestroyed () {
      return this.destroyed
    }

    // Test-only helper: simulates the user closing the window before the
    // show-gate's fallback timer fires.
    __destroy () {
      this.destroyed = true
      for (const cb of this._onceListeners.closed || []) cb()
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { once: vi.fn(), on: vi.fn() }
  }
})

describe('createWindow -- WR-01: the show-gate fallback timer', () => {
  let createWindow

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    ;({ createWindow } = await import('./window.js'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not throw when the fallback timer fires on a window the user already closed', () => {
    const win = createWindow()

    win.__destroy()

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
  })

  it('clears the fallback timer on close -- it never fires win.show() on a destroyed window', () => {
    const win = createWindow()
    const showSpy = vi.spyOn(win, 'show')

    win.__destroy()
    vi.advanceTimersByTime(5000)

    expect(showSpy).not.toHaveBeenCalled()
  })

  it('still shows the window via the fallback timer when it was never closed', () => {
    const win = createWindow()

    vi.advanceTimersByTime(5000)

    expect(win.shown).toBe(true)
  })

  // [WR-02, 11-REVIEW.md] Locks in the fix: previously this fallback called
  // win.show() directly, bypassing maybeShow() entirely and silently
  // dropping the maximize() call whenever one of the two normal gate
  // signals ('ready-to-show' / the renderer's own 'app:restore-complete')
  // never fired at all. Deliberately never fires either signal here, to
  // exercise exactly that "stuck" scenario.
  it('still maximizes via the fallback timer when the restored session was maximized but a gate signal never fired', () => {
    const win = createWindow(undefined, { maximized: true })

    vi.advanceTimersByTime(5000)

    expect(win.callOrder).toEqual(['show', 'maximize'])
  })

  it('does not maximize via the fallback timer when the restored session was not maximized', () => {
    const win = createWindow(undefined, { maximized: false })

    vi.advanceTimersByTime(5000)

    expect(win.callOrder).toEqual(['show'])
  })
})

describe('createWindow -- BRAND-01 (10-02-PLAN.md Task 3): dev-mode-only window icon', () => {
  let createWindow
  // Reset to the ORIGINAL value (not just delete), since this env var is
  // also read by other dev-mode-gated code in this codebase (e.g.
  // src/main/index.js's SHELL-10 diagnostic) -- this test must not leak
  // state into any other test file in the same vitest run.
  const ORIGINAL_ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL

  beforeEach(async () => {
    vi.resetModules()
    ;({ createWindow } = await import('./window.js'))
  })

  afterEach(() => {
    if (ORIGINAL_ELECTRON_RENDERER_URL === undefined) {
      delete process.env.ELECTRON_RENDERER_URL
    } else {
      process.env.ELECTRON_RENDERER_URL = ORIGINAL_ELECTRON_RENDERER_URL
    }
  })

  it('passes an icon option ending in build/icon.ico when ELECTRON_RENDERER_URL is set (dev mode)', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'

    const win = createWindow()

    expect(win.options.icon).toMatch(/build[\\/]icon\.ico$/)
  })

  it('passes no icon option when ELECTRON_RENDERER_URL is unset (packaged/e2e)', () => {
    delete process.env.ELECTRON_RENDERER_URL

    const win = createWindow()

    expect(win.options.icon).toBeUndefined()
  })
})

describe('createWindow -- PERS-05: maximize() sequencing', () => {
  let createWindow

  beforeEach(async () => {
    vi.resetModules()
    ;({ createWindow } = await import('./window.js'))
  })

  // Locks in the 4th sequencing variant (window.js's maybeShow(), 11-02):
  // once both two-signal-gate signals have fired, win.show() must be called
  // BEFORE win.maximize() -- a direct synchronous continuation of this
  // app's own show() call, not a reaction to Electron's own 'show' event
  // (already tried and already failed per STATE.md). This is a fast,
  // deterministic, real-Electron-independent regression guard on the
  // ORDERING intent; it cannot prove what real Windows does with that
  // ordering (11-02-PLAN.md Task 3 owns that, against a real build).
  it('calls show() then maximize(), in that order, once both show-gate signals have fired', async () => {
    const { ipcMain } = await import('electron')

    const win = createWindow(undefined, { maximized: true })

    // Mirrors the WR-01 tests' own idiom for driving this fake: fire the
    // 'ready-to-show' once-listener directly...
    for (const cb of win._onceListeners['ready-to-show'] || []) cb()

    // ...and the mocked ipcMain.once('app:restore-complete', ...) callback,
    // captured from the fake's recorded call rather than invoked
    // automatically (the mock is a bare vi.fn(), it does not self-fire).
    // The mocked ipcMain instance is shared across this whole test file
    // (vi.resetModules() does not recreate it), so ipcMain.once.mock.calls
    // accumulates one 'app:restore-complete' registration per createWindow()
    // call made anywhere in this file. This test's OWN registration is
    // always the most recently pushed entry -- take the LAST match, not the
    // first (which would belong to an earlier test's window closure).
    const restoreCompleteCalls = ipcMain.once.mock.calls.filter(
      ([event]) => event === 'app:restore-complete'
    )
    restoreCompleteCalls.at(-1)[1]()

    expect(win.callOrder).toEqual(['show', 'maximize'])
  })

  it('never calls maximize() when the restored session was not maximized', async () => {
    const { ipcMain } = await import('electron')

    const win = createWindow(undefined, { maximized: false })

    for (const cb of win._onceListeners['ready-to-show'] || []) cb()
    const restoreCompleteCalls = ipcMain.once.mock.calls.filter(
      ([event]) => event === 'app:restore-complete'
    )
    restoreCompleteCalls.at(-1)[1]()

    expect(win.callOrder).toEqual(['show'])
  })
})
