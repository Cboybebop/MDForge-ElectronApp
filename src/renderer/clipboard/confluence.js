// Confluence clipboard export — ported from index.html:760-800
// (`fetchImageAsDataURL`, `getConfluenceClipboardPayload`) and 1111-1119
// (`btnConfluence` click handler).
//
// `fetchImageAsDataURL` is the ONE function in this phase whose
// implementation changes from a pure verbatim port, per 01-CONTEXT.md's
// locked "Loading, Protocol & Security Posture (O7)" decision resolving the
// `connect-src 'self'` CSP conflict with index.html:760's renderer-side
// `fetch()`. Remote (http/https) image fetches are now delegated to the
// main-process bridge (`window.mdforge.fetchImageAsDataUrl`, implemented in
// src/main/image-fetch.js per 01-02-PLAN.md) instead of a renderer
// `fetch()`/`AbortController`/`FileReader` chain. The 250ms per-image
// timeout now lives entirely inside that main-process handler, which
// already resolves to `null` on any failure (bad scheme, network error,
// non-OK response, timeout) — so this function's return contract (`data:`
// string on success, `null` on failure) is unchanged from the caller's
// perspective. No redundant renderer-side AbortController/timeout is added
// around the `ipcRenderer.invoke` call: `invoke` has no built-in
// cancellation and the timeout already lives correctly on the main-process
// side.
//
// `getConfluenceClipboardPayload`'s 450ms `Promise.race` total-budget
// orchestration is pure orchestration, not network access, and is ported
// UNCHANGED — it exists to keep the clipboard write inside the browser's
// click-activation window.

import { getCleanPreviewHTML } from '../markdown/back-convert.js';
import { copyRichContent } from './copy.js';
import { flush } from '../markdown/sync-controller.js';
import { getActiveEditor, getActiveDocId } from '../documents.js';

// Ports index.html:760-762 (data: short-circuit) unchanged; delegates the
// remote-fetch branch (index.html:763-780) to the main-process bridge.
export async function fetchImageAsDataURL(src) {
  if (!src) return null;
  if (src.startsWith('data:')) return src;
  return await window.mdforge.fetchImageAsDataUrl(src);
}

// Ports index.html:782-800 UNCHANGED.
export async function getConfluenceClipboardPayload(maxTotalWaitMs = 450) {
  const container = document.createElement('div');
  container.innerHTML = getCleanPreviewHTML();
  const images = [...container.querySelectorAll('img')];
  if (!images.length) return container.innerHTML.trim();

  const embedTask = Promise.all(images.map(async img => {
    const dataUrl = await fetchImageAsDataURL(img.getAttribute('src') || '');
    if (dataUrl) img.setAttribute('src', dataUrl);
  }));

  // Keep clipboard writes inside click activation window by bounding image embedding time.
  await Promise.race([
    embedTask,
    new Promise(resolve => setTimeout(resolve, maxTotalWaitMs)),
  ]);

  return container.innerHTML.trim();
}

// Ports index.html:1111-1119, except the editor's value is resolved
// PER-USE via getActiveEditor() (documents.js) rather than a module-scope
// `document.getElementById('md-input')` cached at import time -- see
// clipboard/word.js's identical migration note above.
const btnConfluence = document.getElementById('btn-copy-confluence');

// flush() (03-04-PLAN.md) is the FIRST statement -- a pending debounced
// preview->left conversion must never be silently stale at the moment this
// handler reads the active editor's value/getCleanPreviewHTML() (T-3-07).
//
// [05-REVIEW.md WR-01] flush() with no docId defaults to
// sync-controller.js's DEFAULT_DOC_ID, not the real active document -- see
// clipboard/word.js's identical fix note.
//
// [12-06] getActiveEditor() now returns the shared CM6 EditorView, not a
// textarea -- the old whole-document-string read becomes `state.doc.
// toString()`.
btnConfluence.addEventListener('click', async () => {
  flush(getActiveDocId());
  const htmlWithEmbeddedImages = await getConfluenceClipboardPayload();
  await copyRichContent(
    htmlWithEmbeddedImages,
    getActiveEditor().state.doc.toString(),
    'Copied for Confluence ✓',
    'Copied as plain text (limited browser support)'
  );
});
