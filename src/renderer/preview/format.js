// WYSIWYG formatting commands — ported from index.html:842-869
// (`runFormatCommand`, `getCurrentBlockTag`, `updateFormatState`).

import { savePreviewSelection, restorePreviewSelection } from './selection.js';
import { syncPreviewBlockToMarkdown } from '../markdown/back-convert.js';
import { beginWrite, endWrite } from '../markdown/sync-controller.js';
// [05-REVIEW.md CR-02] beginWrite('toolbar')/endWrite() used to omit an
// explicit docId, so they always tagged sync-controller.js's DEFAULT_DOC_ID
// (1) slot regardless of which document is actually active. On any
// non-bootstrap document, preview/events.js's PREVIEW_ECHO_ORIGINS check
// (`getActiveOrigin(docId)`, keyed by the REAL active docId) never saw the
// 'toolbar' tag this function sets, so the toolbar's own execCommand-driven
// `input` echo was mistaken for a genuine user edit and scheduled a second,
// redundant syncPreviewBlockToMarkdown('user-right') that could fire
// reentrantly inside this function's own call.
import { getActiveDocId } from '../documents.js';

// Ports index.html:842-848, updated per 03-04-PLAN.md: the post-command sync
// is now routed through the SAME range-based splice mechanism ordinary
// preview typing uses (back-convert.js's syncPreviewBlockToMarkdown),
// tagged with the distinct 'toolbar' origin for provenance -- NOT the
// whole-document syncPreviewToMarkdown(). A whole-document pass would
// unconditionally reapply every accepted-normalisations.md entry anywhere
// in the document on every single toolbar click (03-CONTEXT.md
// "Planning-Time Amendments"), which is exactly the defect this routing
// closes. syncPreviewBlockToMarkdown() performs its OWN internal
// savePreviewSelection()/restorePreviewSelection() around its focus-stealing
// textarea write -- redundant but harmless alongside the savePreviewSelection()
// call below, since both capture the same already-correct post-command
// selection state.
//
// [Rule 1 - Bug, discovered by 03-06-PLAN.md's real-Chromium toolbar e2e
// spec] `document.execCommand(command, ...)` mutates the LIVE #preview DOM
// and therefore fires a genuine native `input` event on #preview
// synchronously, exactly like real typing does -- jsdom's stubbed
// execCommand (03-04's own tests) never dispatches this, so the gap was
// invisible there. Without the beginWrite('toolbar')/endWrite() bracket
// below, preview/events.js's own `input` listener (which has no per-origin
// echo check, unlike editor-events.js's ECHO_ORIGINS guard for #md-input)
// sees this as an ordinary user-right edit and schedules a SECOND,
// redundant `syncPreviewBlockToMarkdown('user-right')` 90ms later. That
// second sync then fires REENTRANTLY inside THIS function's own
// syncPreviewBlockToMarkdown('toolbar') call, because
// preview/events.js's `blur` listener calls flush() synchronously the
// moment syncPreviewBlockToMarkdown('toolbar') steals focus to #md-input --
// and the reentrant call's own selection save/restore corrupts the
// selection this function's caller (the toolbar click handler) needs
// intact afterward. Bracketing the execCommand call lets
// preview/events.js's listener recognise and skip its own echo, exactly as
// editor-events.js already does for #md-input.
export function runFormatCommand(command, value = null) {
  const docId = getActiveDocId();
  restorePreviewSelection();
  beginWrite('toolbar', docId);
  try {
    document.execCommand(command, false, value);
  } finally {
    endWrite(docId);
  }
  savePreviewSelection();
  syncPreviewBlockToMarkdown('toolbar');
  updateFormatState();
}

// Deviation from index.html:850-858 (previously ported verbatim): Phase 2
// (CONV-08, 02-CONTEXT.md's "Toolbar Command Resolution") deliberately
// diverges from the strict port from here on. The original selector --
// 'h1,h2,h3,h4,blockquote,pre,p,li' -- has no case for h5, h6, td, or th, so
// a caret in any of those silently falls back to 'P'. A toolbar that
// misreports the current block is how a user triggers a destructive
// command in the first place (e.g. running
// formatBlock while the toolbar thinks the caret is in a paragraph, when it
// is actually in a table cell). Extended to h1-h6,blockquote,pre,p,li,td,th.
// closest() already walks up from the anchor node to the NEAREST matching
// ancestor, so a caret in the innermost <li> of a nested list resolves
// correctly with no additional code beyond this selector extension --
// verified with a dedicated nested-list test in format.test.js rather than
// assumed (02-PATTERNS.md's explicit caution).
export function getCurrentBlockTag() {
  const preview = document.getElementById('preview');
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 'P';
  let node = selection.anchorNode;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const block = node?.closest?.('h1,h2,h3,h4,h5,h6,blockquote,pre,p,li,td,th');
  if (!block || !preview.contains(block)) return 'P';
  return block.tagName;
}

// Ports index.html:860-869 exactly.
export function updateFormatState() {
  ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(command => {
    const button = document.querySelector(`.format-btn[data-command="${command}"]`);
    if (!button) return;
    button.classList.toggle('active', document.queryCommandState(command));
  });

  const formatBlock = document.getElementById('format-block');
  const currentTag = getCurrentBlockTag();
  formatBlock.value = [...formatBlock.options].some(option => option.value === currentTag) ? currentTag : 'P';
}
