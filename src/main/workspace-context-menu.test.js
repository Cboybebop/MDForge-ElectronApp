// Regression tests for the native tree context menu + shared
// confirm-and-delete function (WORK-03, 07-UI-SPEC.md "Surface 2"/"Surface
// 5"). Mirrors dialogs.test.js's mocking shape: `electron` is mocked (only
// Menu.buildFromTemplate/dialog.showMessageBox/ipcMain are touched by this
// module), and workspace-fileops.js's deleteWorkspaceEntry is mocked at the
// module boundary -- this file's own job is the menu/dialog shape and the
// converge-on-one-function contract, not re-proving 07-02's already-tested
// delete mechanism.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  showMessageBoxMock,
  buildFromTemplateMock,
  popupMock,
  deleteWorkspaceEntryMock
} = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  buildFromTemplateMock: vi.fn(),
  popupMock: vi.fn(),
  deleteWorkspaceEntryMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  dialog: {
    showMessageBox: (...args) => showMessageBoxMock(...args)
  },
  Menu: {
    buildFromTemplate: (template) => {
      buildFromTemplateMock(template)
      return { popup: (...args) => popupMock(...args) }
    }
  }
}))

vi.mock('./workspace-fileops.js', () => ({
  deleteWorkspaceEntry: (...args) => deleteWorkspaceEntryMock(...args)
}))

const { ipcMain } = await import('electron')
const {
  showTreeContextMenu,
  confirmAndDeleteEntry,
  registerWorkspaceContextMenuIpc
} = await import('./workspace-context-menu.js')

function makeWin () {
  return { webContents: { send: vi.fn() } }
}

function findItem (template, label) {
  return template.find((item) => item.label === label)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('showTreeContextMenu -- row-type item table (07-UI-SPEC.md Surface 2)', () => {
  it('a FILE row pops New File (disabled), Rename, Delete', () => {
    const win = makeWin()
    showTreeContextMenu(win, { x: 10, y: 20, path: 'C:\\notes\\a.md', isDirectory: false, isRoot: false })

    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1)
    const template = buildFromTemplateMock.mock.calls[0][0]
    expect(template.map((i) => i.label)).toEqual(['New File', 'Rename', 'Delete'])
    expect(findItem(template, 'New File').enabled).toBe(false)
    expect(findItem(template, 'Rename').enabled).not.toBe(false)
    expect(findItem(template, 'Delete').enabled).not.toBe(false)

    expect(popupMock).toHaveBeenCalledWith({ window: win, x: 10, y: 20 })
  })

  it('a DIRECTORY row pops New File, Rename, Delete, all enabled', () => {
    const win = makeWin()
    showTreeContextMenu(win, { x: 1, y: 2, path: 'C:\\notes', isDirectory: true, isRoot: false })

    const template = buildFromTemplateMock.mock.calls[0][0]
    expect(template.map((i) => i.label)).toEqual(['New File', 'Rename', 'Delete'])
    expect(template.every((i) => i.enabled !== false)).toBe(true)
  })

  it('empty tree space (isRoot) pops New File only', () => {
    const win = makeWin()
    showTreeContextMenu(win, { x: 1, y: 2, path: 'C:\\notes', isDirectory: false, isRoot: true })

    const template = buildFromTemplateMock.mock.calls[0][0]
    expect(template.map((i) => i.label)).toEqual(['New File'])
  })
})

describe('showTreeContextMenu -- click handlers only ever send workspace:context-action (07-08 "same code path" lock)', () => {
  it('New File click sends {action:"new-file", path, isDirectory} and performs no filesystem call', () => {
    const win = makeWin()
    showTreeContextMenu(win, { x: 1, y: 2, path: 'C:\\notes', isDirectory: true, isRoot: false })
    const template = buildFromTemplateMock.mock.calls[0][0]

    findItem(template, 'New File').click()

    expect(win.webContents.send).toHaveBeenCalledWith('workspace:context-action', { action: 'new-file', path: 'C:\\notes', isDirectory: true })
    expect(deleteWorkspaceEntryMock).not.toHaveBeenCalled()
  })

  it('Rename click sends {action:"rename", path, isDirectory} and performs no filesystem call', () => {
    const win = makeWin()
    showTreeContextMenu(win, { x: 1, y: 2, path: 'C:\\notes\\a.md', isDirectory: false, isRoot: false })
    const template = buildFromTemplateMock.mock.calls[0][0]

    findItem(template, 'Rename').click()

    expect(win.webContents.send).toHaveBeenCalledWith('workspace:context-action', { action: 'rename', path: 'C:\\notes\\a.md', isDirectory: false })
    expect(deleteWorkspaceEntryMock).not.toHaveBeenCalled()
  })

  it('Delete click ONLY sends {action:"delete", ...} -- it never calls confirmAndDeleteEntry/deleteWorkspaceEntry inline', () => {
    const win = makeWin()
    showTreeContextMenu(win, { x: 1, y: 2, path: 'C:\\notes\\a.md', isDirectory: false, isRoot: false })
    const template = buildFromTemplateMock.mock.calls[0][0]

    findItem(template, 'Delete').click()

    expect(win.webContents.send).toHaveBeenCalledWith('workspace:context-action', { action: 'delete', path: 'C:\\notes\\a.md', isDirectory: false })
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(deleteWorkspaceEntryMock).not.toHaveBeenCalled()
  })
})

describe('confirmAndDeleteEntry -- Recycle-Bin-explicit copy (07-UI-SPEC.md Surface 5)', () => {
  it('FILE variant: message and detail both name the Recycle Bin, exact buttons/defaultId/cancelId/noLink', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 }) // Cancel, so we can inspect the call args safely
    const win = makeWin()

    await confirmAndDeleteEntry(win, 'C:\\notes\\roadmap.md', false)

    const options = showMessageBoxMock.mock.calls[0][1]
    expect(options.title).toBe('Delete file')
    expect(options.message).toBe('Move "roadmap.md" to the Recycle Bin?')
    expect(options.message).toContain('Recycle Bin')
    expect(options.detail).toContain('Recycle Bin')
    expect(options.buttons).toEqual(['Move to Recycle Bin', 'Cancel'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(1)
    expect(options.noLink).toBe(true)
  })

  it('DIRECTORY variant: names "everything inside it" and still names the Recycle Bin in both message and detail', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    const win = makeWin()

    await confirmAndDeleteEntry(win, 'C:\\notes', true)

    const options = showMessageBoxMock.mock.calls[0][1]
    expect(options.title).toBe('Delete folder')
    expect(options.message).toBe('Move "notes" and everything inside it to the Recycle Bin?')
    expect(options.message).toContain('Recycle Bin')
    expect(options.detail).toContain('Recycle Bin')
  })

  it('Cancel (any non-zero response) resolves {canceled:true} and never calls deleteWorkspaceEntry', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    const win = makeWin()

    const result = await confirmAndDeleteEntry(win, 'C:\\notes\\roadmap.md', false)

    expect(result).toEqual({ canceled: true })
    expect(deleteWorkspaceEntryMock).not.toHaveBeenCalled()
  })

  it('Move to Recycle Bin (response 0) calls deleteWorkspaceEntry(targetPath) and returns its result verbatim', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 0 })
    deleteWorkspaceEntryMock.mockResolvedValueOnce({ ok: true })
    const win = makeWin()

    const result = await confirmAndDeleteEntry(win, 'C:\\notes\\roadmap.md', false)

    expect(deleteWorkspaceEntryMock).toHaveBeenCalledWith('C:\\notes\\roadmap.md')
    expect(result).toEqual({ ok: true })
  })

  it('surfaces a deleteWorkspaceEntry failure result verbatim rather than swallowing it', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 0 })
    const failure = { ok: false, error: { message: 'boom', code: 'EPERM' } }
    deleteWorkspaceEntryMock.mockResolvedValueOnce(failure)
    const win = makeWin()

    const result = await confirmAndDeleteEntry(win, 'C:\\notes\\roadmap.md', false)

    expect(result).toEqual(failure)
  })
})

describe('registerWorkspaceContextMenuIpc', () => {
  it('registers workspace:tree-context-menu (ipcMain.on) and workspace:confirm-and-delete (ipcMain.handle)', () => {
    const win = makeWin()
    registerWorkspaceContextMenuIpc(win)

    expect(ipcMain.on).toHaveBeenCalledWith('workspace:tree-context-menu', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('workspace:confirm-and-delete', expect.any(Function))
  })

  it('the tree-context-menu handler forwards its payload into showTreeContextMenu', () => {
    const win = makeWin()
    registerWorkspaceContextMenuIpc(win)

    const onHandler = ipcMain.on.mock.calls.find(([ch]) => ch === 'workspace:tree-context-menu')[1]
    onHandler(null, { x: 5, y: 6, path: 'C:\\notes', isDirectory: true, isRoot: false })

    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1)
    expect(popupMock).toHaveBeenCalledWith({ window: win, x: 5, y: 6 })
  })

  it('the confirm-and-delete handler forwards its args into confirmAndDeleteEntry', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    const win = makeWin()
    registerWorkspaceContextMenuIpc(win)

    const handleFn = ipcMain.handle.mock.calls.find(([ch]) => ch === 'workspace:confirm-and-delete')[1]
    const result = await handleFn(null, 'C:\\notes\\a.md', false)

    expect(result).toEqual({ canceled: true })
  })
})
