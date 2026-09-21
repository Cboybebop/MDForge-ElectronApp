// Regression tests for workspace-root.js -- the single owner of "which
// folder is currently open" (WORK-01, and the wiring point for WORK-04..07).
// Mirrors workspace-fileops.test.js's mocked-`electron` shape.
// workspace-watcher.js and recents-store.js are mocked at the module
// boundary -- this file's own job is orchestration, not re-testing 07-05's
// chokidar lifecycle or 06-02's recents persistence, both already covered
// by their own test files.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { showOpenDialogMock, ipcHandleMock } = vi.hoisted(() => ({
  showOpenDialogMock: vi.fn(),
  ipcHandleMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args) => showOpenDialogMock(...args) },
  ipcMain: { handle: (...args) => ipcHandleMock(...args) }
}))

const { startWorkspaceWatcherMock, stopWorkspaceWatcherMock } = vi.hoisted(() => ({
  startWorkspaceWatcherMock: vi.fn(),
  stopWorkspaceWatcherMock: vi.fn()
}))

vi.mock('./workspace-watcher.js', () => ({
  startWorkspaceWatcher: (...args) => startWorkspaceWatcherMock(...args),
  stopWorkspaceWatcher: (...args) => stopWorkspaceWatcherMock(...args)
}))

const { addRecentFolderMock } = vi.hoisted(() => ({
  addRecentFolderMock: vi.fn()
}))

vi.mock('./recents-store.js', () => ({
  addRecentFolder: (...args) => addRecentFolderMock(...args)
}))

const {
  openWorkspaceFolder,
  closeWorkspaceFolder,
  getCurrentRoot,
  registerWorkspaceRootIpc,
  setWorkspaceRootChangeListener
} = await import('./workspace-root.js')

function makeWin () {
  return { webContents: { send: vi.fn() } }
}

beforeEach(() => {
  vi.clearAllMocks()
  stopWorkspaceWatcherMock.mockResolvedValue(undefined)
  startWorkspaceWatcherMock.mockResolvedValue({ healthy: true })
})

describe('openWorkspaceFolder -- dialog-driven path', () => {
  it('shows the native folder picker, starts the watcher, records the recent folder, and notifies the renderer', async () => {
    const win = makeWin()
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\notes'] })

    const result = await openWorkspaceFolder(win)

    expect(showOpenDialogMock).toHaveBeenCalledWith(win, { properties: ['openDirectory'] })
    expect(stopWorkspaceWatcherMock).toHaveBeenCalledTimes(1)
    expect(startWorkspaceWatcherMock).toHaveBeenCalledWith('C:\\notes', expect.any(Function))
    expect(addRecentFolderMock).toHaveBeenCalledWith('C:\\notes')
    expect(win.webContents.send).toHaveBeenCalledWith('workspace:root-opened', { root: 'C:\\notes' })
    expect(getCurrentRoot()).toBe('C:\\notes')
    expect(result).toEqual({ root: 'C:\\notes' })
  })

  it('resolves null and makes no watcher/recents/renderer change on cancel', async () => {
    const win = makeWin()
    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    const result = await openWorkspaceFolder(win)

    expect(result).toBeNull()
    expect(stopWorkspaceWatcherMock).not.toHaveBeenCalled()
    expect(startWorkspaceWatcherMock).not.toHaveBeenCalled()
    expect(addRecentFolderMock).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('resolves null when filePaths is empty even if not canceled', async () => {
    const win = makeWin()
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [] })

    const result = await openWorkspaceFolder(win)

    expect(result).toBeNull()
    expect(startWorkspaceWatcherMock).not.toHaveBeenCalled()
  })
})

describe('openWorkspaceFolder -- explicit-path form (Recent Folders)', () => {
  it('skips the dialog entirely when a folderPath is passed', async () => {
    const win = makeWin()

    const result = await openWorkspaceFolder(win, 'C:\\explicit')

    expect(showOpenDialogMock).not.toHaveBeenCalled()
    expect(stopWorkspaceWatcherMock).toHaveBeenCalledTimes(1)
    expect(startWorkspaceWatcherMock).toHaveBeenCalledWith('C:\\explicit', expect.any(Function))
    expect(addRecentFolderMock).toHaveBeenCalledWith('C:\\explicit')
    expect(win.webContents.send).toHaveBeenCalledWith('workspace:root-opened', { root: 'C:\\explicit' })
    expect(result).toEqual({ root: 'C:\\explicit' })
  })
})

describe('openWorkspaceFolder -- replacing an already-open root', () => {
  it('always stops the previous watcher before starting the new one', async () => {
    const win = makeWin()
    const callOrder = []
    stopWorkspaceWatcherMock.mockImplementation(async () => { callOrder.push('stop') })
    startWorkspaceWatcherMock.mockImplementation(async () => { callOrder.push('start'); return { healthy: true } })

    await openWorkspaceFolder(win, 'C:\\first')
    await openWorkspaceFolder(win, 'C:\\second')

    expect(callOrder).toEqual(['stop', 'start', 'stop', 'start'])
    expect(getCurrentRoot()).toBe('C:\\second')
  })
})

describe('onEvent forwarding -- isDirectory must survive the main-to-renderer hand-off (T-7-16)', () => {
  async function captureOnEvent (win, folderPath) {
    await openWorkspaceFolder(win, folderPath)
    const lastCall = startWorkspaceWatcherMock.mock.calls.at(-1)
    return lastCall[1]
  }

  it('forwards a directory vanish with isDirectory:true, never dropped or defaulted', async () => {
    const win = makeWin()
    const onEvent = await captureOnEvent(win, 'C:\\notes')

    onEvent({ kind: 'vanished', path: 'C:\\notes\\sub', isDirectory: true })

    expect(win.webContents.send).toHaveBeenCalledWith('workspace:external-vanish', { path: 'C:\\notes\\sub', isDirectory: true })
  })

  it('forwards a file vanish with isDirectory:false', async () => {
    const win = makeWin()
    const onEvent = await captureOnEvent(win, 'C:\\notes')

    onEvent({ kind: 'vanished', path: 'C:\\notes\\file.md', isDirectory: false })

    expect(win.webContents.send).toHaveBeenCalledWith('workspace:external-vanish', { path: 'C:\\notes\\file.md', isDirectory: false })
  })

  it('forwards an external-change event as {path} only', async () => {
    const win = makeWin()
    const onEvent = await captureOnEvent(win, 'C:\\notes')

    onEvent({ kind: 'external-change', path: 'C:\\notes\\file.md', stat: {} })

    expect(win.webContents.send).toHaveBeenCalledWith('workspace:external-change', { path: 'C:\\notes\\file.md' })
  })
})

describe('closeWorkspaceFolder', () => {
  it('stops the watcher, clears getCurrentRoot, and sends root-closed -- never a tab-related IPC', async () => {
    const win = makeWin()
    await openWorkspaceFolder(win, 'C:\\notes')
    win.webContents.send.mockClear()
    stopWorkspaceWatcherMock.mockClear()

    const result = await closeWorkspaceFolder(win)

    expect(stopWorkspaceWatcherMock).toHaveBeenCalledTimes(1)
    expect(getCurrentRoot()).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('workspace:root-closed')
    expect(result).toEqual({ ok: true })
  })
})

describe('setWorkspaceRootChangeListener -- menu.js rebuild trigger (Rule 2 auto-fix)', () => {
  it('invokes the registered listener after both openWorkspaceFolder and closeWorkspaceFolder', async () => {
    const listener = vi.fn()
    setWorkspaceRootChangeListener(listener)
    const win = makeWin()

    await openWorkspaceFolder(win, 'C:\\notes')
    expect(listener).toHaveBeenCalledTimes(1)

    await closeWorkspaceFolder(win)
    expect(listener).toHaveBeenCalledTimes(2)

    setWorkspaceRootChangeListener(null) // reset for subsequent tests
  })

  it('a non-function argument resets to a harmless no-op rather than throwing', async () => {
    setWorkspaceRootChangeListener(null)
    const win = makeWin()

    await expect(openWorkspaceFolder(win, 'C:\\notes')).resolves.toEqual({ root: 'C:\\notes' })
  })
})

describe('registerWorkspaceRootIpc', () => {
  it('registers workspace:open-folder and workspace:close-folder handlers', () => {
    const win = makeWin()
    registerWorkspaceRootIpc(win)

    const channels = ipcHandleMock.mock.calls.map(([ch]) => ch)
    expect(channels).toContain('workspace:open-folder')
    expect(channels).toContain('workspace:close-folder')
  })
})
