// Hand-written contextBridge surface: theme get/set + system-theme-change
// subscription + fetchImageAsDataUrl bridge. See 01-RESEARCH.md Pattern 4
// and 01-CONTEXT.md "Theme System (EDIT-02)".
//
// Primary pre-paint mechanism: ipcRenderer.sendSync blocks synchronously,
// before any renderer script executes, so the theme VALUE is known before
// first paint with no IPC-latency flash risk.
//
// 01-RESEARCH.md Open Question 1 flagged (MEDIUM confidence) that the exact
// HTML5-parsing-spec timing of when `document.documentElement` is
// synthesized, relative to sandboxed preload execution, was unverified, and
// recommended a Wave 0 smoke check before relying on it. That UI-driven
// check requires 01-05-PLAN.md's theme <select>/theme.js (not built yet at
// this point in execution order), but an equivalent smoke check was run here
// via tests/e2e/theme.spec.js's persistence-across-relaunch test: on the
// SECOND launch (theme='dark', i.e. the branch that touches the DOM),
// `document.documentElement` was confirmed NULL at preload execution time,
// throwing `TypeError: Cannot read properties of null (reading 'dataset')`
// and aborting the entire preload script BEFORE contextBridge.exposeInMainWorld
// ran -- losing the whole window.mdforge API, not just a cosmetic flash. The
// documented fallback (switch the value source to `--initial-theme=` via
// process.argv / window.js's additionalArguments) does not address this --
// the crash is in the DOM *write*, not the value *read*. Fix: defer the
// write to the earliest point documentElement is guaranteed to exist by
// listening for 'readystatechange' (fires as document.readyState advances;
// document.documentElement exists by the time readyState first reports
// 'loading' from within this handler, which fires before the parser has
// processed any content and therefore still before first paint) instead of
// writing synchronously at the top of the script. This preserves the
// pre-paint intent while eliminating the crash -- see SUMMARY for details
// (Rule 1 auto-fix).
import { contextBridge, ipcRenderer } from 'electron'

const theme = ipcRenderer.sendSync('theme:get-initial') // 'light' | 'dark' | 'system'

function applyInitialTheme () {
  // Per locked mechanism: 'system' sets NO attribute (falls through to the
  // @media (prefers-color-scheme: dark) query in tokens.css).
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('readystatechange', applyInitialTheme, { once: true })
} else {
  // Already past 'loading' (should not normally happen this early, but
  // guards against any future Electron/Chromium timing change).
  applyInitialTheme()
}

contextBridge.exposeInMainWorld('mdforge', {
  getTheme: () => theme,
  setTheme: (value) => ipcRenderer.invoke('theme:set', value),
  onSystemThemeChanged: (callback) => {
    ipcRenderer.on('theme:system-changed', (_event, shouldUseDarkColors) => callback(shouldUseDarkColors))
  },
  fetchImageAsDataUrl: (url) => ipcRenderer.invoke('image:fetch-as-data-url', url),

  // File services + native dialogs (SHELL-02/03/04/09). Five explicit named
  // methods only -- never a generic invoke(channel, ...args) passthrough,
  // which would hand the renderer the whole IPC surface and undo most of
  // what contextIsolation buys (04-CONTEXT.md, locked decision).
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  openAtPath: (filePath) => ipcRenderer.invoke('file:open-path', filePath),
  saveFile: (filePath, content, options) => ipcRenderer.invoke('file:save', filePath, content, options),
  // [07-09] `suggestedName` is additive/optional -- every pre-existing
  // caller omits it and gets identical behavior; workspace/reconcile.js's
  // Save As Copy button passes a computed sibling filename hint.
  saveFileAs: (content, suggestedName) => ipcRenderer.invoke('dialog:save-file-as', content, suggestedName),
  revealInExplorer: (filePath) => ipcRenderer.invoke('shell:reveal-in-explorer', filePath),

  // DOC-04's single-tab close prompt (05-12, 05-UI-SPEC.md Surface 5) --
  // same explicit-named-method discipline as the five above.
  confirmCloseTab: (docName) => ipcRenderer.invoke('dialog:confirm-close-tab', docName),

  // Window title (SHELL-0x / 05-UI-SPEC.md Surface 4): one-way send, not
  // invoke -- main.js's registerWindowTitleIpc has nothing to return, and a
  // fire-and-forget title update should never make the renderer wait on an
  // IPC round-trip.
  setWindowTitleInfo: (name, dirty) => ipcRenderer.send('window:set-title-info', name, dirty),

  // Export (EXPT-03/EXPT-04): the renderer composes the fully self-contained
  // HTML (files/export.js), main handles the save dialog + hidden-window
  // printToPDF/atomic write (src/main/export.js).
  exportPdf: (html) => ipcRenderer.invoke('export:pdf', html),
  exportHtml: (html) => ipcRenderer.invoke('export:html', html),

  // Single command-dispatch path (SHELL-07). menu.js sends a COMMAND_IDS.*
  // value over this one channel for every accelerator and every menu click
  // alike; command-dispatch.js is the sole subscriber. Same
  // ipcRenderer.on(channel, (_e, arg) => callback(arg)) shape as
  // onSystemThemeChanged above.
  onMenuCommand: (callback) => {
    ipcRenderer.on('menu:command', (_event, id) => callback(id))
  },

  // SHELL-06: fired by src/main/index.js's 'second-instance' handler when a
  // second launch carries a .md/.markdown path -- routes it to the same
  // openFileAtPath the Open button and drag-drop both use. Same
  // ipcRenderer.on(channel, (_e, arg) => callback(arg)) shape as
  // onSystemThemeChanged/onMenuCommand above.
  onExternalOpenPath: (callback) => {
    ipcRenderer.on('file:external-open-path', (_event, path) => callback(path))
  },

  // The before-quit <-> renderer handshake (SHELL-03/04, 04-10). Fired by
  // src/main/before-quit.js's app.on('before-quit') handler, which blocks
  // the real quit until this renderer answers over app:quit-decision.
  onQueryDirtyState: (callback) => {
    ipcRenderer.on('app:query-dirty-state', () => callback())
  },
  sendQuitDecision: (decision) => ipcRenderer.send('app:quit-decision', decision),

  // DOC-06 (05-12): the two-round-trip aggregated quit handshake.
  // sendDirtyDocuments answers 'app:query-dirty-state' with the renderer's
  // own enumeration of every dirty document. onQuitDecisionRequest receives
  // the user's button choice ('save-all'|'discard-all'|'cancel') back from
  // main -- deliberately over the SAME 'app:quit-decision' channel name
  // sendQuitDecision above sends on, just the opposite direction
  // (ipcRenderer.on receiving a main->renderer webContents.send, never
  // triggered by this preload's own ipcRenderer.send calls above).
  sendDirtyDocuments: (docs) => ipcRenderer.send('app:dirty-documents', docs),
  onQuitDecisionRequest: (callback) => {
    ipcRenderer.on('app:quit-decision', (_event, decision) => callback(decision))
  },

  // PERS-01/02/03/04/06 (06-04): draft-journal write/delete bridge, the
  // main-composed restore plan, this app's own "restore finished" signal
  // (window.js's two-signal show-gate, 06-RESEARCH.md Pattern 1), and
  // session-state persistence. getRestorePlan uses sendSync -- same
  // synchronous-before-first-paint requirement as theme:get-initial's own
  // sendSync call at the top of this file, since documents.js needs the
  // plan at module-load time to decide whether to run its bootstrap-document
  // fallback (06-RESEARCH.md Pitfall 1).
  writeDraft: (uuid, content, meta) => ipcRenderer.invoke('draft:write', uuid, content, meta),
  deleteDraft: (uuid) => ipcRenderer.invoke('draft:delete', uuid),
  getRestorePlan: () => ipcRenderer.sendSync('restore:get-plan'),
  signalRestoreComplete: () => ipcRenderer.send('app:restore-complete'),
  saveSessionState: (state) => ipcRenderer.send('session:save', state),

  // PERS-07 (06-06): recent-documents bridge, mapping 1:1 onto the two
  // ipcMain.handle channels recents-store.js's registerRecentsIpc() already
  // registers (06-02) -- no new main-process code needed for these two.
  addRecentDocument: (filePath) => ipcRenderer.invoke('recents:add-document', filePath),
  reportOpenFailure: (filePath) => ipcRenderer.invoke('recents:report-open-failure', filePath),

  // WORK-01/03/04/05/06 (07-06): every renderer-facing workspace capability
  // -- open/close the workspace root, list/create/rename a tree entry, and
  // receive every watcher-classified push event -- exposed as explicit
  // named methods only, same discipline as every bridge method above. Never
  // a generic invoke(channel, ...args) passthrough (T-7-10).
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  closeFolder: () => ipcRenderer.invoke('workspace:close-folder'),
  listWorkspaceDir: (dirPath) => ipcRenderer.invoke('workspace:list-dir', dirPath),
  createWorkspaceFile: (parentDirPath, name) => ipcRenderer.invoke('workspace:create-file', parentDirPath, name),
  renameWorkspaceEntry: (oldPath, newName) => ipcRenderer.invoke('workspace:rename', oldPath, newName),
  onWorkspaceRootOpened: (callback) => {
    ipcRenderer.on('workspace:root-opened', (_event, payload) => callback(payload))
  },
  onWorkspaceRootClosed: (callback) => {
    ipcRenderer.on('workspace:root-closed', () => callback())
  },
  onWorkspaceFileChanged: (callback) => {
    ipcRenderer.on('workspace:external-change', (_event, payload) => callback(payload))
  },
  // 07-06 (T-7-16): `payload` already carries {path, isDirectory} verbatim
  // from workspace-root.js's send call -- this bridge method must not
  // reshape or drop either field.
  onWorkspaceFileVanished: (callback) => {
    ipcRenderer.on('workspace:external-vanish', (_event, payload) => callback(payload))
  },

  // Sidebar width/collapsed persistence (07-07, WORK-01/02 UI). getSidebarState
  // is sendSync like theme:get-initial above -- sidebar-resize.js applies this
  // state at module-load time, before first paint, with no IPC-latency flash.
  // Persisted through window-state.js's existing electron-store instance, not
  // a new one (07-PATTERNS.md).
  getSidebarState: () => ipcRenderer.sendSync('sidebar:get-state'),
  setSidebarState: (state) => ipcRenderer.send('sidebar:set-state', state),

  // WORK-03 (07-08): the tree's native context menu + shared
  // confirm-and-delete bridge. showTreeContextMenu is a fire-and-forget
  // send, not invoke -- the native menu's own click handlers produce their
  // OWN later, asynchronous 'workspace:context-action' send, so there is no
  // single request/response pair to await here. createWorkspaceFile/
  // renameWorkspaceEntry/listWorkspaceDir were already added in 07-06 --
  // not duplicated here.
  showTreeContextMenu: (x, y, path, isDirectory, isRoot) => ipcRenderer.send('workspace:tree-context-menu', { x, y, path, isDirectory, isRoot }),
  onWorkspaceContextAction: (callback) => {
    ipcRenderer.on('workspace:context-action', (_event, payload) => callback(payload))
  },
  confirmAndDeleteEntry: (targetPath, isDirectory) => ipcRenderer.invoke('workspace:confirm-and-delete', targetPath, isDirectory),

  // WORK-05 (07-09): reconcile.js's Keep Mine banner action -- advances
  // main's recorded-stat baseline for a document the user chose to keep,
  // without reading or writing its content.
  acknowledgeExternalChange: (filePath) => ipcRenderer.invoke('workspace:acknowledge-external-change', filePath)
})
