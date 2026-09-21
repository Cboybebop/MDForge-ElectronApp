// Regression tests for text-file.js's read/write service and mtime/size
// conflict detection (SHELL-02/03/04). Plain vitest, no jsdom -- `electron`
// is mocked (only `ipcMain.handle` is touched by this module) but every
// filesystem interaction below is real: a genuine `fs.mkdtempSync` temp
// directory, real `fs.stat`, and (for the long-path case) a real nested
// directory tree built with `fs.mkdirSync`, not a string literal.
//
// The long-path test in particular is the plan-check blocker fix: a guard
// function returning true for a >260-character string proves nothing about
// whether fs.open/fs.rename themselves succeed at that length -- only a real
// round trip through the real filesystem proves that.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { atomicWriteMock } = vi.hoisted(() => ({ atomicWriteMock: vi.fn() }))

vi.mock('./atomic-write.js', () => ({
  atomicWrite: (...args) => atomicWriteMock(...args)
}))

const realAtomicWrite = (await vi.importActual('./atomic-write.js')).atomicWrite

const { ipcMain } = await import('electron')
const {
  readTextFile,
  writeTextFileChecked,
  registerTextFileIpc,
  recordStat,
  getRecordedStat
} = await import('./text-file.js')

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-file-test-'))
  // Default: delegate to the real atomicWrite, so tests that don't override
  // it still perform a genuine write. Only the rejection test below overrides
  // this to inject a failure.
  atomicWriteMock.mockImplementation((...args) => realAtomicWrite(...args))
})

afterEach(() => {
  vi.clearAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Builds a REAL absolute path exceeding 260 characters by creating a real
 * chain of nested ~30-character-named subdirectories under a temp dir,
 * 10+ levels deep, and returns the path to a `.md` file at the bottom. This
 * exercises actual Node/libuv/Win32 path-length behaviour on the executing
 * machine (including any silent `\\?\` long-path-prefix requirement) --
 * something `isSafeFilePath`'s pure string check can never expose, since it
 * never touches the filesystem.
 */
function buildRealLongPath (baseDir) {
  const segment = 'a'.repeat(30)
  let dir = baseDir
  let levels = 0
  while (path.join(dir, 'notes.md').length <= 260 || levels < 10) {
    dir = path.join(dir, segment)
    levels++
  }
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'notes.md')
}

describe('readTextFile -- real filesystem', () => {
  it('reads a real temp file and returns {path, text, name, mtimeMs, size} matching real stat', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, '# Hello\n')
    const realStat = fs.statSync(target)

    const result = await readTextFile(target)

    expect(result.error).toBeUndefined()
    expect(result.path).toBe(target)
    expect(result.text).toBe('# Hello\n')
    expect(result.name).toBe('notes.md')
    expect(result.mtimeMs).toBe(realStat.mtimeMs)
    expect(result.size).toBe(realStat.size)
  })

  it('records the stat internally so a later writeTextFileChecked can detect a conflict', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'v1')

    await readTextFile(target)

    expect(getRecordedStat(target)).toMatchObject({ size: 2 })
  })

  it('rejects a path isSafeFilePath rejects, without ever calling fs.stat/fs.readFile', async () => {
    const statSpy = vi.spyOn(fs.promises, 'stat')
    const readFileSpy = vi.spyOn(fs.promises, 'readFile')

    const result = await readTextFile('C:\\a\\..\\..\\b.md')

    expect(result.error).toEqual({ message: expect.any(String), code: 'EINVALIDPATH' })
    expect(statSpy).not.toHaveBeenCalled()
    expect(readFileSpy).not.toHaveBeenCalled()

    statSpy.mockRestore()
    readFileSpy.mockRestore()
  })

  it('returns an ENOTAFILE error for a path pointing at a directory', async () => {
    const result = await readTextFile(tmpDir)
    expect(result.error).toEqual({ message: 'Not a file', code: 'ENOTAFILE' })
  })

  it('returns a structured error (never throws) for a nonexistent file', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.md')
    const result = await readTextFile(missing)
    expect(result.error).toMatchObject({ code: 'ENOENT' })
  })
})

describe('writeTextFileChecked -- no prior recorded stat', () => {
  it('writes immediately via atomicWrite and returns {ok:true, mtimeMs, size}', async () => {
    const target = path.join(tmpDir, 'notes.md')

    const result = await writeTextFileChecked(target, 'fresh content', false)

    expect(result.ok).toBe(true)
    expect(result.conflict).toBeUndefined()
    expect(typeof result.mtimeMs).toBe('number')
    expect(typeof result.size).toBe('number')
    expect(fs.readFileSync(target, 'utf8')).toBe('fresh content')
    expect(atomicWriteMock).toHaveBeenCalledTimes(1)
  })
})

describe('writeTextFileChecked -- conflict detection against a real mtime/size mismatch', () => {
  it('does NOT write when the file changed on disk since the recorded stat, and the original is left untouched', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'original')
    await readTextFile(target) // records the original stat

    // Simulate an external change (a different editor, git pull, OneDrive
    // sync) landing a different mtime AND size on the same path.
    await new Promise((resolve) => setTimeout(resolve, 10))
    fs.writeFileSync(target, 'externally changed, much longer content')

    const result = await writeTextFileChecked(target, 'my in-memory content', false)

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.actual).toMatchObject({ size: expect.any(Number), mtimeMs: expect.any(Number) })
    expect(atomicWriteMock).not.toHaveBeenCalled()
    // The externally-changed content must be provably untouched by the
    // rejected write attempt.
    expect(fs.readFileSync(target, 'utf8')).toBe('externally changed, much longer content')
  })

  it('treats a file deleted since open as a conflict rather than silently recreating it', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'original')
    await readTextFile(target)
    fs.unlinkSync(target)

    const result = await writeTextFileChecked(target, 'new content', false)

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.actual).toBeNull()
    expect(atomicWriteMock).not.toHaveBeenCalled()
    expect(fs.existsSync(target)).toBe(false)
  })

  it('force:true bypasses a real mismatch and writes anyway', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'original')
    await readTextFile(target)

    await new Promise((resolve) => setTimeout(resolve, 10))
    fs.writeFileSync(target, 'externally changed')

    const result = await writeTextFileChecked(target, 'forced overwrite', true)

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('forced overwrite')
  })

  it('writing successfully after a conflict-free check updates the recorded stat for the next comparison', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'v1')
    await readTextFile(target)

    const result = await writeTextFileChecked(target, 'v2', false)
    expect(result.ok).toBe(true)

    // A second checked write against the now-current stat must succeed
    // without a conflict, proving recordStat was updated after the save.
    const second = await writeTextFileChecked(target, 'v3', false)
    expect(second.ok).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('v3')
  })
})

describe('writeTextFileChecked -- WR-02: narrowed TOCTOU via a precheck immediately before rename', () => {
  it('passes atomicWrite a precheck when a recorded stat exists, and omits it when force:true or nothing was recorded', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'v1')
    await readTextFile(target)

    await writeTextFileChecked(target, 'v2', false)
    let options = atomicWriteMock.mock.calls[0][2]
    expect(typeof options.precheck).toBe('function')

    atomicWriteMock.mockClear()
    const neverOpened = path.join(tmpDir, 'never-opened.md')
    await writeTextFileChecked(neverOpened, 'fresh', false)
    options = atomicWriteMock.mock.calls[0][2]
    expect(options.precheck).toBeUndefined()

    atomicWriteMock.mockClear()
    await writeTextFileChecked(target, 'forced', true)
    options = atomicWriteMock.mock.calls[0][2]
    expect(options.precheck).toBeUndefined()
  })

  it('detects an external change that lands AFTER the initial check but before the rename, and does not overwrite it', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'original')
    await readTextFile(target) // records the original stat

    // Simulates atomicWrite's real internal sequence: by the time it is
    // ready to rename (temp written + fsynced), it calls the precheck
    // text-file.js supplied. This mock mutates the target on disk to
    // simulate an external process (OneDrive, git, another editor) landing
    // a change in the narrow post-check window, THEN invokes the precheck --
    // exactly mirroring atomicWrite's own call order (see the "invoked
    // AFTER write/fsync, BEFORE rename" test in atomic-write.test.js).
    // Before the WR-02 fix, writeTextFileChecked passed no precheck at all,
    // so this same sequence would have silently overwritten the raced
    // change; this test fails against that pre-fix behaviour.
    atomicWriteMock.mockImplementation(async (filePath, content, options) => {
      fs.writeFileSync(filePath, 'raced external change, landed after the initial check')
      if (options && typeof options.precheck === 'function') {
        const conflict = await options.precheck()
        if (conflict) {
          const err = new Error('Write aborted: target changed on disk immediately before rename')
          err.code = 'ECONFLICT'
          err.conflict = conflict
          throw err
        }
      }
      return realAtomicWrite(filePath, content)
    })

    const result = await writeTextFileChecked(target, 'my in-memory content', false)

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.actual).toMatchObject({ size: expect.any(Number) })
    expect(fs.readFileSync(target, 'utf8')).toBe('raced external change, landed after the initial check')
  })
})

describe('writeTextFileChecked -- atomicWrite rejection', () => {
  it('returns {ok:false, conflict:false, error} on an atomicWrite failure, never throws', async () => {
    const err = new Error('Could not save: locked by another process (EBUSY)')
    err.code = 'EBUSY'
    atomicWriteMock.mockRejectedValueOnce(err)

    const target = path.join(tmpDir, 'notes.md')
    const result = await writeTextFileChecked(target, 'content', false)

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(false)
    expect(result.error).toEqual({ message: err.message, code: 'EBUSY' })
  })
})

describe('writeTextFileChecked / readTextFile -- real path exceeding 260 characters', () => {
  it('round-trips a real >260-character path byte-identical through write then read', async () => {
    const longPath = buildRealLongPath(tmpDir)
    expect(longPath.length).toBeGreaterThan(260)

    const content = '# Long path round trip\n\nThis file lives more than 260 characters deep.\n'

    const writeResult = await writeTextFileChecked(longPath, content, false)
    expect(writeResult.ok).toBe(true)

    const readResult = await readTextFile(longPath)
    expect(readResult.error).toBeUndefined()
    expect(readResult.text).toBe(content)
  })
})

describe('registerTextFileIpc', () => {
  it('registers file:open-path and file:save handlers', () => {
    registerTextFileIpc()

    const registeredChannels = ipcMain.handle.mock.calls.map(([channel]) => channel)
    expect(registeredChannels).toContain('file:open-path')
    expect(registeredChannels).toContain('file:save')
  })
})

describe('recordStat / getRecordedStat', () => {
  it('never exports the underlying Map -- only getter/setter functions', () => {
    recordStat('/some/path.md', { mtimeMs: 123, size: 456 })
    expect(getRecordedStat('/some/path.md')).toEqual({ mtimeMs: 123, size: 456 })
    expect(getRecordedStat('/never/recorded.md')).toBeUndefined()
  })
})
