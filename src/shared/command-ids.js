// Single source of truth for every command ID string used by the native
// Menu (src/main/menu.js) and the renderer's command registry
// (src/renderer/command-dispatch.js) and every renderer module that will
// register a handler against it (04-06 onward). Menu accelerators and
// keyboard shortcuts both resolve through this one object -- never a
// re-typed string literal, and never a second, hand-maintained list
// asserted to agree with it (04-CONTEXT.md "One command-dispatch path").
//
// Pure shared data: no `electron` import, no DOM import. electron-vite's
// Rollup bundler resolves relative imports outside each environment's own
// root, so this is safe to import unmodified from src/main/, src/preload/,
// and src/renderer/ alike.
//
// 04-09 (export) extends this same object with FILE_EXPORT_PDF/
// FILE_EXPORT_HTML below.
// 05-07 extends this same object with TAB_NEXT/TAB_PREV/TAB_CLOSE below --
// Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W are now native Menu accelerators (menu.js),
// routed through this one dispatch path like every other command, replacing
// tab-bar.js's own former window-level keydown listener for these three
// shortcuts (05-04's interim implementation, which pre-dated menu.js having
// any tab-related entries).
// 05-10 extends this same object with TAB_REOPEN -- DOC-07's Ctrl+Shift+T,
// reopening the most recently closed document from tabs/closed-stack.js's
// depth-10 stack, following the identical native-Menu-accelerator path
// TAB_NEXT/TAB_PREV/TAB_CLOSE already established.
// 07-06 (WORK-01) extends this same object with WORKSPACE_OPEN_FOLDER
// (File > Open Folder...) and WORKSPACE_TOGGLE_SIDEBAR (View > Toggle
// Sidebar, CmdOrCtrl+B) -- both static Menu accelerators, same single
// command-dispatch path as every entry above. Recent Folders and Close
// Folder are NOT here: like Open Recent, they carry their own per-item
// closure (a folder path or the current-root check) rather than a fixed
// app-wide command, so menu.js builds them dynamically inside buildMenu().
export const COMMAND_IDS = {
  FILE_OPEN: 'file:open',
  FILE_NEW: 'file:new',
  FILE_SAVE: 'file:save',
  FILE_SAVE_AS: 'file:save-as',
  FILE_REVEAL_IN_EXPLORER: 'file:reveal-in-explorer',
  FILE_EXPORT_PDF: 'file:export-pdf',
  FILE_EXPORT_HTML: 'file:export-html',
  TAB_NEXT: 'tab:next',
  TAB_PREV: 'tab:prev',
  TAB_CLOSE: 'tab:close',
  TAB_REOPEN: 'tab:reopen',
  WORKSPACE_OPEN_FOLDER: 'workspace:open-folder-command',
  WORKSPACE_TOGGLE_SIDEBAR: 'workspace:toggle-sidebar'
}
