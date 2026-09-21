// Native application Menu (SHELL-06/07). MENU_TEMPLATE is exported as a
// plain array -- not a live Menu instance -- so commands.test.js can inspect
// it without mocking a full Electron Menu object. buildMenu(win) maps it
// into a Menu.buildFromTemplate-compatible shape, attaching a click handler
// that sends the entry's commandId to the renderer over the single
// 'menu:command' channel command-dispatch.js subscribes to.
//
// Every accelerator-bearing entry's commandId is a COMMAND_IDS.* value,
// never a re-typed string literal -- COMMAND_IDS is the single source of
// truth every command ID string traces back to (04-CONTEXT.md).
//
// This file contains no macOS-modifier-key checks and no macOS command
// glyph anywhere. Native CmdOrCtrl accelerators are Electron's own
// Windows/Linux-correct equivalent of the browser app's old modifier check
// and button-label glyph, both of which were wrong on Windows
// (04-CONTEXT.md "Menu, Shell Integration & Window State").
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { Menu, dialog, shell, app } from 'electron'
import path from 'node:path'
import { COMMAND_IDS } from '../shared/command-ids.js'
import { getCurrentRoot, openWorkspaceFolder, closeWorkspaceFolder } from './workspace-root.js'
import { triggerManualCheck } from './updater.js'

// This plan builds ONLY the dispatch machinery and the menu shell -- it
// does not register real command handlers (04-06, once open.js/save.js/
// new.js exist to register against) and does not delete shortcuts.js/
// picker.js (also 04-06). Every leaf entry below still gets a working
// accelerator and a working `menu:command` send; there is simply nothing
// listening on the renderer side to act on it yet.
const MENU_TEMPLATE = [
  {
    label: 'File',
    submenu: [
      { label: 'Open...', accelerator: 'CmdOrCtrl+O', commandId: COMMAND_IDS.FILE_OPEN },
      // 07-06 (WORK-01): static entry, dispatched through the same single
      // command-dispatch path as every other File entry (a renderer-side
      // handler built in 07-07 calls window.mdforge.openFolder()) --
      // distinct from the dynamically-built Recent Folders/Close Folder
      // items below, which carry their own per-item closures.
      { label: 'Open Folder...', commandId: COMMAND_IDS.WORKSPACE_OPEN_FOLDER },
      { label: 'New', accelerator: 'CmdOrCtrl+N', commandId: COMMAND_IDS.FILE_NEW },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', commandId: COMMAND_IDS.FILE_SAVE },
      { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', commandId: COMMAND_IDS.FILE_SAVE_AS },
      { label: 'Reveal in Explorer', commandId: COMMAND_IDS.FILE_REVEAL_IN_EXPLORER },
      { label: 'Export as PDF...', commandId: COMMAND_IDS.FILE_EXPORT_PDF },
      { label: 'Export as HTML...', commandId: COMMAND_IDS.FILE_EXPORT_HTML }
    ]
  },
  // 05-07: DOC-04/DOC-05's keyboard paths, wired through the SAME
  // single-dispatch path as every File entry above, replacing tab-bar.js's
  // former window-level keydown listener for these three shortcuts (05-04's
  // interim implementation, added before menu.js had any tab-related
  // entries to route through). 'View' chosen over 'Edit' for tab
  // navigation/closing commands -- both are acceptable per 05-CONTEXT.md's
  // discretion; 'View' groups them with what-you're-looking-at rather than
  // implying a text-editing operation.
  //
  // 05-10: DOC-07's Ctrl+Shift+T ("Reopen Closed Tab"), same submenu, same
  // single-dispatch path -- reopens the most recently closed document from
  // tabs/closed-stack.js's depth-10 stack.
  {
    label: 'View',
    submenu: [
      { label: 'Next Tab', accelerator: 'CmdOrCtrl+Tab', commandId: COMMAND_IDS.TAB_NEXT },
      { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab', commandId: COMMAND_IDS.TAB_PREV },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', commandId: COMMAND_IDS.TAB_CLOSE },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', commandId: COMMAND_IDS.TAB_REOPEN },
      // 07-06 (WORK-01): sidebar visibility toggle, same single-dispatch
      // path as the four tab commands above -- a renderer-side handler
      // built in 07-07 toggles the sidebar's collapsed state.
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', commandId: COMMAND_IDS.WORKSPACE_TOGGLE_SIDEBAR }
    ]
  },
  // 08-03 (DIST-03/SHELL-05 escape hatch): Help submenu. Its `submenu` here
  // is a placeholder -- these three items each need a real `win` reference
  // (triggerManualCheck(win), dialog.showMessageBox(win, ...)) that does not
  // exist at module-load time, so buildMenu()'s label==='Help' branch below
  // rebuilds this submenu fresh via buildHelpSubmenu(win) on every call
  // (Pattern 4: rebuild, not mutate -- same reason 'File' gets special
  // handling for its dynamic Open Recent/Recent Folders/Close Folder items).
  // None of the three items carries a commandId: each already has its own
  // `click`, so buildMenu()'s per-item mapping passes them through untouched
  // exactly like "Close Folder" (see that item's own comment for why this
  // guard exists -- three prior incidents).
  {
    label: 'Help',
    submenu: []
  }
]

// 08-03 (DIST-03): "Check for Updates..." calls triggerManualCheck(win)
// directly, main-process-only, no IPC/renderer round trip -- the same
// pattern "Close Folder" already established for a leaf item whose action
// depends on runtime state rather than a fixed app-wide command.
//
// Two-repo split (post-v1.1): this app is developed in the private
// Cboybebop/MD-Forge-App repo, but releases are published to the PUBLIC
// Cboybebop/MDForge-ElectronApp repo (see scripts/release-export.mjs). "View
// Releases on GitHub" must point at the public repo -- a link to the private
// repo would 404 for every user who isn't a collaborator. This string must
// stay in sync with electron-builder.yml's `publish.owner`/`publish.repo`
// block, which governs the same thing for the packaged auto-updater.
function buildHelpSubmenu (win) {
  return [
    { label: 'Check for Updates...', click: () => triggerManualCheck(win) },
    {
      label: 'About MD Forge',
      click: () => dialog.showMessageBox(win, { message: `MD Forge v${app.getVersion()}` })
    },
    {
      label: 'View Releases on GitHub',
      click: () => shell.openExternal('https://github.com/Cboybebop/MDForge-ElectronApp/releases')
    }
  ]
}

// 06-06 (PERS-07): builds the "Open Recent" submenu for the File menu.
// Recent-document items are NOT routed through the shared COMMAND_IDS.*
// dispatch path -- each one carries its OWN file path, not a fixed
// app-wide command, so it needs its own closure over that path rather than
// a commandId looked up by command-dispatch.js. These items carry no
// `commandId` key at all, which is fine: the buildMenu() mapping below
// destructures `commandId` out unconditionally, and an item with no
// `commandId` key simply destructures to `commandId: undefined`.
//
// Empty `recentDocs` (the common first-launch state) produces a submenu of
// just the separator + Clear item -- Electron renders that correctly.
//
// No "Recent Folders" section is built here at all this phase --
// 06-CONTEXT.md locks the folders half as empty/hidden until Phase 7
// supplies a folder-opening action; an always-empty section would be dead
// UI.
function buildOpenRecentSubmenu (win, recentDocs, onClearRecents) {
  const docItems = recentDocs.map((doc) => ({
    label: path.basename(doc),
    click: () => win.webContents.send('file:external-open-path', doc)
  }))
  return [
    ...docItems,
    { type: 'separator' },
    { label: 'Clear Recently Opened', click: onClearRecents }
  ]
}

// 07-06 (WORK-01): builds the "Recent Folders" submenu for the File menu,
// mirroring buildOpenRecentSubmenu's exact per-item-closure shape -- each
// item carries its OWN folder path, not a fixed app-wide command, so it
// needs its own closure rather than a commandId. click calls
// openWorkspaceFolder(win, folder) directly: no IPC round trip needed
// since menu.js already runs in the main process, same as
// openWorkspaceFolder itself. No separator/clear item this phase
// (07-06-PLAN.md) -- unlike Open Recent, Recent Folders has no "Clear"
// action defined yet.
function buildRecentFoldersSubmenu (win, recentFolders) {
  return recentFolders.map((folder) => ({
    label: path.basename(folder),
    click: () => openWorkspaceFolder(win, folder)
  }))
}

function buildMenu (win, recentDocs = [], onClearRecents = () => {}, recentFolders = []) {
  // `commandId` is this file's own bookkeeping field, not a real Electron
  // MenuItemConstructorOptions property. It must be stripped out of the
  // object passed to Menu.buildFromTemplate() -- Electron 43's native
  // MenuItem constructor performs strict argument conversion and throws
  // ("conversion failure from file:open") on unrecognised properties rather
  // than silently ignoring them, which was silently swallowing the entire
  // custom menu (an unhandled promise rejection inside app.whenReady()) and
  // falling back to Electron's bare default application menu -- discovered
  // via 04-06's real dual-trigger e2e test (Rule 1 auto-fix; not a
  // 04-06-PLAN.md file, but the bug it introduced blocks that plan's own
  // acceptance criteria).
  const mappedTemplate = MENU_TEMPLATE.map((menu) => {
    // The File menu's submenu is rebuilt fresh every call (Pattern 4:
    // dynamic native menu = rebuild, not mutate) since it must vary with
    // the current recentDocs snapshot -- inserted after "Save As..." and
    // before "Reveal in Explorer", per 06-06-PLAN.md.
    let submenuSource = menu.submenu
    if (menu.label === 'Help') {
      submenuSource = buildHelpSubmenu(win)
    } else if (menu.label === 'File') {
      const saveAsIndex = menu.submenu.findIndex((item) => item.commandId === COMMAND_IDS.FILE_SAVE_AS)
      const openRecentItem = { label: 'Open Recent', submenu: buildOpenRecentSubmenu(win, recentDocs, onClearRecents) }
      // 07-06 (WORK-01): Recent Folders is inserted directly after Open
      // Recent, mirroring its shape exactly (its own submenu, no
      // commandId). Close Folder is inserted directly after Recent
      // Folders, and ONLY when a workspace root is currently open --
      // getCurrentRoot() is re-checked on every buildMenu() call (Pattern
      // 4: rebuild, not mutate), so the item appears/disappears live as
      // folders are opened/closed.
      const recentFoldersItem = { label: 'Recent Folders', submenu: buildRecentFoldersSubmenu(win, recentFolders) }
      const dynamicFileItems = [openRecentItem, recentFoldersItem]
      if (getCurrentRoot()) {
        dynamicFileItems.push({ label: 'Close Folder', click: () => closeWorkspaceFolder(win) })
      }
      submenuSource = [
        ...menu.submenu.slice(0, saveAsIndex + 1),
        ...dynamicFileItems,
        ...menu.submenu.slice(saveAsIndex + 1)
      ]
    }
    return {
      label: menu.label,
      submenu: submenuSource.map((item) => {
        const { commandId, ...rest } = item
        // A submenu item (e.g. "Open Recent"/"Recent Folders") already
        // carries its own built `submenu` array of `{ label, click }`/
        // `{ type, ... }` items with no commandId of their own -- those
        // must pass through untouched, not be given a click handler that
        // sends `undefined` over menu:command.
        //
        // 07-06 (WORK-01, Rule 1 auto-fix -- the third variant of this
        // exact landmine): a LEAF item that already carries its own
        // `click` (e.g. "Close Folder") must ALSO pass through untouched.
        // Without this check, the fallback branch below would silently
        // overwrite Close Folder's real click handler with one that sends
        // `commandId: undefined` over menu:command, since Close Folder
        // intentionally has no commandId (its action depends on which
        // folder is open, not a fixed app-wide command).
        if (Array.isArray(rest.submenu) || typeof rest.click === 'function') {
          return rest
        }
        return {
          ...rest,
          click: () => win.webContents.send('menu:command', commandId)
        }
      })
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(mappedTemplate))
}

export { buildMenu, MENU_TEMPLATE }
