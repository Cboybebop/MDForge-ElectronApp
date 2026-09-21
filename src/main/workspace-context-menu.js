// Native tree context menu + the one shared confirm-and-delete function
// (WORK-03, 07-UI-SPEC.md "Surface 2" and "Surface 5") -- this file is a
// TRIGGER, never a second implementation. showTreeContextMenu() only ever
// SENDS a 'workspace:context-action' payload to the renderer for New File
// and Rename, and for Delete too -- it deliberately does NOT call
// confirmAndDeleteEntry() inline from a menu click. This is CONTEXT.md's
// locked "same code path" requirement: the context menu's Delete item and
// the renderer's own Delete-key handler both end up calling
// window.mdforge.confirmAndDeleteEntry() themselves, converging on this
// file's one confirmAndDeleteEntry() export rather than each having its own
// route to it.
//
// confirmAndDeleteEntry() never calls fs.unlink/fs.rm directly -- it
// delegates to workspace-fileops.js's deleteWorkspaceEntry(), which is
// itself scoped by scripts/check-trash-not-unlink.mjs's fail-closed gate
// (07-02) to only ever reach trash.js's shell.trashItem. Nothing in this
// file needs its own gate coverage: it contains no filesystem-mutating call
// of its own.
//
// menu.js's item-mapper `commandId`-stripping landmine (07-06's own header
// comment, now seen in three variants) does NOT apply here: this file talks
// to Menu.buildFromTemplate() directly, with a plain template array built
// fresh on every popup (Pattern 4: rebuild, not mutate) -- there is no
// shared MENU_TEMPLATE array and no commandId field anywhere in this file's
// own template items, so there is nothing for that mapper to strip in the
// first place.
//
// dialog.showMessageBox's options object shape below mirrors dialogs.js's
// existing dialog:confirm-close-tab handler exactly (type/title/message/
// detail/buttons/defaultId/cancelId/noLink) -- same established idiom, new
// copy.
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { Menu, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { deleteWorkspaceEntry } from './workspace-fileops.js'

/**
 * Shows the Recycle-Bin-explicit delete confirmation (07-UI-SPEC.md
 * "Surface 5") for `targetPath`, then -- ONLY if the user chose "Move to
 * Recycle Bin" (response index 0) -- calls deleteWorkspaceEntry(targetPath)
 * and returns its {ok, error} result verbatim. Choosing Cancel (or closing
 * the dialog any other way) returns {canceled:true} without ever calling
 * deleteWorkspaceEntry -- no filesystem change occurs.
 *
 * The message AND the detail both name the Recycle Bin explicitly (UI-SPEC's
 * own binding rationale: a delete confirmation that doesn't say so reads as
 * permanent, and this one is not). defaultId:0 is the destructive-but-
 * reversible "Move to Recycle Bin" button, matching the real Windows
 * Explorer delete-confirmation convention.
 */
export async function confirmAndDeleteEntry (win, targetPath, isDirectory = false) {
  const name = path.basename(targetPath)
  const message = isDirectory
    ? `Move "${name}" and everything inside it to the Recycle Bin?`
    : `Move "${name}" to the Recycle Bin?`

  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: isDirectory ? 'Delete folder' : 'Delete file',
    message,
    detail: 'You can restore it from the Recycle Bin if this was a mistake.',
    buttons: ['Move to Recycle Bin', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })

  if (result.response !== 0) {
    return { canceled: true }
  }

  return deleteWorkspaceEntry(targetPath)
}

/**
 * Pops a native context menu for a tree row (or empty tree space) at
 * (x, y), per 07-UI-SPEC.md "Surface 2"'s row-type item table:
 *   - isRoot (empty tree space): New File only, creating at the workspace root.
 *   - isDirectory: New File, Rename, Delete, all enabled.
 *   - a file row: New File (disabled -- greyed out, not hidden), Rename, Delete.
 *
 * Every item's click sends 'workspace:context-action' to the renderer with
 * {action, path, isDirectory} and does nothing else -- New File and Rename
 * stop there; Delete ALSO only sends (deliberately never calling
 * confirmAndDeleteEntry from here), so the menu's Delete item and the
 * renderer's own Delete-key path converge on the identical
 * window.mdforge.confirmAndDeleteEntry() call in the renderer.
 */
export function showTreeContextMenu (win, { x, y, path: targetPath, isDirectory = false, isRoot = false }) {
  const send = (action) => win.webContents.send('workspace:context-action', { action, path: targetPath, isDirectory })

  let template
  if (isRoot) {
    template = [
      { label: 'New File', click: () => send('new-file') }
    ]
  } else if (isDirectory) {
    template = [
      { label: 'New File', click: () => send('new-file') },
      { label: 'Rename', click: () => send('rename') },
      { label: 'Delete', click: () => send('delete') }
    ]
  } else {
    template = [
      { label: 'New File', enabled: false, click: () => send('new-file') },
      { label: 'Rename', click: () => send('rename') },
      { label: 'Delete', click: () => send('delete') }
    ]
  }

  Menu.buildFromTemplate(template).popup({ window: win, x, y })
}

/**
 * Registers this file's renderer-facing IPC surface: a fire-and-forget
 * 'workspace:tree-context-menu' send (the native menu's own click handlers
 * produce their OWN later, asynchronous 'workspace:context-action' send --
 * this is not a request/response pair, so it is ipcMain.on, not
 * ipcMain.handle) and an invoke/handle pair for
 * 'workspace:confirm-and-delete', reached identically from the context
 * menu's Delete-click-triggered renderer call and the renderer's own
 * Delete-key handler.
 */
export function registerWorkspaceContextMenuIpc (win) {
  ipcMain.on('workspace:tree-context-menu', (_event, payload) => showTreeContextMenu(win, payload))
  ipcMain.handle('workspace:confirm-and-delete', (_event, targetPath, isDirectory) => confirmAndDeleteEntry(win, targetPath, isDirectory))
}
