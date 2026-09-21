// Word clipboard export — ported from index.html:736-758 (`getWordHTML`)
// and 1121-1133 (`btnWord` click handler).

import { getCleanPreviewHTML } from '../markdown/back-convert.js';
import { copyRichContent } from './copy.js';
import { showStatus } from '../status.js';
import { flush } from '../markdown/sync-controller.js';
import { getActiveEditor, getActiveDocId } from '../documents.js';

// Ports index.html:736-758 verbatim. Already independent of `:root` tokens
// (hard-coded Calibri/Word inline <style>) — no change needed for New
// Surface 4's palette separation.
export function getWordHTML(fragment) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.35; color: #111; }
    h1, h2, h3, h4, h5, h6 { font-family: Calibri, Arial, sans-serif; font-weight: 700; margin: 12pt 0 6pt; }
    h1 { font-size: 20pt; }
    h2 { font-size: 16pt; }
    h3 { font-size: 13pt; }
    p { margin: 0 0 8pt; }
    pre { font-family: Consolas, monospace; font-size: 10pt; background: #f3f4f6; padding: 8pt; }
    code { font-family: Consolas, monospace; }
    blockquote { border-left: 3pt solid #9ca3af; margin: 8pt 0; padding-left: 10pt; color: #374151; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1pt solid #9ca3af; padding: 4pt 6pt; }
    th { background: #f3f4f6; font-weight: 700; }
  </style>
</head>
<body>${fragment}</body>
</html>`;
}

// Ports index.html:1121-1133, except `mdInput` is resolved PER-USE via
// getActiveEditor() (documents.js) rather than cached at module-load time
// -- a module-scope `document.getElementById('md-input')` would pin the
// bootstrap document's surface forever, even after the active document
// changes (05-CONTEXT.md; the exact "stale cache" bug class this migration
// closes).
const btnWord = document.getElementById('btn-copy-word');
const preview = document.getElementById('preview');

// flush() (03-04-PLAN.md) is the FIRST statement -- a pending debounced
// preview->left conversion must never be silently stale at the moment this
// handler reads getCleanPreviewHTML()/preview.innerText/the active
// editor's value (T-3-07).
//
// [05-REVIEW.md WR-01] flush() with no docId defaults to
// sync-controller.js's DEFAULT_DOC_ID, not the real active document --
// files/save.js's flush(docId) already threads the real docId explicitly.
// Without it, copying on a non-bootstrap document with a pending ~90ms
// debounced conversion could flush the WRONG (usually empty) document's
// pending work while still reading the real active document's content
// below, copying a payload stale by up to one debounce interval.
//
// [12-06] getActiveEditor() now returns the shared CM6 EditorView, not a
// textarea -- the old whole-document-string read becomes `state.doc.
// toString()`.
btnWord.addEventListener('click', async () => {
  flush(getActiveDocId());
  const cleanHTML = getCleanPreviewHTML();
  if (!cleanHTML.trim()) {
    showStatus('Nothing to copy', 'error');
    return;
  }
  await copyRichContent(
    getWordHTML(cleanHTML),
    preview.innerText.trim() || getActiveEditor().state.doc.toString(),
    'Copied for Word ✓',
    'Copied as plain text (limited browser support)'
  );
});
