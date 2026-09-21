// @vitest-environment jsdom
//
// Regression coverage for the single command-dispatch path (04-CONTEXT.md
// "One command-dispatch path") and its single source of truth for every
// command ID string, COMMAND_IDS. Deliberately proves the registry
// mechanics (src/renderer/command-dispatch.js) and the menu/COMMAND_IDS
// consistency check (src/main/menu.js) together, both against the REAL
// COMMAND_IDS object -- no second, independently-typed list of expected
// command ID strings exists anywhere in this file. That is the exact
// test-design gap plan-check feedback caught in the original single-plan
// design (a hand-maintained array compared against menu.js would only catch
// a registration typo if it also happened to diverge from the duplicate).
//
// `electron` is mocked because it cannot be imported outside a real
// Electron process (src/main/security.test.js's own mocking shape,
// mirrored here). `window.mdforge.onMenuCommand` is stubbed because
// command-dispatch.js self-wires to it at module load time -- the same
// subscription convention src/preload/index.js's onSystemThemeChanged
// already establishes.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() }
}))

// 07-06: menu.js now imports getCurrentRoot/openWorkspaceFolder/
// closeWorkspaceFolder from workspace-root.js. Mocked at the module
// boundary -- pulling in the real module would also pull in
// recents-store.js's `new Store()` (which needs a real `electron.app`) and
// workspace-watcher.js's chokidar, neither of which this file is testing.
const { getCurrentRootMock, openWorkspaceFolderMock, closeWorkspaceFolderMock } = vi.hoisted(() => ({
  getCurrentRootMock: vi.fn(() => null),
  openWorkspaceFolderMock: vi.fn(),
  closeWorkspaceFolderMock: vi.fn()
}))

vi.mock('./workspace-root.js', () => ({
  getCurrentRoot: (...args) => getCurrentRootMock(...args),
  openWorkspaceFolder: (...args) => openWorkspaceFolderMock(...args),
  closeWorkspaceFolder: (...args) => closeWorkspaceFolderMock(...args)
}))

window.mdforge = { onMenuCommand: vi.fn() }

const { Menu } = await import('electron')
const { MENU_TEMPLATE, buildMenu } = await import('./menu.js')
const { COMMAND_IDS } = await import('../shared/command-ids.js')
const { registerCommand, dispatch, getRegisteredCommandIds } = await import('../renderer/command-dispatch.js')

function flattenMenuEntries (template) {
  return template.flatMap((menu) => menu.submenu ?? [])
}

describe('COMMAND_IDS', () => {
  it('never assigns the same command ID value to two different keys', () => {
    // A copy-paste duplicate would otherwise silently merge two distinct
    // commands onto one dispatch target.
    const values = Object.values(COMMAND_IDS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('MENU_TEMPLATE against the shared COMMAND_IDS source of truth', () => {
  it('gives every accelerator-bearing entry a commandId drawn from the real COMMAND_IDS', () => {
    const acceleratorEntries = flattenMenuEntries(MENU_TEMPLATE).filter((entry) => entry.accelerator)
    // Guards against a vacuously-true assertion if the template ever loses
    // its accelerators entirely.
    expect(acceleratorEntries.length).toBeGreaterThan(0)
    for (const entry of acceleratorEntries) {
      expect(Object.values(COMMAND_IDS)).toContain(entry.commandId)
    }
  })

  it('gives every menu entry, accelerated or not, a commandId that traces to COMMAND_IDS', () => {
    for (const entry of flattenMenuEntries(MENU_TEMPLATE)) {
      expect(Object.values(COMMAND_IDS)).toContain(entry.commandId)
    }
  })

  // 05-07: DOC-04/DOC-05's keyboard paths (Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W),
  // extending this same describe block rather than a new, parallel one --
  // asserts the three new entries' exact accelerator strings against the
  // real MENU_TEMPLATE, not a hand-typed duplicate list.
  //
  // 05-10: extended again (not duplicated) with TAB_REOPEN's
  // CmdOrCtrl+Shift+T -- DOC-07's reopen-closed-tab keyboard path.
  it('gives TAB_NEXT/TAB_PREV/TAB_CLOSE/TAB_REOPEN the correct accelerators', () => {
    const entries = flattenMenuEntries(MENU_TEMPLATE)
    const byCommandId = (id) => entries.find((entry) => entry.commandId === id)

    expect(byCommandId(COMMAND_IDS.TAB_NEXT)?.accelerator).toBe('CmdOrCtrl+Tab')
    expect(byCommandId(COMMAND_IDS.TAB_PREV)?.accelerator).toBe('CmdOrCtrl+Shift+Tab')
    expect(byCommandId(COMMAND_IDS.TAB_CLOSE)?.accelerator).toBe('CmdOrCtrl+W')
    expect(byCommandId(COMMAND_IDS.TAB_REOPEN)?.accelerator).toBe('CmdOrCtrl+Shift+T')
  })

  // 07-06 (WORK-01): Open Folder... (File) and Toggle Sidebar (View,
  // CmdOrCtrl+B) -- both static MENU_TEMPLATE entries, both must carry a
  // real COMMAND_IDS value per this describe block's own established
  // assertions above.
  it('gives Open Folder... the WORKSPACE_OPEN_FOLDER commandId in the File submenu', () => {
    const fileMenu = MENU_TEMPLATE.find((menu) => menu.label === 'File')
    const openFolderItem = fileMenu.submenu.find((item) => item.commandId === COMMAND_IDS.WORKSPACE_OPEN_FOLDER)
    expect(openFolderItem?.label).toBe('Open Folder...')
  })

  it('gives Toggle Sidebar the WORKSPACE_TOGGLE_SIDEBAR commandId and CmdOrCtrl+B in the View submenu', () => {
    const viewMenu = MENU_TEMPLATE.find((menu) => menu.label === 'View')
    const toggleItem = viewMenu.submenu.find((item) => item.commandId === COMMAND_IDS.WORKSPACE_TOGGLE_SIDEBAR)
    expect(toggleItem?.label).toBe('Toggle Sidebar')
    expect(toggleItem?.accelerator).toBe('CmdOrCtrl+B')
  })
})

describe('buildMenu -- Recent Folders / Close Folder (07-06, WORK-01)', () => {
  function lastBuiltFileSubmenu () {
    const calls = Menu.buildFromTemplate.mock.calls
    const template = calls[calls.length - 1][0]
    return template.find((menu) => menu.label === 'File').submenu
  }

  it('inserts a Recent Folders submenu (one item per folder) directly after Open Recent', () => {
    getCurrentRootMock.mockReturnValue(null)
    const win = { webContents: { send: vi.fn() } }

    buildMenu(win, [], () => {}, ['C:\\notes', 'C:\\other'])

    const submenu = lastBuiltFileSubmenu()
    const openRecentIndex = submenu.findIndex((item) => item.label === 'Open Recent')
    const recentFoldersIndex = submenu.findIndex((item) => item.label === 'Recent Folders')

    expect(openRecentIndex).toBeGreaterThanOrEqual(0)
    expect(recentFoldersIndex).toBe(openRecentIndex + 1)
    expect(submenu[recentFoldersIndex].submenu).toHaveLength(2)
    expect(submenu[recentFoldersIndex].submenu[0].label).toBe('notes')
  })

  it('a Recent Folders item click calls openWorkspaceFolder(win, folder) directly, no IPC round trip', () => {
    getCurrentRootMock.mockReturnValue(null)
    const win = { webContents: { send: vi.fn() } }

    buildMenu(win, [], () => {}, ['C:\\notes'])

    const submenu = lastBuiltFileSubmenu()
    const recentFoldersItem = submenu.find((item) => item.label === 'Recent Folders')
    openWorkspaceFolderMock.mockClear()
    recentFoldersItem.submenu[0].click()

    expect(openWorkspaceFolderMock).toHaveBeenCalledWith(win, 'C:\\notes')
  })

  it('omits Close Folder when no workspace root is open', () => {
    getCurrentRootMock.mockReturnValue(null)
    const win = { webContents: { send: vi.fn() } }

    buildMenu(win, [], () => {}, [])

    const submenu = lastBuiltFileSubmenu()
    expect(submenu.some((item) => item.label === 'Close Folder')).toBe(false)
  })

  it('inserts Close Folder directly after Recent Folders when a root is open, and its click calls closeWorkspaceFolder(win)', () => {
    getCurrentRootMock.mockReturnValue('C:\\notes')
    const win = { webContents: { send: vi.fn() } }

    buildMenu(win, [], () => {}, ['C:\\notes'])

    const submenu = lastBuiltFileSubmenu()
    const recentFoldersIndex = submenu.findIndex((item) => item.label === 'Recent Folders')
    const closeFolderItem = submenu[recentFoldersIndex + 1]
    expect(closeFolderItem.label).toBe('Close Folder')

    closeWorkspaceFolderMock.mockClear()
    closeFolderItem.click()
    expect(closeWorkspaceFolderMock).toHaveBeenCalledWith(win)

    getCurrentRootMock.mockReturnValue(null)
  })
})

describe('command-dispatch registry', () => {
  it('calls the registered handler exactly once on dispatch', () => {
    const handler = vi.fn()
    registerCommand('test:cmd', handler)
    dispatch('test:cmd')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not throw when dispatching an unregistered id', () => {
    expect(() => dispatch('unregistered:id')).not.toThrow()
  })

  it('getRegisteredCommandIds returns every id passed to registerCommand so far', () => {
    registerCommand('test:cmd-a', vi.fn())
    registerCommand('test:cmd-b', vi.fn())
    const ids = getRegisteredCommandIds()
    expect(ids).toContain('test:cmd-a')
    expect(ids).toContain('test:cmd-b')
  })
})
