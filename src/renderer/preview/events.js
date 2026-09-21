// Preview pane event wiring — ported from index.html:1188-1208
// (preview `input`/`keyup`/`mouseup`/`focus`/`scroll`), rewritten per
// 03-04-PLAN.md Task 2: the `input` listener's inline debounce is replaced
// by sync-controller.js's scheduleFlush(), gated on IME composition, and a
// `blur` listener now calls flush() so a pending debounced conversion is
// never silently stale (03-CONTEXT.md's "flush() is called ... on preview
// blur" rule; T-3-07 in this plan's threat model).
//
// 03-05-PLAN.md Task 1 adds two more listeners here (`paste`, and a `keydown`
// branch for Ctrl+Shift+V): CONV-09's clipboard HTML -> DOMPurify ->
// htmlToMarkdown -> markdownToHtml -> insert round trip, plus a byte-size DoS
// guard (T-3-03) checked BEFORE either conversion call ever sees the payload.
// Both handlers insert via execCommand (never a manual Range mutation) so
// undo survives, and both explicitly sync the WHOLE document into #md-input
// synchronously in the same handler -- a pasted fragment can span multiple
// top-level blocks, and the generic per-block `input` listener below only
// resolves ONE anchor block, which would silently leave the other
// newly-inserted blocks un-synced. This is the RESEARCH.md-sanctioned
// exception to "never call the whole-document path from a per-keystroke
// path": paste is one-time and user-initiated, not per-keystroke.
//
// [Rule 1 - Bug] The whole-document sync is done via
// `applyUndoSafeInsertion()` below, NOT by calling back-convert.js's
// `syncPreviewToMarkdown(origin)` directly as originally planned --
// verified, empirically, against this pinned runtime, that calling it AFTER
// the live #preview insertion destroys the very undo entry criterion 4
// requires (any focus change away from a contenteditable and back discards
// its undo history in this Chromium build). See `applyUndoSafeInsertion`'s
// own header comment below for the full mechanism and evidence.
//
// Note on the `scroll` listener: `src/renderer/panes/scroll-sync.js` (01-04)
// already wires both `mdInput`'s and `preview`'s scroll listeners at module
// load, per its Shared-Pattern-4 decision to keep both directions' wiring
// together with the single `isSyncingScroll` guard. This file's `scroll`
// listener below is ported per 01-06-PLAN.md's explicit task spec (matching
// index.html:1206-1208 verbatim) and is therefore a second registration of
// the same handler once `scroll-sync.js` is also imported by `main.js`
// (01-08). This is harmless: `syncPaneScroll`'s `isSyncingScroll` guard is
// set synchronously on the first invocation within the same event tick, so
// the second listener's call is a no-op early return, not a double-apply.
// Documented as a known, functionally-inert duplicate rather than silently
// dropped, so it can be cleaned up (single wiring site) in a later pass.

import DOMPurify from 'dompurify';
import { syncPreviewBlockToMarkdown } from '../markdown/back-convert.js';
import { htmlToMarkdown, markdownToHtml } from '../markdown/convert.js';
import { renderWithSourceMap } from '../markdown/source-map.js';
// [12-05] dispatchAppWrite is the SOLE write mechanism for
// syncScratchResultToMarkdown() below -- see that function's own updated
// header comment for why savePreviewSelection/restorePreviewSelection (still
// imported here for the OTHER listeners in this file, e.g. keyup/mouseup/
// focus, which are untouched) are no longer called around that one write.
import { dispatchAppWrite } from '../markdown/cm-dispatch.js';
import { savePreviewSelection, restorePreviewSelection } from './selection.js';
import { updateFormatState } from './format.js';
import { syncPaneScroll } from '../panes/scroll-sync.js';
import {
  scheduleFlush,
  flush,
  beginWrite,
  endWrite,
  getActiveOrigin,
  getFrontMatter,
  setDocumentBody,
  setDocumentBlocks,
  setFrontMatter,
  recordApplied,
} from '../markdown/sync-controller.js';
import { createCompositionGate } from '../markdown/composition-gate.js';
import { showStatus } from '../status.js';
// 05-03: the former single-document dirty singleton is replaced outright
// by markDocumentDirty(docId) (documents.js) -- this file's only dirty-
// marking call site is the paste/Ctrl+Shift+V whole-document fallback
// (syncScratchResultToMarkdown). getActiveEditor()/getActiveDocId() resolve the ACTIVE
// document's surface/docId at the exact point of use in every call site
// below, never cached at module scope (05-CONTEXT.md; T-5-03) -- #preview
// itself and its composition gate stay a SINGLE shared instance, untouched,
// since only the raw-Markdown surface is per-document.
import { getActiveEditor, getActiveDocId, markDocumentDirty } from '../documents.js';

const preview = document.getElementById('preview');

// Independent per-pane composition state -- this instance is #preview's
// own, never shared with #md-input's (editor-events.js's leftGate;
// composition-gate.js's own header comment: composing in one pane must
// never gate sync in the other).
const previewGate = createCompositionGate();

// CONFIRMED unchanged at 03-06-PLAN.md Task 3, against real measurement:
// the 250ms whole-document-calibrated convert debounce 03-04 replaced was
// oversized for per-block splicing (turndownBlock() costs ~0.06ms vs.
// htmlToMarkdown()'s 55-320ms) -- 90ms is the midpoint of 03-RESEARCH.md's
// recommended ~80-100ms range. Measured directly against
// syncPreviewBlockToMarkdown('user-right') (the real, wired entry point,
// including this plan's own normalisedForm() anchor-search fix) on
// tests/fixtures/sync/200-line-doc.md: median 2.2ms / max 3.0ms across 12
// repeated same-shape edits -- comfortably under 5% of this 90ms budget.
// On tests/fixtures/corpus/real-roadmap.md (275 lines, standing in for a
// larger real document): median 6.4ms / max 19.1ms -- still comfortably
// under 25% of budget even at its noisiest. Both figures sit far inside
// the "under ~50% of the budget" confirmation bar 03-06-PLAN.md's own
// task text sets, so the constant is left unchanged. See this plan's own
// SUMMARY.md for the full measurement record and reasoning.
const CONVERT_DEBOUNCE_MS = 90;

// 03-RESEARCH.md's Security Domain table flags this gap explicitly: a
// multi-megabyte base64-embedded image from a browser copy is a real DoS
// vector, and it is NOT covered by 03-CONTEXT.md's locked paste decision as
// written. ~1MB is a round, documented, conservative ceiling -- comfortably
// above any realistic pasted document, well below "freeze the UI". Checked
// BEFORE DOMPurify/Turndown ever see the payload in both handlers below.
const MAX_PASTE_BYTES = 1_000_000;

// Local helper -- no `escapeHtml` exists elsewhere in this codebase (grepped
// first, per this task's own read_first instruction). DOM-based rather than
// a hand-rolled regex so it can never miss an HTML metacharacter.
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Byte length (not JS string .length, which counts UTF-16 code units) --
// the DoS-relevant quantity is the payload's actual size, matching
// RESEARCH.md's "byte threshold" framing.
function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

// --- Undo-safe paste/Ctrl+Shift+V insertion -------------------------------
//
// [Rule 1 - Bug, discovered verifying this task's own undo criterion via
// tests/e2e/paste-sanitise.spec.js against the real pinned Electron 43.4.0
// runtime] The plan's literal instruction sequence -- execCommand the
// insertion into the LIVE #preview first, then call the whole-document
// syncPreviewToMarkdown(origin) (which internally focuses #md-input to
// write, then refocuses #preview) -- destroys the very undo entry criterion
// 4 requires. Empirically verified (three independent diagnostics against
// this runtime): ANY focus change away from a contenteditable element and
// back, even with zero execCommand calls on the element that stole focus,
// silently discards that contenteditable's undo history. This is a genuine
// interaction defect between 03-04's already-shipped syncPreviewToMarkdown
// (built after 03-05's own research, which verified execCommand('undo')
// in isolation, never combined with 03-04's focus-stealing write) and this
// plan's own undo requirement -- not something either plan could have
// caught independently.
//
// Fix: the LIVE execCommand insertion into #preview must be the ABSOLUTE
// LAST focus-touching operation in the handler, with nothing after it that
// blurs #preview. That means the #md-input whole-document write (which
// necessarily steals focus to #md-input) must happen BEFORE the live
// #preview insertion -- which in turn means the resulting full-document
// HTML must be computed WITHOUT having performed the live insertion yet.
//
// This is done via a detached, off-screen, briefly-focused contenteditable
// "scratch" clone of #preview: the REAL execCommand is run on it (a manual
// Range.insertNode()-based simulation was verified, empirically, to place
// content differently than execCommand at a block boundary -- e.g. as a
// new sibling instead of appending inside the preceding block -- so only
// running the real command reproduces Chromium's actual placement logic).
// Because the scratch element starts from an identical innerHTML and an
// identical (path-mapped) selection, its result is verified byte-identical
// to what the same execCommand produces on the live element.
//
// The resulting bookkeeping/#md-input write below mirrors back-convert.js's
// syncPreviewToMarkdown(origin) exactly (same primitives, same origin tag,
// same idempotence check) -- it is not a new mechanism, only reordered and
// fed from the scratch-computed HTML instead of a live-DOM read, since the
// live #preview has not been mutated at the point this write happens.

function pathFromRoot(root, node) {
  const path = [];
  let cur = node;
  while (cur !== root) {
    const parent = cur.parentNode;
    path.unshift(Array.from(parent.childNodes).indexOf(cur));
    cur = parent;
  }
  return path;
}

function resolvePath(root, path) {
  let cur = root;
  for (const idx of path) cur = cur.childNodes[idx];
  return cur;
}

// Runs `applyCommand` (an execCommand call) against an off-screen clone of
// `preview` sharing `preview`'s CURRENT innerHTML and an equivalent
// (path-mapped) selection, and returns the clone's resulting innerHTML.
//
// [Rule 1 - Bug, discovered verifying this task's own undo test] Focusing
// the scratch element and moving `window.getSelection()` onto it -- then
// removing the scratch from the document -- leaves the page's ONE shared
// Selection object pointing at a now-detached node. Refocusing `previewEl`
// afterward (as the caller's own savePreviewSelection()/restorePreviewSelection()
// dance does) then finds no valid range inside `previewEl` to save, and
// Chromium's `.focus()` with no explicit Range set defaults the caret to
// offset 0 -- silently relocating every subsequent insertion to the START
// of the document instead of the original caret position. Restoring the
// LIVE selection to the ORIGINAL (pre-insertion) position before returning,
// every time, closes this -- the caller always receives `previewEl`
// focused with its real original selection intact.
function computeResultViaScratch(previewEl, selection, applyCommand) {
  const anchorPath = pathFromRoot(previewEl, selection.anchorNode);
  const anchorOffset = selection.anchorOffset;
  const focusPath = pathFromRoot(previewEl, selection.focusNode);
  const focusOffset = selection.focusOffset;

  // [Rule 1 - Bug] Off-screen positioning via `.style.position/left/top =`
  // was verified BLOCKED by this app's own `style-src 'self'` CSP (no
  // 'unsafe-inline') -- Chromium enforces CSP against JS-driven `.style`
  // writes, not only HTML `style=""` attributes. `.paste-scratch`
  // (preview.css) is the CSP-compliant equivalent.
  const scratch = document.createElement('div');
  scratch.contentEditable = 'true';
  scratch.classList.add('paste-scratch');
  scratch.innerHTML = previewEl.innerHTML;
  document.body.appendChild(scratch);

  let resultHtml;
  try {
    // 03-REVIEW.md IN-02: this runs on every paste against an off-screen
    // clone. Without { preventScroll: true }, focusing it can make the
    // browser scroll to bring it into view, producing visible jank.
    scratch.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(resolvePath(scratch, anchorPath), anchorOffset);
    range.setEnd(resolvePath(scratch, focusPath), focusOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    applyCommand();
    resultHtml = scratch.innerHTML;
  } finally {
    document.body.removeChild(scratch);
  }

  // Restore the live selection to its ORIGINAL (pre-insertion) position --
  // previewEl's own nodes were never mutated above, so the same path
  // resolves correctly against the live tree.
  previewEl.focus();
  const liveRange = document.createRange();
  liveRange.setStart(resolvePath(previewEl, anchorPath), anchorOffset);
  liveRange.setEnd(resolvePath(previewEl, focusPath), focusOffset);
  selection.removeAllRanges();
  selection.addRange(liveRange);

  return resultHtml;
}

// Syncs `resultingHtml` (the FULL post-insertion preview content, already
// computed) into #md-input, tagged with `origin` -- the exact same
// bookkeeping/write mechanism back-convert.js's syncPreviewToMarkdown(origin)
// uses (a single whole-document CM6 transaction via the shared dispatch
// helper below), reordered so this runs BEFORE the live #preview insertion
// (see the header comment above for why).
//
// [12-05] The write itself is the sole thing this task changes: the former
// focus-and-select-range-then-insert dance on a textarea is replaced by one
// surgical CM6 transaction, tagged `isolateHistory: 'full'` (not `'before'`,
// unlike back-convert.js's own two call sites) -- a paste must isolate on
// BOTH sides so it never groups with either the keystroke immediately
// before or the one after it (12-RESEARCH.md section 4's per-origin undo
// table). The dispatch helper never focuses the shared view, so
// savePreviewSelection()/restorePreviewSelection() are no longer needed
// around this write -- #preview's own focus/selection is simply never
// touched by it. (Those two helpers stay imported above and are still used
// by this file's OTHER listeners -- keyup/mouseup/focus -- untouched by this
// task.)
function syncScratchResultToMarkdown(resultingHtml, origin) {
  // [13-01] Deliberately NOT guarded on view.composing the way
  // back-convert.js's syncPreviewBlockToMarkdown()/syncPreviewToMarkdown()
  // now are: this call fires synchronously as part of a user's own paste
  // action (applyUndoSafeInsertion's caller), never via a debounced timer
  // that can outlive a focus change into the raw pane -- it cannot span a
  // composition session the same way a 90ms-debounced splice can. A
  // deliberate, documented scope boundary (T-13-03), not an oversight.
  //
  // Resolved fresh here, inside the function body, every call -- never
  // cached at module scope (T-5-03).
  const docId = getActiveDocId();
  const frontMatter = getFrontMatter(docId);
  const fullMarkdown = htmlToMarkdown(resultingHtml, frontMatter);
  // getActiveEditor() resolves the ACTIVE document's shared CM6 view at this
  // exact point of use -- never a hardcoded `#md-input` lookup.
  const view = getActiveEditor();
  if (fullMarkdown === view.state.doc.toString()) return; // idempotent -- nothing to write

  dispatchAppWrite(
    view,
    { from: 0, to: view.state.doc.length, insert: fullMarkdown },
    origin,
    docId,
    'full'
  );

  const body = fullMarkdown.slice(frontMatter.length);
  setDocumentBody(body, docId);
  setDocumentBlocks(renderWithSourceMap(body).blocks, docId);
  setFrontMatter(frontMatter, docId);

  markDocumentDirty(docId);
  recordApplied('left', fullMarkdown, docId);
}

// Orchestrates the full undo-safe insertion: compute (scratch) -> sync
// #md-input (focus-steal happens now, before #preview has been touched) ->
// perform the REAL, undo-preserving insertion into the LIVE #preview last,
// with nothing after it that changes focus.
function applyUndoSafeInsertion(content, execCmd, origin) {
  // Resolved fresh here, inside the function body, every call -- never
  // cached at module scope (T-5-03). The whole function operates against
  // this ONE resolved docId; the active document cannot change mid-call.
  const docId = getActiveDocId();
  const selection = window.getSelection();
  const resultingHtml = computeResultViaScratch(preview, selection, () => {
    document.execCommand(execCmd, false, content);
  });

  syncScratchResultToMarkdown(resultingHtml, origin);

  // restorePreviewSelection() above already refocused #preview with its
  // ORIGINAL (pre-insertion) selection restored -- perform the real
  // insertion now, as the LAST focus-touching step in this handler.
  beginWrite(origin, docId);
  try {
    document.execCommand(execCmd, false, content);
  } finally {
    endWrite(docId);
  }

  // #preview's own 'input' listener above just fired synchronously (as
  // part of the execCommand call), scheduling a debounced
  // syncPreviewBlockToMarkdown('user-right'). That call would find the
  // bookkeeping already fully in sync (updated by syncScratchResultToMarkdown
  // above) and correctly detect a no-op -- but flushing it NOW, deterministically,
  // rather than letting it fire on its own 90ms later, avoids any doubt.
  flush(docId);
}

// [Rule 1 - Bug, discovered by 03-06-PLAN.md's real-Chromium toolbar e2e
// spec] format.js's runFormatCommand() calls document.execCommand()
// directly on the live #preview, which fires this SAME native `input`
// event synchronously (execCommand-driven mutations always do -- this is
// indistinguishable from real typing at the DOM level). Without this
// check, that toolbar-triggered echo would schedule a second, redundant
// syncPreviewBlockToMarkdown('user-right') that later fires REENTRANTLY
// inside runFormatCommand's own syncPreviewBlockToMarkdown('toolbar') call
// (via this file's own `blur` listener's flush(), triggered when that call
// steals focus to #md-input), corrupting the selection runFormatCommand's
// caller needs intact afterward. 'toolbar' is bracketed by
// beginWrite/endWrite around format.js's execCommand call specifically so
// this listener can recognise and skip its own echo here, mirroring
// editor-events.js's ECHO_ORIGINS guard for #md-input.
//
// [Rule 1 - Bug, discovered by 03-REVIEW.md WR-01] 'paste'/'paste-plain'
// were missing from this set even though applyUndoSafeInsertion() brackets
// its live #preview execCommand with beginWrite('paste')/
// beginWrite('paste-plain'). With those origins unrecognised here, this
// listener would schedule a REDUNDANT syncPreviewBlockToMarkdown('user-right')
// on top of the paste's own explicit whole-document sync, relying entirely
// on the Step-4 idempotence check in back-convert.js to make it a no-op --
// the same comparison CR-01 showed can misfire. Adding both origins here
// makes the suppression structural, matching the pattern already used for
// 'toolbar' and for ECHO_ORIGINS on the #md-input side, rather than
// depending on idempotence to save it.
const PREVIEW_ECHO_ORIGINS = new Set(['toolbar', 'paste', 'paste-plain']);

preview.addEventListener('input', () => {
  // Per 03-RESEARCH.md Pattern 5: do not convert mid-composition. Debounce
  // duration is not a substitute for this -- composition length is unbounded.
  if (previewGate.isComposing()) return;
  // Resolved fresh here, at the point of use, never cached at module scope
  // (T-5-03) -- this pending debounce must occupy THIS document's own
  // pending slot, never a stale/wrong docId's, so a document B with its own
  // pending write in flight is never touched by a document A preview edit.
  const docId = getActiveDocId();
  if (PREVIEW_ECHO_ORIGINS.has(getActiveOrigin(docId))) return;
  scheduleFlush('left', () => syncPreviewBlockToMarkdown('user-right'), CONVERT_DEBOUNCE_MS, docId);
});

preview.addEventListener('compositionstart', () => {
  previewGate.start();
});

// Per 03-RESEARCH.md Pattern 5 (verified against the pinned Electron
// 43.4.0/Chromium 150 runtime): compositionend fires BEFORE the composition's
// final, isComposing:false `input` event -- do NOT convert synchronously
// here. The gate simply flips to not-composing; the browser's own subsequent
// `input` event is what the listener above picks up normally.
preview.addEventListener('compositionend', () => {
  previewGate.end();
});

// Ports index.html:1195-1198 exactly.
preview.addEventListener('keyup', () => {
  savePreviewSelection();
  updateFormatState();
});

// Ports index.html:1200-1203 exactly.
preview.addEventListener('mouseup', () => {
  savePreviewSelection();
  updateFormatState();
});

// Ports index.html:1205 exactly.
preview.addEventListener('focus', savePreviewSelection);

// New this phase (03-CONTEXT.md's explicit flush() call-site list): force
// any pending debounced conversion to complete synchronously the moment the
// preview loses focus, so a save/export/tab-switch that reads mdInput.value
// immediately afterward never observes stale Markdown. 03-02's
// normalise-on-blur prototype was ABANDONED (see 03-02-SUMMARY.md) -- this
// listener does ONLY the flush, no additional normalisation call.
preview.addEventListener('blur', () => {
  flush(getActiveDocId());
});

// CONV-09: clipboard HTML -> DOMPurify -> htmlToMarkdown -> markdownToHtml ->
// insert. The round trip through the conversion core is what makes CONV-09
// structurally true (pasted content cannot be anything the Markdown
// pipeline is unable to represent) rather than dependent on a Word-junk
// allowlist someone has to keep maintaining. `execCommand('insertHTML')`
// is deprecated with no replacement, but it is the only mechanism whose
// mutations join the preview's native (contenteditable) undo buffer --
// criterion 4 requires undo to survive the paste.
preview.addEventListener('paste', (e) => {
  e.preventDefault();

  const html = e.clipboardData.getData('text/html') || null;
  const text = e.clipboardData.getData('text/plain');
  const raw = html || text;

  // Size guard FIRST, before DOMPurify/Turndown ever see the payload
  // (T-3-03 -- the oversized-paste DoS vector RESEARCH.md flags as NOT
  // covered by the locked decision as written).
  if (byteLength(raw) > MAX_PASTE_BYTES) {
    showStatus('Pasted content too large -- not inserted', 'error');
    return;
  }

  // Same literal config as render.js -- reused verbatim, never re-derived
  // (Shared Pattern: DOMPurify config).
  const clean = DOMPurify.sanitize(html || escapeHtml(text), {
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style'],
  });

  // Full round trip -- a pasted fragment carries no front matter of its own.
  const md = htmlToMarkdown(clean, '');
  const { html: roundTripped } = markdownToHtml(md);

  // Explicit whole-document sync (see applyUndoSafeInsertion's header
  // comment for why this is reordered relative to the live insertion), NOT
  // the generic per-block `input` listener above: a pasted fragment can
  // span multiple top-level blocks (e.g. three paragraphs from Word), and
  // the per-block listener's single-anchor resolution would only catch
  // whichever ONE block the collapsed post-insert caret happens to land
  // in. This is the RESEARCH.md-sanctioned one-time, user-initiated
  // exception to the "never whole-document per-keystroke" rule.
  applyUndoSafeInsertion(roundTripped, 'insertHTML', 'paste');
});

// Ctrl+Shift+V: plain-text-only paste. Reads the text/plain clipboard
// flavour and inserts via execCommand('insertText') -- same undo-preserving
// mechanism, discarding any HTML formatting entirely.
preview.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.shiftKey && e.key === 'V')) return;
  e.preventDefault();

  navigator.clipboard.readText().then((text) => {
    if (byteLength(text) > MAX_PASTE_BYTES) {
      showStatus('Pasted content too large -- not inserted', 'error');
      return;
    }

    // Same multi-block reasoning as the paste handler above: plain-text
    // paste can also span multiple blocks via embedded newlines.
    applyUndoSafeInsertion(text, 'insertText', 'paste-plain');
  });
});

// Ports index.html:1206-1208 exactly (see module-level note above), except
// the target surface is now resolved via getActiveEditor() at the point of
// use (05-03) instead of a module-scope-cached `mdInput` -- mirroring
// scroll-sync.js's own preview-side listener (panes/scroll-sync.js) exactly,
// since scrolling the shared preview must always sync into whichever
// document's surface is actually visible.
preview.addEventListener('scroll', () => {
  const activeEditor = getActiveEditor();
  if (activeEditor) syncPaneScroll(preview, activeEditor);
});
