// Status badge utility — ported from index.html:628, 634, 952-959.
//
// PATTERNS.md Shared Pattern 6: CONTEXT.md's named module list (markdown/, panes/,
// preview/, clipboard/, files/, theme/) has no explicit home for this. It is
// consumed cross-module by clipboard/*, files/*, and shortcuts.js (later plans),
// so it lives standalone at the top of src/renderer/.
//
// [05-09, revised 12-06] EDIT-04's #doc-count readout (below) deliberately
// does NOT import documents.js's getActiveEditor() to find the active
// Markdown-pane surface, even though that would be the obvious call.
// documents.js's own module-load-time initBootstrapDocument() call requires
// #md-input to already exist in the DOM -- importing it here would make
// status.js's own module-load a hard dependency on a DOM fixture, breaking
// status.test.js's plain-`node`-environment unit tests for the pure
// counting functions above. [12-06] Post-CM6 cutover, there is only ONE
// shared editor surface (the CM6 EditorView `cm-view.js` mounts once, never
// a per-document `.doc-surface` DOM node), so getActiveMarkdownView() below
// reads it via cm-view.js's own real, production-facing getSharedView()
// export -- preferred over reusing cm-view.js's `window.__cmView`
// test-only seam (12-01-PLAN.md Task 2), since a real export already exists
// and costs nothing extra to depend on. Unlike documents.js, cm-view.js has
// no module-load-time DOM-fixture requirement of its own (its cached CSP
// nonce read is `typeof document !== 'undefined'`-guarded and returns
// `undefined` harmlessly under status.test.js's DOM-less `node` environment)
// -- so this import preserves the exact same "safe under any environment"
// guarantee the original DOM-query approach had.
import { markdownToHtml } from './markdown/convert.js';
import { getSharedView } from './markdown/cm-view.js';

let statusTimer = null; // debounce for status badge auto-hide

// Ports index.html:952-959 exactly.
export function showStatus(msg, type = 'saved', duration = 2200) {
  clearTimeout(statusTimer);
  const statusBadge = document.getElementById('status-badge');
  statusBadge.textContent = msg;
  statusBadge.className = type; // 'saved' | 'copied' | 'error'
  statusTimer = setTimeout(() => {
    statusBadge.className = 'hidden';
  }, duration);
}

// ─── EDIT-04: #doc-count readout (05-UI-SPEC.md Surface 3) ────────────────
//
// Pure counting functions, deliberately markdown-agnostic. They count
// whatever text they are given -- the "counts derive from rendered PROSE,
// never raw Markdown syntax" guarantee is entirely a CALL-SITE
// responsibility (this module's own updateDocCount(), added alongside
// these functions, feeds them #preview.innerText -- never the raw
// Markdown source). Kept separate from any DOM-writing code so they stay
// independently unit-testable (status.test.js) without a DOM fixture.

// UI-SPEC's exact rule: `(text.match(/\S+/g) || []).length`.
export function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

// UI-SPEC's exact rule: `Array.from(text).length` after stripping `\r` --
// array spread (via Array.from's iterator-based construction) so an
// astral-plane character (e.g. an emoji) counts as 1, not 2 (jsdom/V8
// string .length counts UTF-16 code units, which would double-count a
// surrogate pair).
export function countChars(text) {
  return Array.from(text.replace(/\r/g, '')).length;
}

// UI-SPEC Copy contract: `{w} words · {c} chars` / `Selection: {w} words ·
// {c} chars`. `·` is U+00B7 MIDDLE DOT, single space either side. Thousands
// separators via toLocaleString().
export function formatDocCount(words, chars, isSelection) {
  return `${isSelection ? 'Selection: ' : ''}${words.toLocaleString()} words · ${chars.toLocaleString()} chars`;
}

// Debounce cadences. RENDER_DEBOUNCE_MS mirrors editor-events.js's own
// 60ms render-debounce constant (05-09-PLAN.md Task 2 instruction) -- kept
// as this module's own separate literal/timer rather than an import, since
// editor-events.js doesn't export it and this module has no reason to
// couple to that file just for a number. SELECTION_DEBOUNCE_MS is
// T-5-10's (threat model) mitigation for selectionchange firing at high
// frequency during a drag-select.
const DOC_COUNT_RENDER_DEBOUNCE_MS = 60;
const DOC_COUNT_SELECTION_DEBOUNCE_MS = 120;

let docCountRenderTimer = null; // debounce for #preview-mutation-triggered recompute
let docCountSelectionTimer = null; // debounce for selectionchange-triggered recompute

// Returns the single shared CM6 EditorView mounted into #md-input, or null
// before mountSharedView() has run. See this file's header comment for why
// this reads cm-view.js's own getSharedView() export rather than importing
// documents.js's getActiveEditor().
function getActiveMarkdownView() {
  return getSharedView();
}

// Returns #preview's own non-empty selection text, or null if there is no
// selection or it does not anchor inside #preview. UI-SPEC: "Selection
// inside #preview: count window.getSelection().toString() under the same
// rules."
function getPreviewSelectionText(previewEl) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!previewEl.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  return text === '' ? null : text;
}

// Returns the active Markdown-pane surface's own selected slice, converted
// to rendered prose via the existing markdownToHtml pipeline, or null if
// there is no selection there. UI-SPEC: "Selection inside the Markdown
// pane: run the selected Markdown slice through the existing
// markdownToHtml conversion and count the resulting prose. This keeps both
// panes on one definition of 'a word' -- without it, selecting the same
// sentence on the left and right would report different numbers."
//
// [12-06] The old textarea-offset-and-substring-slice reads become CM6's
// own `state.selection.main.{from,to}` and `state.doc.sliceString(from,
// to)` -- `Text.sliceString` is CM6's correct API for extracting a
// substring by offset without materialising the whole document first
// (relevant for large files).
function getMarkdownSelectionText() {
  const view = getActiveMarkdownView();
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const slice = view.state.doc.sliceString(from, to);
  if (!slice) return null;
  const { html } = markdownToHtml(slice);
  return renderedTextOf(html);
}

// Renders `html` into a temporarily document-attached container and reads
// its innerText -- the same block-boundary-respecting source
// updateDocCount() reads from the real #preview (UI-SPEC: "innerText, not
// textContent -- textContent concatenates a heading directly onto the
// following paragraph and silently merges two words into one"). Must be
// document-ATTACHED (not a detached node) for innerText to compute at all.
//
// [Rule 1 - Bug, found during this plan's own e2e verification] `visibility:
// hidden` was tried first and is WRONG -- verified empirically against the
// real pinned Chromium 150 runtime this app ships: a `visibility: hidden`
// element's own `innerText` returns the EMPTY STRING, not its rendered
// text (Chromium does not consider a `visibility: hidden` subtree "being
// rendered" for innerText's purposes, unlike what the CSSOM View spec's
// literal "has an associated layout box" wording would suggest). Moved
// off-screen via absolute positioning instead -- ordinary `visibility:
// visible` (the default), just outside the viewport -- which keeps the
// container out of sight without excluding it from innerText's rendered-
// text collection.
function renderedTextOf(html) {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.top = '-99999px';
  container.style.pointerEvents = 'none';
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    return typeof container.innerText === 'string' ? container.innerText : container.textContent;
  } finally {
    container.remove();
  }
}

// Recomputes and writes #doc-count's textContent. UI-SPEC: "the element is
// never hidden and never emptied -- 0 words · 0 chars is the empty state."
// Exported for the debounced wiring below and for direct calls (e.g. an
// immediate recompute right after wiring attaches).
export function updateDocCount() {
  const docCount = document.getElementById('doc-count');
  const previewEl = document.getElementById('preview');
  if (!docCount || !previewEl) return;

  const previewSelectionText = getPreviewSelectionText(previewEl);
  const markdownSelectionText = previewSelectionText === null ? getMarkdownSelectionText() : null;

  let text;
  let isSelection;
  if (previewSelectionText !== null) {
    text = previewSelectionText;
    isSelection = true;
  } else if (markdownSelectionText !== null) {
    text = markdownSelectionText;
    isSelection = true;
  } else {
    text = typeof previewEl.innerText === 'string' ? previewEl.innerText : previewEl.textContent;
    isSelection = false;
  }

  docCount.textContent = formatDocCount(countWords(text), countChars(text), isSelection);
}

function scheduleDocCountRenderUpdate() {
  clearTimeout(docCountRenderTimer);
  docCountRenderTimer = setTimeout(updateDocCount, DOC_COUNT_RENDER_DEBOUNCE_MS);
}

function scheduleDocCountSelectionUpdate() {
  clearTimeout(docCountSelectionTimer);
  docCountSelectionTimer = setTimeout(updateDocCount, DOC_COUNT_SELECTION_DEBOUNCE_MS);
}

// Self-wiring, matching this codebase's established convention (documents.js/
// find-bar.js/tab-bar.js each attach their own listeners at module-load
// time -- no central init() call). Guarded on #preview's existence
// (mirroring find-bar.js's own `if (tabBarEl) { ... }` guard) so importing
// this module in a test file with no full DOM fixture, or in this module's
// own `node`-environment status.test.js (no `document` global at all),
// never throws.
//
// #preview's content changes only via render.js's per-block DOM patch
// (renderMarkdown(), fired on editor-events.js's own 60ms
// RENDER_DEBOUNCE_MS tick) -- observing #preview's own childList/
// characterData mutations lets this recompute run in step with that same
// tick without this module importing editor-events.js or sync-controller.js
// directly.
if (typeof document !== 'undefined') {
  const previewEl = document.getElementById('preview');
  if (previewEl) {
    const previewObserver = new MutationObserver(scheduleDocCountRenderUpdate);
    previewObserver.observe(previewEl, { childList: true, subtree: true, characterData: true });

    // T-5-10 (threat model): selectionchange can fire at very high
    // frequency during a drag-select. Debounced at 120ms per UI-SPEC's
    // explicit cadence rule -- never a raw per-event handler, never a
    // setInterval.
    document.addEventListener('selectionchange', scheduleDocCountSelectionUpdate);

    updateDocCount();
  }
}
