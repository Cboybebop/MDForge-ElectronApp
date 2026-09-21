// Preview selection save/restore — ported from index.html:825-840
// (`savePreviewSelection`, `restorePreviewSelection`).
//
// PATTERNS.md Shared Pattern 3: `savedSelection` is private to this module —
// exported only via the two functions below, never as a raw binding. All
// call sites (format.js, toolbar.js's #btn-link handler, events.js's
// keyup/mouseup/focus listeners) only ever call these functions, never read
// the variable directly.

let savedSelection = null;

// Ports index.html:825-832 exactly.
export function savePreviewSelection() {
  const preview = document.getElementById('preview');
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (preview.contains(range.commonAncestorContainer)) {
    savedSelection = range.cloneRange();
  }
}

// Ports index.html:834-840, with one correction discovered by 03-06-PLAN.md's
// real-Chromium toolbar e2e spec (see below).
//
// [Rule 1 - Bug] `preview.focus()` on a not-currently-focused #preview (the
// common case here: callers reach this function right after a
// focus-stealing write into #md-input) fires #preview's own 'focus' event
// listener SYNCHRONOUSLY (preview/events.js: `preview.addEventListener
// ('focus', savePreviewSelection)`), which re-enters savePreviewSelection()
// and overwrites the SAME module-level `savedSelection` this function is
// about to read -- with whatever the live selection happens to be at that
// moment (verified, empirically: collapsed and empty, since moving focus to
// #md-input clears window.getSelection()'s prior #preview-anchored range).
// The original literal port read `savedSelection` only AFTER calling
// `.focus()`, so it always restored the JUST-clobbered value instead of the
// one the caller actually asked to restore. Capturing it into a local
// BEFORE calling `.focus()` closes this -- the local reference is immune to
// the focus event's own re-entrant save.
export function restorePreviewSelection() {
  const preview = document.getElementById('preview');
  const toRestore = savedSelection;
  preview.focus();
  if (!toRestore) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(toRestore);
}
