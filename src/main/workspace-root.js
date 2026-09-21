// Single owner of "which folder is currently open" -- orchestrates the
// three Wave-1/2 workspace mechanisms (workspace-watcher.js's chokidar
// lifecycle, recents-store.js's addRecentFolder, and the renderer
// notification the sidebar/tree plans consume) into exactly one folder-
// open/replace/close path. Per 07-06-PLAN.md's must_haves: the dialog-
// driven Open Folder flow and an explicit-path Recent Folders click both
// converge on this same watcher-stop/start + addRecentFolder +
// renderer-notify sequence -- there is exactly one code path that opens a
// workspace root.
//
// isDirectory MUST survive the hand-off from workspace-watcher.js's
// classifyWatcherEvent into the 'workspace:external-vanish' payload sent
// here, verbatim, never dropped or defaulted to false -- 07-09's directory-
// delete cascade (WORK-06) depends on distinguishing a bulk directory
// delete from a single-file delete downstream. This is the exact hand-off
// point the plan-checker's Warning 1 previously found broken (T-7-16 in
// this plan's own threat_model).
//
// Every function here accepts `win` as an explicit parameter, matching this
// codebase's established registerXIpc(win)/never-a-module-global discipline
// (dialogs.js, theme-store.js).
//
// NOTE: written as ESM import/export -- see workspace-watcher.js's own
// top-of-file comment for why (Rollup only bundles relative local modules
// using static import syntax).
import { dialog, ipcMain } from 'electron'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from './workspace-watcher.js'
import { addRecentFolder } from './recents-store.js'

// Single-owner state, never bare-exported -- same discipline as
// workspace-watcher.js's own currentWatcher / text-file.js's openFileStats
// Map (07-PATTERNS.md "Single-owner state behind getter/setter").
let currentRoot = null

// [Rule 2 auto-fix, Task 3] menu.js's buildMenu() reads getCurrentRoot() to
// decide whether "Close Folder" appears and rebuilds the "Recent Folders"
// submenu -- but nothing else in this file triggered that rebuild. Without
// this hook, opening or closing a folder (via the dialog, a Recent Folders
// click, OR the workspace:open-folder/close-folder IPC handlers 07-07's
// renderer button will call) left the native menu showing a stale
// snapshot until some unrelated recents-document change happened to
// rebuild it -- silently breaking 07-UI-SPEC.md's own locked requirement
// that "Close Folder" is present "only once a folder is open". index.js
// wires this to the same rebuildMenu() function passed to
// registerRecentsIpc's onChanged callback, so there is exactly one
// menu-rebuild trigger, not two independently-typed ones.
let onRootChanged = () => {}

function setWorkspaceRootChangeListener (listener) {
  onRootChanged = typeof listener === 'function' ? listener : () => {}
}

function getCurrentRoot () {
  return currentRoot
}

// File-private. Classifies a workspace-watcher event and forwards it to the
// renderer over the appropriate channel. `event.isDirectory` is read and
// forwarded UNMODIFIED for a 'vanished' event -- see this file's header
// comment and T-7-16. Never `{ path: event.path }` alone for a vanish, and
// never a hardcoded `isDirectory: false`.
function forwardWatcherEvent (win, event) {
  if (event.kind === 'external-change') {
    win.webContents.send('workspace:external-change', { path: event.path })
  } else if (event.kind === 'vanished') {
    win.webContents.send('workspace:external-vanish', { path: event.path, isDirectory: event.isDirectory })
  }
}

/**
 * Opens (or replaces) the single workspace root. With no `folderPath`,
 * shows a native folder-picker dialog (dialog.showOpenDialog with
 * properties:['openDirectory']); on cancel or an empty selection, resolves
 * `null` with no watcher/recents/renderer change. With an explicit
 * `folderPath` (the Recent Folders case), skips the dialog entirely.
 *
 * Either form: fully stops any previously-running watcher before starting
 * a new one rooted at the chosen folder, records it via recents-store.js's
 * addRecentFolder, notifies the renderer over 'workspace:root-opened', and
 * updates getCurrentRoot(). Resolves `{ root: folderPath }`.
 */
async function openWorkspaceFolder (win, folderPath) {
  if (!folderPath) {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    folderPath = result.filePaths[0]
  }

  await stopWorkspaceWatcher()
  await startWorkspaceWatcher(folderPath, (event) => forwardWatcherEvent(win, event))
  addRecentFolder(folderPath)
  currentRoot = folderPath
  win.webContents.send('workspace:root-opened', { root: folderPath })
  onRootChanged()
  return { root: folderPath }
}

/**
 * Stops the watcher and clears the open workspace root. Never sends any
 * tab-related IPC -- closing the folder must not close any open tab
 * (07-CONTEXT.md's WORK-06 "the watcher informs; it never destroys"
 * invariant applies to the root-close path too, not just watcher events).
 */
async function closeWorkspaceFolder (win) {
  await stopWorkspaceWatcher()
  currentRoot = null
  win.webContents.send('workspace:root-closed')
  onRootChanged()
  return { ok: true }
}

function registerWorkspaceRootIpc (win) {
  ipcMain.handle('workspace:open-folder', () => openWorkspaceFolder(win))
  ipcMain.handle('workspace:close-folder', () => closeWorkspaceFolder(win))
}

export {
  openWorkspaceFolder,
  closeWorkspaceFolder,
  getCurrentRoot,
  registerWorkspaceRootIpc,
  setWorkspaceRootChangeListener
}
