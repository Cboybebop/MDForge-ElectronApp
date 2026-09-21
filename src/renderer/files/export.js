// Export subsystem (EXPT-03/EXPT-04) -- composes a fully self-contained,
// EXPORT_PALETTE-styled HTML document from the flushed preview state, then
// hands it to the main process (src/main/export.js) for either a real PDF
// (via a hidden BrowserWindow + printToPDF) or a standalone .html file.
//
// This is EXPORT_PALETTE's first real consumer -- see clipboard/export-
// palette.js's own header comment ("Phase 4 is what finally wires it up").
// Every colour value in the composed <style> block below comes from
// EXPORT_PALETTE, never a live CSS custom property or the app's own theme
// stylesheet -- a dark-mode user must still get light-styled export output
// (04-CONTEXT.md, locked decision).
//
// flush(getActiveDocId()) is the FIRST statement of composeExportHtml(),
// the same discipline clipboard/confluence.js and word.js already use -- a
// pending debounced preview<->left conversion must never be silently stale
// at the moment export composition reads #preview's DOM (T-3-07's export
// analog).
//
// [05-REVIEW.md WR-01 / 05-VERIFICATION.md Gap 1] flush() with no docId
// defaults to sync-controller.js's DEFAULT_DOC_ID, not the real active
// document -- clipboard/word.js and clipboard/confluence.js were fixed to
// call flush(getActiveDocId()) during this same review round, but this file
// was missed. Without it, exporting on a non-bootstrap document with a
// pending ~60ms debounced render could flush the WRONG (usually empty)
// document's pending work while still reading the real active document's
// #preview state below, composing export output stale by up to one
// debounce interval.
//
// Remote (http/https) images are embedded as data: URIs via the SAME
// main-process image-fetch.js bridge confluence.js already uses. Unlike
// confluence.js's clipboard payload, a failed embed here must NEVER leave
// the original http(s) src in place (CR-01, 04-REVIEW.md): the hidden
// PDF-export BrowserWindow would load that src directly, bypassing
// image-fetch.js's SSRF guard for exactly the URL it just rejected, and a
// standalone HTML export would ship a live external reference, violating
// the locked "fully self-contained, no external references of any kind"
// requirement (04-CONTEXT.md). An image the bridge cannot resolve (blocked
// scheme, SSRF-guarded host, timeout, non-image response) is instead
// replaced with a visible inert text placeholder -- the failure is surfaced
// to the user rather than silently dropped or silently left live. This must
// never throw.
import { getCleanPreviewHTML } from '../markdown/back-convert.js';
import { flush } from '../markdown/sync-controller.js';
import { EXPORT_PALETTE } from '../clipboard/export-palette.js';
import { showStatus } from '../status.js';
import { registerCommand } from '../command-dispatch.js';
import { COMMAND_IDS } from '../../shared/command-ids.js';
import { getActiveDocId } from '../documents.js';

// Embeds every non-data: <img src> as a data: URI via the existing
// image-fetch.js bridge (window.mdforge.fetchImageAsDataUrl). An image the
// bridge cannot resolve is replaced with an inert text placeholder rather
// than kept as a live http(s) src -- see the header comment above (CR-01).
async function embedRemoteImages(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  const images = [...container.querySelectorAll('img')];

  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('data:')) return;

      const dataUrl = await window.mdforge.fetchImageAsDataUrl(src);
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
        return;
      }

      // The bridge could not embed this image. A live http(s) src must
      // never survive into the composed export HTML (see header comment,
      // CR-01) -- replace the <img> with a visible placeholder instead of
      // leaving a dangling external reference or silently vanishing it.
      const placeholder = document.createElement('span');
      placeholder.className = 'mdforge-export-image-placeholder';
      placeholder.textContent = `[Image not embedded: could not fetch "${src}"]`;
      img.replaceWith(placeholder);
    })
  );

  return container.innerHTML;
}

// Builds the full standalone document. Every colour value below is drawn
// from EXPORT_PALETTE -- never a CSS custom property, never the theme sheet --
// so the output is byte-for-byte independent of the app's current theme
// (dark mode included).
function buildStandaloneDocument(bodyHtml) {
  const css = `
    body { background: ${EXPORT_PALETTE.bg}; color: ${EXPORT_PALETTE.text}; font-family: sans-serif; line-height: 1.5; padding: 2em; }
    a { color: ${EXPORT_PALETTE.accent}; }
    a:hover { color: ${EXPORT_PALETTE.accentDim}; }
    h1, h2, h3, h4, h5, h6 { color: ${EXPORT_PALETTE.textBright}; }
    strong, b { color: ${EXPORT_PALETTE.textEm}; }
    blockquote { border-left: 3px solid ${EXPORT_PALETTE.border}; color: ${EXPORT_PALETTE.textQuote}; margin: 1em 0; padding-left: 1em; }
    pre, code { background: ${EXPORT_PALETTE.surface}; border: 1px solid ${EXPORT_PALETTE.border}; color: ${EXPORT_PALETTE.text}; }
    pre { padding: 1em; overflow-x: auto; }
    code { padding: 0.15em 0.35em; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid ${EXPORT_PALETTE.border}; padding: 0.4em 0.6em; }
    th { background: ${EXPORT_PALETTE.surface}; color: ${EXPORT_PALETTE.textBright}; }
    hr { border: none; border-top: 1px solid ${EXPORT_PALETTE.border}; }
  `;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${bodyHtml}</body></html>`;
}

// flush(getActiveDocId()) first, always -- a pending debounce must never
// leave export composing against stale preview/left-pane state for
// whichever document is actually active (05-VERIFICATION.md Gap 1).
export async function composeExportHtml() {
  flush(getActiveDocId());
  const embedded = await embedRemoteImages(getCleanPreviewHTML());
  return buildStandaloneDocument(embedded);
}

export async function exportPdf() {
  const html = await composeExportHtml();
  const result = await window.mdforge.exportPdf(html);
  if (!result) return; // user canceled the save dialog
  if (result.error) {
    showStatus(`Export failed: ${result.error.message}`, 'error');
    return;
  }
  showStatus('Exported to PDF ✓', 'saved');
}

export async function exportHtml() {
  const html = await composeExportHtml();
  const result = await window.mdforge.exportHtml(html);
  if (!result) return; // user canceled the save dialog
  if (result.error) {
    showStatus(`Export failed: ${result.error.message}`, 'error');
    return;
  }
  showStatus('Exported to HTML ✓', 'saved');
}

// Self-wiring at module load time, matching every other command-registering
// module in this phase (open.js/save.js/new.js) -- command-dispatch.js is
// the single dispatch path for both native Menu accelerators and any
// remaining UI action.
registerCommand(COMMAND_IDS.FILE_EXPORT_PDF, exportPdf);
registerCommand(COMMAND_IDS.FILE_EXPORT_HTML, exportHtml);
