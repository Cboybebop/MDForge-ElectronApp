// LEFT PANE SYNC EXTENSIONS -- createSyncExtensions(docId) replaces the old
// `renderMarkdown(mdInput.value); markDirty();` synchronous call on every
// keystroke with a debounced, composition-gated, echo-suppressing flow,
// expressed as CM6 extensions rather than imperative DOM-listener attachment
// (03-CONTEXT.md "Sync Loop Control & Debouncing" / Post-Research Amendments;
// 03-RESEARCH.md Pitfall 1; ROADMAP criteria 1/3/4/SYNC-07).
//
// Only the doc-change/composition/Tab-key concerns belong here. The `scroll`
// listener is owned by panes/scroll-sync.js's own attachLeftScrollSync(),
// which wires both scroll-sync directions -- do not duplicate it here.
//
// --- 12-03 Task 1: rewritten from the old DOM-listener-attachment function
// (textareaEl, docId) to createSyncExtensions(docId) ------------------------
//
// Per 12-RESEARCH.md section 1 finding 1: `EditorView.setState()` destroys
// and reinitialises every VIEW plugin on every tab switch (history() is
// state-level and survives; a view-level plugin's own internal state does
// not). The sync listener therefore cannot be a view plugin attached
// externally the way the old wiring function attached DOM listeners to one
// `<textarea>` -- it must be a STATE-derived facet, baked into every
// EditorState's own extensions array via documents.js's createEditorState()
// call (wired in 12-04-PLAN.md), so it keeps working across every tab
// switch regardless of which document's state is currently active.
//
// This is a mechanical retarget of the old input/compositionstart/
// compositionend/keydown listeners onto CM6's own extension mechanisms --
// the debounce/composition/echo-suppression LOGIC is unchanged from 03-03/
// 03-06/03-REVIEW.md CR-02, only the plumbing (DOM listeners -> CM6
// extensions; the old origin-literal skip-set/getActiveOrigin check -> the
// appWriteOrigin annotation) changed. `beginWrite`/`endWrite`/`getActiveOrigin`
// are NOT removed from this codebase (panes/scroll-sync.js's own guard still
// needs them) -- this module simply no longer uses them as its OWN
// echo-suppression mechanism.
//
// [05-08] The former double-write (this module used to call BOTH the old
// single-document dirty singleton AND markDocumentDirty(docId)) stays
// retired. documents.js is the SOLE dirty-tracking mechanism --
// markDocumentDirty(docId) alone drives the tab's own dirty dot (05-05), the
// window title (05-04), and main.js's beforeunload guard via
// isAnyDocumentDirty() (05-08).
import { EditorView, keymap } from '@codemirror/view';
import { renderMarkdown } from './render.js';
import { markDocumentDirty } from '../documents.js';
import { scheduleFlush } from './sync-controller.js';
import { createCompositionGate } from './composition-gate.js';
import { appWriteOrigin } from './cm-dispatch.js';
import { createFindSearchExtension } from '../find-replace/search-panel.js';

// CONFIRMED unchanged at 03-06-PLAN.md Task 3, against real measurement
// (not left at CONTEXT.md's starting hypothesis untested): renderMarkdown()
// on the real tests/fixtures/sync/200-line-doc.md fixture (jsdom,
// per-block-patch typing shape -- same block count before/after, matching
// ordinary sustained typing rather than an Enter/Backspace structural
// change) measured a median 8.8ms / max 12.1ms across 12 repeated same-
// shape edits -- 15-20% of this 60ms budget. Against
// tests/fixtures/corpus/real-roadmap.md (275 lines, standing in for a
// larger real document), the full call measured a median 32.6ms, but
// breaking that down separately: renderWithSourceMap() alone (marked's
// lexer+parser, the ONLY part of this cost that's pure JS and therefore
// comparable 1:1 with 03-RESEARCH.md's own real-Chromium figures of
// ~2.3ms@200 lines / ~32ms@2000 lines) measured only ~2.9ms median on this
// same 275-line document -- meaning the remaining ~30ms is DOMPurify.
// sanitize() + DOM-patch cost specific to jsdom's own (much slower than
// V8's native Chromium bindings) DOM implementation, not a cost that
// transfers 1:1 to the real runtime this debounce actually governs. See
// 03-06's own SUMMARY.md for the full measurement record and reasoning.
// 05-02/12-03 do not re-tune this value.
const RENDER_DEBOUNCE_MS = 60;

/**
 * Builds the CM6 extensions array a single document's own EditorState
 * includes (via documents.js's createEditorState()) to wire this module's
 * sync/composition/Tab-key behaviour to that one document. Called once per
 * document, same cardinality as the old DOM-listener-attachment function
 * took (textareaEl, docId) -- but the result is baked into the EditorState
 * itself (a facet),
 * not attached to a DOM node, so it survives every setState() tab switch
 * (12-RESEARCH.md section 1 finding 1).
 *
 * @param {number} docId
 * @returns {import('@codemirror/state').Extension[]}
 */
export function createSyncExtensions(docId) {
  // Independent per-document composition state -- this instance belongs
  // ONLY to this one document's EditorState, never shared with another
  // document's state or with #preview's (composition-gate.js's own header
  // comment: composing in one pane must never gate sync in the other -- the
  // same reasoning extends to composing in one document must never gate
  // another's sync).
  const leftGate = createCompositionGate();

  return [
    // [14-02] search({createPanel})/panels({bottomContainer}) must be
    // present in a state from ITS OWN creation, on every document-creation
    // path (bootstrap, new document, opened file, and the
    // session-restore/discard-and-recreate path at replaceDocumentContent)
    // -- otherwise openSearchPanel's own config-less fallback
    // (StateEffect.appendConfig.of(searchExtensions)) would silently install
    // CM6's own default, un-customised panel (no bottomContainer, i.e.
    // reparented into .cm-editor) the first time find is opened on a state
    // that never had this extension baked in, violating both "the built-in
    // panel is not used" (EDIT-15) and "preserve #find-bar exactly"
    // (criterion 2). See search-panel.js's own header comment.
    ...createFindSearchExtension(),

    // Mechanical retarget of the old textarea `compositionstart`/
    // `compositionend` listeners (old lines 92-103) onto CM6's own content
    // DOM, via @codemirror/view's documented domEventHandlers facet. Same
    // two calls, same leftGate instance, same "resync on the NEXT input
    // event after end(), not synchronously" discipline carried forward
    // verbatim (03-RESEARCH.md Pattern 5, verified against the pinned
    // Electron 43.4.0/Chromium 150 runtime): compositionend fires BEFORE
    // the composition's final, isComposing:false doc-changing transaction,
    // so end() simply flips the gate -- the updateListener below's own next
    // docChanged update is what actually resyncs.
    EditorView.domEventHandlers({
      compositionstart: () => {
        leftGate.start();
      },
      compositionend: () => {
        leftGate.end();
      },
    }),

    // Replaces the old `input` listener's origin-skip-set/getActiveOrigin(
    // docId) check with the appWriteOrigin annotation -- the annotation
    // travels WITH the transaction object itself rather than relying on a
    // shared mutable flag surviving until this listener reads it
    // (12-RESEARCH.md section 1/PITFALLS.md Pitfall 1). This is the SOLE
    // echo-suppression mechanism for the raw pane; no boolean/mutex guard
    // exists anywhere else in this file.
    EditorView.updateListener.of((update) => {
      // PITFALLS.md Pitfall 1's first leak: a selection-only update (no doc
      // change at all) must never trigger a sync.
      if (!update.docChanged) return;

      // PITFALLS.md Pitfall 1's second leak: check EVERY transaction in
      // this update, not just the first -- a batched update carrying one
      // tagged and one untagged transaction must not silently pass the
      // filter (T-12-06).
      const isAppWrite = update.transactions.every(
        (tr) => tr.annotation(appWriteOrigin) != null
      );
      if (isAppWrite) return;

      // Per 03-RESEARCH.md Pattern 5: do not sync mid-composition. Debounce
      // duration is not a substitute for this -- composition length is
      // unbounded. Reads this closure's OWN leftGate instance (PITFALLS.md
      // Pitfall 8) -- deliberately not view.composing, since this phase
      // makes no decision about replacing the hand-rolled gate (12-CONTEXT.
      // md's Deferred Ideas defers that to Phase 18).
      if (leftGate.isComposing()) return;

      markDocumentDirty(docId);
      scheduleFlush(
        'preview',
        () => renderMarkdown(update.state.doc.toString()),
        RENDER_DEBOUNCE_MS,
        docId
      );
    }),

    // Tab inserts 2 spaces instead of moving focus. Rewritten from the old
    // `execCommand('insertText')` splice (itself a rewrite of an earlier
    // undo-destroying `.value =` splice -- 03-RESEARCH.md Pitfall 1) to
    // `view.state.replaceSelection(str)`, CM6's own TransactionSpec-
    // producing helper for "insert str at the current selection".
    // Dispatching it with NO appWriteOrigin/isolateHistory annotation is
    // deliberate: this is genuine user input (a keystroke), and per
    // 12-RESEARCH.md's undo table it must group with adjacent typing
    // exactly like any other keystroke -- mirroring the old handler's
    // deliberate exclusion of 'tab-key' from the old origin-skip set (old
    // lines 67, 126-140). Returning `true` prevents CM6's default Tab-moves-focus
    // behaviour, mirroring the old handler's `e.preventDefault()`.
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          view.dispatch(view.state.replaceSelection('  '));
          return true;
        },
      },
    ]),
  ];
}
