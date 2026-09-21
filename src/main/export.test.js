// Regression test for IN-02 (04-REVIEW.md): exportPdf/exportHtml must
// re-validate the dialog-chosen path via isSafeFilePath before doing any
// work, for consistency with dialogs.js/text-file.js's own stated
// "regardless of caller" defense-in-depth policy. Plain vitest, no jsdom --
// `electron` is mocked; BrowserWindow's constructor is instrumented to
// prove it is never even called when the path is rejected, so exportPdf's
// early-return happens before any hidden-window work begins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { showSaveDialogMock, browserWindowCtorMock, atomicWriteMock } = vi.hoisted(() => ({
  showSaveDialogMock: vi.fn(),
  browserWindowCtorMock: vi.fn(),
  atomicWriteMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: (...args) => showSaveDialogMock(...args) },
  BrowserWindow: class {
    constructor (...args) {
      browserWindowCtorMock(...args)
    }
  }
}))

vi.mock('./atomic-write.js', () => ({
  atomicWrite: (...args) => atomicWriteMock(...args)
}))

const { exportPdf, exportHtml } = await import('./export.js')

beforeEach(() => {
  showSaveDialogMock.mockReset()
  browserWindowCtorMock.mockReset()
  atomicWriteMock.mockReset()
  atomicWriteMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('exportHtml -- IN-02: re-validates the dialog-chosen path via isSafeFilePath', () => {
  it('returns a structured error and never calls atomicWrite for a traversal path', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\a\\..\\..\\b.html' })

    const result = await exportHtml({}, '<html></html>')

    expect(result.error).toMatchObject({ code: 'EINVALIDPATH' })
    expect(atomicWriteMock).not.toHaveBeenCalled()
  })

  it('writes normally for a safe path', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Users\\me\\out.html' })

    const result = await exportHtml({}, '<html></html>')

    expect(result.error).toBeUndefined()
    expect(result.path).toBe('C:\\Users\\me\\out.html')
    expect(atomicWriteMock).toHaveBeenCalledTimes(1)
  })
})

describe('exportPdf -- IN-02: re-validates the dialog-chosen path via isSafeFilePath', () => {
  it('returns a structured error and never even constructs the hidden export BrowserWindow for a traversal path', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\a\\..\\..\\b.pdf' })

    const result = await exportPdf({}, '<html></html>')

    expect(result.error).toMatchObject({ code: 'EINVALIDPATH' })
    expect(browserWindowCtorMock).not.toHaveBeenCalled()
    expect(atomicWriteMock).not.toHaveBeenCalled()
  })
})
