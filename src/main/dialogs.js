// Native open/save dialogs + reveal-in-Explorer (SHELL-02, SHELL-09).
//
// Follows the registerXIpc(win) shape established by theme-store.js's
// registerThemeIpc(win) and image-fetch.js's registerImageFetchIpc() --
// `win` is passed explicitly as a parameter, never captured as a module-
// level global (same discipline theme-store.js and security.js's
// hardenWindow(win) already use).
//
// dialog.showOpenDialog/showSaveDialog results are OS-chosen, inherently
// trusted paths -- but readTextFile/writeTextFileChecked still re-validate
// every path internally via isSafeFilePath regardless of caller, which is
// harmless defense-in-depth (04-02-PLAN.md threat T-4-05).
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { dialog, shell, ipcMain } from 'electron'
import path from 'node:path'
import fsPromises from 'node:fs/promises'
import { readTextFile, writeTextFileChecked, getRecordedStat, recordStat } from './text-file.js'
import { isSafeFilePath } from './path-guard.js'

const MARKDOWN_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]

// T-5-12 (05-12-PLAN.md threat_model): docName crosses the IPC trust
// boundary from renderer to main, which builds this dialog's visible
// message text from it. Coerced to a safe string here -- never trusted as
// already-a-string, matching this file's own established discipline of
// re-validating renderer-supplied data regardless of caller trust.
function coerceDocName (docName) {
  return typeof docName === 'string' && docName.length > 0 ? docName : String(docName ?? 'this document')
}

function registerDialogsIpc (win) {
  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: MARKDOWN_FILTER
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readTextFile(result.filePaths[0])
  })

  ipcMain.handle('dialog:save-file-as', async (_event, content, suggestedName) => {
    // [07-09] `suggestedName` is the Save As Copy banner button's own
    // computed sibling filename (basename + " (copy)" + extension) --
    // never a renderer-controlled override of the actual SAVE
    // DESTINATION, only a pre-fill hint the user still confirms through
    // the real native dialog (T-7-14). Omitted entirely (not passed as an
    // empty string) when absent, preserving today's exact dialog options
    // for every caller that doesn't pass one.
    const dialogOptions = {
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    if (typeof suggestedName === 'string' && suggestedName.length > 0) {
      dialogOptions.defaultPath = suggestedName
    }

    const result = await dialog.showSaveDialog(win, dialogOptions)
    if (result.canceled || !result.filePath) return null

    // WR-05 (04-REVIEW.md): force:true is only correct when this exact path
    // has NEVER been recorded by text-file.js in this running process. That
    // is usually true for a genuinely novel Save-As destination, but
    // openFileStats persists for the process's whole lifetime across
    // File > New and any number of documents -- if the user opened this
    // path earlier in the session (or saved to it), then did File > New,
    // then chose Save As... and picked the SAME path again, force:true
    // would silently skip the conflict check and overwrite a file that may
    // have changed externally in the meantime. Only force past the check
    // for a path with no prior recorded stat; otherwise run the same
    // checked write a normal Save would.
    const force = !getRecordedStat(result.filePath)
    const writeResult = await writeTextFileChecked(result.filePath, content, force)

    if (writeResult.conflict) {
      return { conflict: true, path: result.filePath, actual: writeResult.actual }
    }
    if (!writeResult.ok) return { error: writeResult.error }

    return {
      path: result.filePath,
      name: path.basename(result.filePath),
      mtimeMs: writeResult.mtimeMs,
      size: writeResult.size
    }
  })

  // [07-09] Keep Mine's own IPC ack: advances text-file.js's recorded-stat
  // baseline for `filePath` so the SAME external revision the user just
  // chose to keep is never re-flagged by a later watcher-driven re-stat --
  // never reads or writes the document's own content. `isSafeFilePath` is
  // re-validated here too, per this file's own established discipline
  // ("re-validates every path internally... regardless of caller trust")
  // -- `filePath` originates from a currently-open document's own
  // filePath field (already validated on the way in via openAtPath/
  // saveFileAs), but this handler re-checks it anyway rather than trusting
  // that provenance.
  ipcMain.handle('workspace:acknowledge-external-change', async (_event, filePath) => {
    if (!isSafeFilePath(filePath)) {
      return { ok: false, error: { message: `Refusing to acknowledge unsafe path: ${filePath}`, code: 'EINVALIDPATH' } }
    }
    try {
      const stat = await fsPromises.stat(filePath)
      recordStat(filePath, stat)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: { message: err.message, code: err.code } }
    }
  })

  // DOC-04's derived single-tab close prompt (05-UI-SPEC.md Surface 5,
  // "Single-document close prompt") -- mechanical extension of this same
  // registerDialogsIpc(win) pattern, same `win`-as-explicit-parameter
  // discipline as dialog:save-file-as above. Fired by tab-bar.js's
  // closeTab() before closing a DIRTY document via X/Ctrl+W/middle-click.
  ipcMain.handle('dialog:confirm-close-tab', async (_event, docName) => {
    const name = coerceDocName(docName)
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Unsaved changes',
      message: `Save changes to ${name} before closing?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    return ['save', 'dont-save', 'cancel'][result.response]
  })

  ipcMain.handle('shell:reveal-in-explorer', (_event, filePath) => {
    // WR-03 (04-REVIEW.md): this handler was the one exception to this
    // file's own stated policy of re-validating every path via
    // isSafeFilePath "regardless of caller". The preload bridge exposes
    // revealInExplorer(filePath) as a general-purpose method taking an
    // arbitrary string -- nothing else at the IPC boundary stops a
    // compromised or buggy renderer from invoking it with any value.
    if (!isSafeFilePath(filePath)) return
    shell.showItemInFolder(filePath)
  })
}

export { registerDialogsIpc }
