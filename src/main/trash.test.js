// Regression tests for the one delete path (WORK-03, criterion 2): every
// workspace delete goes through shell.trashItem, never fs.unlink/fs.rm.
// Mirrors dialogs.test.js's mocked-`electron` shape -- only `shell.trashItem`
// is touched by this module, so only it needs mocking.
//
// process.platform is temporarily overridden per-test (Object.defineProperty,
// restored in afterEach) since trashWorkspaceFile's backslash normalization
// is platform-conditional and this suite must prove both branches
// deterministically regardless of the host OS running the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { trashItemMock } = vi.hoisted(() => ({
  trashItemMock: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { trashItem: (...args) => trashItemMock(...args) }
}))

const { trashWorkspaceFile } = await import('./trash.js')

const originalPlatform = process.platform

function setPlatform (value) {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  trashItemMock.mockReset()
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('trashWorkspaceFile -- WORK-03 criterion 2: Recycle Bin, never fs.unlink', () => {
  it('calls shell.trashItem with the backslash path unchanged on Windows', async () => {
    setPlatform('win32')
    trashItemMock.mockResolvedValueOnce(undefined)

    const result = await trashWorkspaceFile('C:\\notes\\a.md')

    expect(trashItemMock).toHaveBeenCalledTimes(1)
    expect(trashItemMock).toHaveBeenCalledWith('C:\\notes\\a.md')
    expect(result).toEqual({ ok: true })
  })

  it('normalizes forward slashes to backslashes on Windows before calling shell.trashItem', async () => {
    setPlatform('win32')
    trashItemMock.mockResolvedValueOnce(undefined)

    const result = await trashWorkspaceFile('C:/notes/a.md')

    expect(trashItemMock).toHaveBeenCalledTimes(1)
    expect(trashItemMock).toHaveBeenCalledWith('C:\\notes\\a.md')
    expect(result).toEqual({ ok: true })
  })

  it('never calls shell.trashItem for a traversal path, and returns EINVALIDPATH', async () => {
    setPlatform('win32')

    const result = await trashWorkspaceFile('C:\\notes\\..\\..\\evil.md')

    expect(trashItemMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDPATH')
  })

  it('never calls shell.trashItem for a non-string path, and returns EINVALIDPATH', async () => {
    setPlatform('win32')

    const result = await trashWorkspaceFile(null)

    expect(trashItemMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EINVALIDPATH')
  })

  it('returns a structured error, never throws, when shell.trashItem rejects', async () => {
    setPlatform('win32')
    const rejection = new Error('Permission denied')
    rejection.code = 'EPERM'
    trashItemMock.mockRejectedValueOnce(rejection)

    const result = await trashWorkspaceFile('C:\\notes\\a.md')

    expect(result.ok).toBe(false)
    expect(result.error.message).toBe('Permission denied')
    expect(result.error.code).toBe('EPERM')
  })

  it('does not touch separators on a non-Windows platform', async () => {
    setPlatform('linux')
    trashItemMock.mockResolvedValueOnce(undefined)

    const result = await trashWorkspaceFile('/home/user/notes/a.md')

    expect(trashItemMock).toHaveBeenCalledTimes(1)
    expect(trashItemMock).toHaveBeenCalledWith('/home/user/notes/a.md')
    expect(result).toEqual({ ok: true })
  })
})
