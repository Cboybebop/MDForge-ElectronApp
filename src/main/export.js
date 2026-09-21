// PDF + standalone-HTML export (EXPT-03, EXPT-04, EXPT-05).
//
// PDF is produced by loading the composed export HTML into a hidden,
// security-flagged BrowserWindow and calling webContents.printToPDF() --
// never by printing the LIVE renderer, which carries the app's theme,
// editor chrome and split panes (04-CONTEXT.md "Export: PDF, Standalone
// HTML, and the Zero-Network Question"). The hidden window is constructed
// with the same four explicit security flags src/main/window.js's real
// window uses, but gets NO `preload` at all -- it renders static,
// already-composed HTML, not the app UI, so it needs no contextBridge
// surface.
//
// The export window's CSP lives ENTIRELY in an in-document
// `<meta http-equiv="Content-Security-Policy">` tag injected into the
// composed HTML before it is loaded as a data: URL -- never a change to
// src/main/protocol.js's PROD_CSP, which continues to govern only the main
// renderer unchanged (T-4-18). `img-src data:` ONLY (CR-01 fix, 04-REVIEW.md):
// by the time HTML reaches this module, src/renderer/files/export.js's
// embedRemoteImages() guarantees every <img> is either a data: URI or has
// already been replaced with an inert text placeholder -- never a live
// http(s) src. This window must therefore never need, and must never be
// ABLE, to make its own network request; widening img-src to https:/http:
// was exactly what let the hidden PDF window bypass image-fetch.js's SSRF
// guard for a URL the guard had deliberately rejected.
//
// Every function below returns a structured {error: {message, code}} on
// failure, never a bare throw/catch{} -- same "never discard the error
// object" discipline as atomic-write.js/text-file.js.
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { atomicWrite } from './atomic-write.js'
import { isSafeFilePath } from './path-guard.js'

const EXPORT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

// Injects the export-window CSP meta tag into `html`'s <head> -- creating a
// minimal <head> first if the composed document doesn't already have one.
// Never touches src/main/protocol.js's PROD_CSP.
function withCsp (html) {
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${metaTag}`)
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${metaTag}</head>`)
  }
  return `<head>${metaTag}</head>${html}`
}

// Same explicit-security-flags discipline as src/main/window.js's real
// window (01-CONTEXT.md "Loading, Protocol & Security Posture (O7)"),
// deliberately with `show: false` and no `preload` key -- this window never
// renders the app UI, only a static composed document.
function createExportWindow () {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
}

/**
 * Renders `html` in a hidden, security-flagged BrowserWindow and writes the
 * resulting PDF buffer to a user-chosen destination via a save dialog.
 * Returns {path} on success, null if the user cancels the dialog, or
 * {error: {message, code}} on any failure. The export window is always
 * destroyed on completion, success or failure (04-PATTERNS.md's export.js
 * section: no existing BrowserWindow-teardown precedent in this codebase,
 * so this follows the general listener/lifecycle-cleanup discipline
 * theme-store.js already establishes).
 */
async function exportPdf (win, html) {
  const dialogResult = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (dialogResult.canceled || !dialogResult.filePath) return null

  // IN-02 (04-REVIEW.md): re-validate via isSafeFilePath, for consistency
  // with dialogs.js/text-file.js's own stated "regardless of caller"
  // defense-in-depth policy. Harmless in practice today -- filePath always
  // comes from a trusted native dialog.showSaveDialog result -- but this
  // would become load-bearing if exportPdf/exportHtml is ever called with a
  // non-dialog-sourced path.
  if (!isSafeFilePath(dialogResult.filePath)) {
    return { error: { message: `Refusing to export to unsafe path: ${dialogResult.filePath}`, code: 'EINVALIDPATH' } }
  }

  const exportWin = createExportWindow()
  try {
    const htmlWithCsp = withCsp(html)

    const loaded = new Promise((resolve, reject) => {
      exportWin.webContents.once('did-finish-load', resolve)
      exportWin.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
        reject(new Error(`Export window failed to load: ${errorDescription} (${errorCode})`))
      })
    })
    exportWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlWithCsp))
    await loaded

    const pdfBuffer = await exportWin.webContents.printToPDF({})
    await atomicWrite(dialogResult.filePath, pdfBuffer)
    return { path: dialogResult.filePath }
  } catch (err) {
    return { error: { message: err.message, code: err.code } }
  } finally {
    exportWin.destroy()
  }
}

/**
 * Writes the already-composed, self-contained `html` string directly to a
 * user-chosen destination via a save dialog. No hidden window is needed for
 * this case -- unlike PDF, writing an HTML file has no printToPDF
 * requirement. Returns {path} on success, null if the user cancels, or
 * {error: {message, code}} on failure.
 */
async function exportHtml (win, html) {
  const dialogResult = await dialog.showSaveDialog(win, {
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (dialogResult.canceled || !dialogResult.filePath) return null

  // IN-02 (04-REVIEW.md): see exportPdf's identical check above.
  if (!isSafeFilePath(dialogResult.filePath)) {
    return { error: { message: `Refusing to export to unsafe path: ${dialogResult.filePath}`, code: 'EINVALIDPATH' } }
  }

  try {
    await atomicWrite(dialogResult.filePath, html)
    return { path: dialogResult.filePath }
  } catch (err) {
    return { error: { message: err.message, code: err.code } }
  }
}

function registerExportIpc (win) {
  ipcMain.handle('export:pdf', (_event, html) => exportPdf(win, html))
  ipcMain.handle('export:html', (_event, html) => exportHtml(win, html))
}

export { exportPdf, exportHtml, registerExportIpc }
