// Regression tests for the create/rename/delete file-operations surface
// (WORK-03). Mirrors dialogs.test.js's mocked-`electron` shape; real fs
// operations run against a genuine fs.mkdtempSync temp directory, matching
// drafts-store.js's own test shape. trash.js's real trashWorkspaceFile is
// exercised through a mocked `electron.shell.trashItem` (same mock as
// trash.test.js) so deleteWorkspaceEntry's delegation is proven end to end,
// not re-mocked at the module boundary.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { trashItemMock } = vi.hoisted(() => ({
  trashItemMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { trashItem: (...args) => trashItemMock(...args) }
}))

const { ipcMain } = await import('electron')
const {
  isSafeFileName,
  createWorkspaceFile,
  renameWorkspaceEntry,
  deleteWorkspaceEntry,
  registerWorkspaceFileopsIpc
} = await import('./workspace-fileops.js')

function getHandler (channel) {
  const call = ipcMain.handle.mock.calls.find(([ch]) => ch === channel)
  return call && call[1]
}

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-fileops-test-'))
  trashItemMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
  ipcMain.handle.mockClear()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('isSafeFileName -- WORK-03 bare-filename validator (07-RESEARCH.md Pitfall 6)', () => {
  it('accepts an ordinary filename', () => {
    expect(isSafeFileName('roadmap.md')).toBe(true)
  })

  it('rejects empty, path-separator-bearing, and non-string input', () => {
    expect(isSafeFileName('')).toBe(false)
    expect(isSafeFileName('a/b.md')).toBe(false)
    expect(isSafeFileName('a\\b.md')).toBe(false)
    expect(isSafeFileName(null)).toBe(false)
    expect(isSafeFileName(undefined)).toBe(false)
    expect(isSafeFileName(42)).toBe(false)
  })

  it('rejects NTFS-reserved device names case-insensitively, with or without extension', () => {
    expect(isSafeFileName('CON.md')).toBe(false)
    expect(isSafeFileName('con')).toBe(false)
    expect(isSafeFileName('Con.md')).toBe(false)
    expect(isSafeFileName('lpt9.md')).toBe(false)
    expect(isSafeFileName('COM1')).toBe(false)
    expect(isSafeFileName('PRN.markdown')).toBe(false)
    expect(isSafeFileName('AUX.md')).toBe(false)
    expect(isSafeFileName('NUL.md')).toBe(false)
  })

  it('rejects illegal characters and trailing space/period', () => {
    expect(isSafeFileName('file<>.md')).toBe(false)
    expect(isSafeFileName('trailing.md ')).toBe(false)
    expect(isSafeFileName('trailing.md.')).toBe(false)
    expect(isSafeFileName('bad:name.md')).toBe(false)
    expect(isSafeFileName('bad|name.md')).toBe(false)
    expect(isSafeFileName('bad?name.md')).toBe(false)
    expect(isSafeFileName('bad*name.md')).toBe(false)
    expect(isSafeFileName('bad"name.md')).toBe(false)
  })
})

describe('createWorkspaceFile -- create, EEXISTS, EINVALIDNAME/EINVALIDPATH', () => {
  it('writes an empty file via atomicWrite and returns {ok:true, path}', async () => {
    const result = await createWorkspaceFile(tmpDir, 'new.md')

    expect(result.ok).toBe(true)
    expect(result.path).toBe(path.join(tmpDir, 'new.md'))
    expect(fs.readFileSync(result.path, 'utf8')).toBe('')
  })

  it('refuses to overwrite an existing entry, returns EEXISTS', async () => {
    const existing = path.join(tmpDir, 'existing.md')
    fs.writeFileSync(existing, 'original content')

    const result = await createWorkspaceFile(tmpDir, 'existing.md')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EEXISTS')
    expect(fs.readFileSync(existing, 'utf8')).toBe('original content')
  })

  it('rejects an NTFS-reserved bare name before any filesystem write, returns EINVALIDNAME', async () => {
    const result = await createWorkspaceFile(tmpDir, 'CON.md')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDNAME')
    expect(fs.existsSync(path.join(tmpDir, 'CON.md'))).toBe(false)
  })

  it('rejects an unsafe parent path, returns EINVALIDPATH', async () => {
    // Built via string concatenation, not path.join -- path.join normalizes
    // '..' segments away before isSafeFilePath ever sees them (07-01's own
    // established precedent for testing this guard).
    const result = await createWorkspaceFile(tmpDir + '\\..\\..\\evil', 'new.md')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDPATH')
  })
})

describe('renameWorkspaceEntry -- rename, EEXISTS collision, validation', () => {
  it('renames the entry and returns {ok:true, path}', async () => {
    const oldPath = path.join(tmpDir, 'old-name.md')
    fs.writeFileSync(oldPath, 'content')

    const result = await renameWorkspaceEntry(oldPath, 'new-name.md')

    expect(result.ok).toBe(true)
    expect(result.path).toBe(path.join(tmpDir, 'new-name.md'))
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(fs.readFileSync(result.path, 'utf8')).toBe('content')
  })

  it('refuses to rename onto an existing different entry, returns EEXISTS', async () => {
    const oldPath = path.join(tmpDir, 'old-name.md')
    const collidingPath = path.join(tmpDir, 'taken.md')
    fs.writeFileSync(oldPath, 'content')
    fs.writeFileSync(collidingPath, 'taken content')

    const result = await renameWorkspaceEntry(oldPath, 'taken.md')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EEXISTS')
    expect(fs.readFileSync(collidingPath, 'utf8')).toBe('taken content')
  })

  it('rejects an NTFS-reserved new name, returns EINVALIDNAME', async () => {
    const oldPath = path.join(tmpDir, 'old-name.md')
    fs.writeFileSync(oldPath, 'content')

    const result = await renameWorkspaceEntry(oldPath, 'CON.md')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDNAME')
    expect(fs.existsSync(oldPath)).toBe(true)
  })
})

describe('deleteWorkspaceEntry -- delegates to trashWorkspaceFile, never fs.unlink/fs.rm', () => {
  it('calls shell.trashItem (via trash.js) and returns {ok:true}', async () => {
    const target = path.join(tmpDir, 'to-delete.md')
    fs.writeFileSync(target, 'content')
    trashItemMock.mockResolvedValueOnce(undefined)

    const result = await deleteWorkspaceEntry(target)

    expect(trashItemMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
  })

  it('rejects an unsafe path before ever calling shell.trashItem', async () => {
    // Built via string concatenation, not path.join -- see the analogous
    // note in createWorkspaceFile's EINVALIDPATH test above.
    const result = await deleteWorkspaceEntry(tmpDir + '\\..\\..\\evil.md')

    expect(trashItemMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDPATH')
  })
})

describe('registerWorkspaceFileopsIpc -- IPC registration surface', () => {
  it('registers workspace:create-file and workspace:rename handlers', () => {
    registerWorkspaceFileopsIpc()

    expect(getHandler('workspace:create-file')).toBeTypeOf('function')
    expect(getHandler('workspace:rename')).toBeTypeOf('function')
  })

  it('workspace:create-file handler creates a file through the same validated path', async () => {
    registerWorkspaceFileopsIpc()
    const handler = getHandler('workspace:create-file')

    const result = await handler(null, tmpDir, 'via-ipc.md')

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'via-ipc.md'))).toBe(true)
  })
})
