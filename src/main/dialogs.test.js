// Regression tests for native dialogs + reveal-in-Explorer (SHELL-02,
// SHELL-09). Plain vitest, no jsdom -- `electron` is mocked (only
// dialog.showSaveDialog/showOpenDialog, shell.showItemInFolder, and
// ipcMain.handle are touched by this module), but text-file.js's real
// read/write functions run against a genuine `fs.mkdtempSync` temp
// directory, matching text-file.test.js's own established shape.
//
// ipcMain.handle is captured into a map keyed by channel so each handler can
// be invoked directly with (event, ...args), the same way registerTextFileIpc
// is proven registered in text-file.test.js, but going one step further to
// actually exercise the handler bodies.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { showSaveDialogMock, showOpenDialogMock, showItemInFolderMock, showMessageBoxMock } = vi.hoisted(() => ({
  showSaveDialogMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  showMessageBoxMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {
    showSaveDialog: (...args) => showSaveDialogMock(...args),
    showOpenDialog: (...args) => showOpenDialogMock(...args),
    showMessageBox: (...args) => showMessageBoxMock(...args)
  },
  shell: { showItemInFolder: (...args) => showItemInFolderMock(...args) }
}))

const { ipcMain } = await import('electron')
const { registerDialogsIpc } = await import('./dialogs.js')
const { readTextFile } = await import('./text-file.js')

function getHandler (channel) {
  const call = ipcMain.handle.mock.calls.find(([ch]) => ch === channel)
  return call && call[1]
}

function mockSaveDialog (filePath) {
  showSaveDialogMock.mockResolvedValueOnce({ canceled: false, filePath })
}

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogs-test-'))
  registerDialogsIpc({})
})

afterEach(() => {
  vi.clearAllMocks()
  ipcMain.handle.mockClear()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('shell:reveal-in-explorer -- WR-02.03: path re-validated via isSafeFilePath', () => {
  it('calls shell.showItemInFolder for a safe path', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'content')

    const handler = getHandler('shell:reveal-in-explorer')
    await handler(null, target)

    expect(showItemInFolderMock).toHaveBeenCalledTimes(1)
    expect(showItemInFolderMock).toHaveBeenCalledWith(target)
  })

  it('never calls shell.showItemInFolder for a path isSafeFilePath rejects (traversal)', async () => {
    const handler = getHandler('shell:reveal-in-explorer')
    await handler(null, 'C:\\a\\..\\..\\b.md')

    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })

  it('never calls shell.showItemInFolder for a non-string value', async () => {
    const handler = getHandler('shell:reveal-in-explorer')
    await handler(null, null)
    await handler(null, undefined)
    await handler(null, 42)

    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })
})

describe('dialog:save-file-as -- WR-05: force:true must not skip a real conflict for a path recorded earlier in this session', () => {
  it('force-writes immediately when the chosen path has never been recorded (genuinely novel destination)', async () => {
    const target = path.join(tmpDir, 'brand-new.md')
    fs.writeFileSync(target, 'pre-existing content nobody in this process has ever read/recorded')
    mockSaveDialog(target)

    const handler = getHandler('dialog:save-file-as')
    const result = await handler(null, 'my new content')

    expect(result.error).toBeUndefined()
    expect(result.conflict).toBeUndefined()
    expect(result.path).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('my new content')
  })

  it('does NOT force through a real conflict when the chosen path has a recorded stat from earlier in the session', async () => {
    const target = path.join(tmpDir, 'reused.md')
    fs.writeFileSync(target, 'v1')
    await readTextFile(target) // records target's stat, as an earlier open/save in this session would

    // Simulate an external change (git checkout, OneDrive sync, another
    // editor) landing after that recording.
    await new Promise((resolve) => setTimeout(resolve, 10))
    fs.writeFileSync(target, 'externally changed after being recorded')

    mockSaveDialog(target)
    const handler = getHandler('dialog:save-file-as')
    const result = await handler(null, 'my in-memory content, chosen via Save As')

    expect(result.conflict).toBe(true)
    expect(result.path).toBe(target)
    expect(result.actual).toMatchObject({ size: expect.any(Number) })
    // The externally-changed content must be provably untouched.
    expect(fs.readFileSync(target, 'utf8')).toBe('externally changed after being recorded')
  })

  it('writes normally (no conflict) when the recorded stat still matches the on-disk state', async () => {
    const target = path.join(tmpDir, 'reused-unchanged.md')
    fs.writeFileSync(target, 'v1')
    await readTextFile(target)

    mockSaveDialog(target)
    const handler = getHandler('dialog:save-file-as')
    const result = await handler(null, 'v2 via save as')

    expect(result.conflict).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(result.path).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('v2 via save as')
  })
})

describe('dialog:save-file-as -- 07-09: suggestedName threads through as defaultPath', () => {
  it('passes defaultPath through when a suggestedName is supplied', async () => {
    const target = path.join(tmpDir, 'copy-target.md')
    mockSaveDialog(target)

    const handler = getHandler('dialog:save-file-as')
    await handler(null, 'content', 'roadmap (copy).md')

    const options = showSaveDialogMock.mock.calls[0][1]
    expect(options.defaultPath).toBe('roadmap (copy).md')
  })

  it('omits defaultPath entirely when no suggestedName is supplied (unchanged pre-existing behavior)', async () => {
    const target = path.join(tmpDir, 'no-hint.md')
    mockSaveDialog(target)

    const handler = getHandler('dialog:save-file-as')
    await handler(null, 'content')

    const options = showSaveDialogMock.mock.calls[0][1]
    expect(options).not.toHaveProperty('defaultPath')
  })

  it('omits defaultPath for a non-string or empty suggestedName rather than passing it through unsafely', async () => {
    const target = path.join(tmpDir, 'no-hint-2.md')
    mockSaveDialog(target)

    const handler = getHandler('dialog:save-file-as')
    await handler(null, 'content', '')

    const options = showSaveDialogMock.mock.calls[0][1]
    expect(options).not.toHaveProperty('defaultPath')
  })
})

describe('workspace:acknowledge-external-change -- 07-09: advances the recorded-stat baseline without touching content', () => {
  it('re-records the stat and returns {ok:true} for an existing file', async () => {
    const target = path.join(tmpDir, 'ack-me.md')
    fs.writeFileSync(target, 'external content')

    const handler = getHandler('workspace:acknowledge-external-change')
    const result = await handler(null, target)

    expect(result).toEqual({ ok: true })
    // Content on disk is provably untouched -- this handler never reads
    // or writes it, only re-stats it.
    expect(fs.readFileSync(target, 'utf8')).toBe('external content')
  })

  it('returns a structured error, never throws, when the path does not exist', async () => {
    const target = path.join(tmpDir, 'does-not-exist.md')

    const handler = getHandler('workspace:acknowledge-external-change')
    const result = await handler(null, target)

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('ENOENT')
  })

  it('rejects an unsafe path without touching the filesystem', async () => {
    const handler = getHandler('workspace:acknowledge-external-change')
    const result = await handler(null, 'C:\\a\\..\\..\\b.md')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDPATH')
  })
})

describe('dialog:confirm-close-tab -- 05-12: single-tab close prompt (DOC-04 derived requirement)', () => {
  it('shows the exact Save/Don\'t Save/Cancel dialog and maps each button index correctly', async () => {
    const handler = getHandler('dialog:confirm-close-tab')

    showMessageBoxMock.mockResolvedValueOnce({ response: 0 })
    expect(await handler(null, 'roadmap.md')).toBe('save')

    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    expect(await handler(null, 'roadmap.md')).toBe('dont-save')

    showMessageBoxMock.mockResolvedValueOnce({ response: 2 })
    expect(await handler(null, 'roadmap.md')).toBe('cancel')

    expect(showMessageBoxMock).toHaveBeenCalledTimes(3)
    const options = showMessageBoxMock.mock.calls[0][1]
    expect(options.buttons).toEqual(['Save', "Don't Save", 'Cancel'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(2)
    expect(options.noLink).toBe(true)
    expect(options.message).toBe('Save changes to roadmap.md before closing?')
  })

  it('coerces a non-string docName to a safe string rather than trusting the renderer payload', async () => {
    const handler = getHandler('dialog:confirm-close-tab')
    showMessageBoxMock.mockResolvedValueOnce({ response: 2 })

    await expect(handler(null, 42)).resolves.toBe('cancel')
    const options = showMessageBoxMock.mock.calls[0][1]
    expect(options.message).toContain('42')
  })

  it('coerces a null/undefined docName without throwing', async () => {
    const handler = getHandler('dialog:confirm-close-tab')

    showMessageBoxMock.mockResolvedValueOnce({ response: 2 })
    await expect(handler(null, null)).resolves.toBe('cancel')

    showMessageBoxMock.mockResolvedValueOnce({ response: 2 })
    await expect(handler(null, undefined)).resolves.toBe('cancel')
  })
})
