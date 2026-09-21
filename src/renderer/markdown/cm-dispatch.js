// The SOLE place any file in this phase may construct an app-write
// annotation. Per PITFALLS.md Pitfall 1's "never attach post-hoc" rule,
// nothing outside dispatchAppWrite() below may construct an appWriteOrigin
// annotation value -- enforced by 12-01-PLAN.md Task 1's acceptance
// criterion (exactly one call-site of that annotation's `of()` builder in
// this file).
//
// Why an Annotation, not a ported mutex: a single shared boolean flag (this
// codebase's old isUpdating-mutex, and sync-controller.js's own
// activeOriginMap) cannot distinguish "this specific transaction is an app
// echo" from "a genuine user edit happened to land while some unrelated
// async write was in flight" -- it can only say "something is writing right
// now". A CM6 Annotation is attached to ONE transaction and travels with it;
// the sync updateListener (built in a later plan on top of this module) can
// ask "did THIS transaction carry the annotation" rather than "is some
// global flag set", which is the actual mechanism 12-CONTEXT.md's Area 1
// success criterion requires and a mutex structurally cannot provide.
//
// dispatchAppWrite() still calls sync-controller.js's beginWrite/endWrite
// unchanged (12-RESEARCH.md section 2: "keep beginWrite/endWrite calls
// too" -- not an either/or). The annotation is what makes the
// cross-transaction correctness guarantee hold; beginWrite/endWrite/
// getActiveOrigin continues to serve every OTHER consumer of
// getActiveOrigin(docId) unchanged -- most importantly
// panes/scroll-sync.js's own guard, which this phase must not disturb.
import { Annotation } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { beginWrite, endWrite } from './sync-controller.js'

// Annotation VALUE carries the existing origin-literal vocabulary verbatim
// from sync-controller.js's own header comment: 'user-right', 'toolbar',
// 'paste', 'paste-plain', 'find-replace' (see 12-03-PLAN.md Task 4).
// Deliberately NEVER 'tab-key' -- a Tab keystroke is genuine user input, not
// an app-originated sync write, and must not be routed through this helper
// (12-RESEARCH.md section 4's undo-grouping table).
export const appWriteOrigin = Annotation.define()

// [13-02] Per-docId "grace window" tracking, confirmed necessary this
// session by direct empirical measurement: a real production splice into an
// EARLIER, unrelated paragraph left the raw pane's own scrollDOM.scrollTop
// measurably different (a real, small internal shift -- CM6 re-measuring a
// soft-wrapped document / a caret-into-view adjustment after the dispatched
// transaction lands) well AFTER dispatchAppWrite() had already returned and
// synchronously cleared getActiveOrigin() via endWrite(). That later,
// asynchronous 'scroll' event then leaked past panes/scroll-sync.js's
// synchronous getActiveOrigin() guard, re-syncing the preview pane away
// from where the reader was -- reproducing the exact v1.0 UAT "jumping
// preview" regression via an async timing gap, not an absent guard.
// lastWriteEndAt records, per docId, the timestamp endWrite() last ran, so
// scroll-sync.js's guard can widen its suppression window to cover this
// gap without needing a second beginWrite/endWrite bracket or a change to
// sync-controller.js's own contract.
const lastWriteEndAt = new Map()

// Suppression window (ms). [Rule 1 - Bug, discovered verifying this fix]
// An initial 150ms value was empirically found to be FLAKY (intermittently
// too short): CM6's own reflow/remeasure-driven scrollTop compensation can
// chain across more than one animation frame under real system load (each
// individual frame's own latency is small, but they can compound), so a
// window sized for "one frame's worth of latency" is not reliably enough --
// confirmed by a real, reproduced flake (previewScrollAfter differed from
// previewScrollBefore in roughly 1 of 3 repeated runs at 150ms, 0 of
// several repeated runs at this wider value). 500ms comfortably covers
// several animation frames of compounding reflow settlement -- CM6's OWN
// codebase uses a comparable-order-of-magnitude heuristic for an adjacent
// problem (ResizeObserver's own self-caused-resize filter compares against
// `Date.now() - 75`, one order of magnitude smaller for a lighter-weight
// signal) -- without meaningfully over-suppressing a genuine, unrelated
// user scroll (which would need to start within this exact narrow window of
// a completely unrelated app write to be wrongly suppressed -- an accepted,
// narrow residual risk, not a correctness gap).
const WRITE_SCROLL_GRACE_MS = 500

/**
 * True if `docId` had an app-originated write (dispatchAppWrite) complete
 * within the last `windowMs` milliseconds. Used by panes/scroll-sync.js to
 * widen its suppression window past the synchronous beginWrite/endWrite
 * bracket, covering the async scroll-event latency described above.
 *
 * @param {number} docId
 * @param {number} [windowMs]
 */
export function wasRecentAppWrite (docId, windowMs = WRITE_SCROLL_GRACE_MS) {
  const at = lastWriteEndAt.get(docId)
  return at != null && Date.now() - at < windowMs
}

/**
 * Dispatches a single app-originated write against a CM6 EditorView,
 * tagging the resulting transaction with `appWriteOrigin` (so the sync
 * updateListener can recognise its own echo) and `isolateHistory` (so the
 * write groups correctly, or not at all, with adjacent user typing --
 * 12-RESEARCH.md section 4).
 *
 * Wraps the dispatch in sync-controller.js's existing
 * beginWrite/endWrite bookkeeping via try/finally, mirroring
 * back-convert.js's own try/finally-around-execCommand exception-safety
 * discipline (WR-04) -- endWrite() must run even if dispatch() throws.
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {{from: number, to: number, insert: string}} change
 * @param {string} origin - one of the vocabulary literals above.
 * @param {number} docId
 * @param {string} [isolation='before'] - an `isolateHistory` value. Default
 *   is `'before'` per 12-RESEARCH.md's table (splice/toolbar writes); pass
 *   `'full'` explicitly for paste/paste-plain writes. NEVER pass
 *   `addToHistory: false` semantics here -- `isolateHistory` groups, it does
 *   not exclude from history, which is the correct behaviour for every
 *   app-driven write this phase makes (12-RESEARCH.md section 4).
 */
export function dispatchAppWrite (view, { from, to, insert }, origin, docId, isolation = 'before') {
  beginWrite(origin, docId)
  // [17-02, closing 13-02-PLAN.md Task 2's own pre-designed hypothesis (a)]
  // Real, unconditional production soft wrap (EditorView.lineWrapping,
  // permanent since 17-02) makes CM6 re-measure wrapped-line heights it had
  // only estimated before they were actually drawn. Confirmed empirically
  // this session: a splice entirely BEFORE the current viewport (an
  // app-driven write to an earlier, off-screen paragraph while the reader
  // is scrolled near the bottom of a long, wrapped document) can shift the
  // raw pane's own visible content by tens of pixels as a side effect of
  // that remeasurement -- NOT because scrollDOM.scrollTop itself moves (an
  // earlier version of this fix confirmed, empirically, that scrollTop is
  // completely unchanged across the jump), but because the document's own
  // total rendered height above the viewport changes, so the SAME scrollTop
  // pixel value now lands on different content. This is the exact upstream
  // codemirror/dev#1552 shape scroll-sync.spec.js's own dedicated guard
  // test names. Phase 13 pre-designed a version of this fix (13-02-PLAN.md
  // Task 2 hypothesis (a)) but did not need it then: lineWrapping was only
  // ever appended AFTER mount, via a test-only seam, a different code path
  // that happened not to trigger the remeasurement. Scoped to ONLY the
  // edit-strictly-before-the-viewport case (an edit strictly after the
  // viewport cannot shift anything above/within it; an edit inside the
  // viewport is a legitimate, user-visible change this must never fight).
  const editsBeforeViewport = to < view.viewport.from
  let anchorPosBefore = null
  let anchorTopBefore = null
  if (editsBeforeViewport) {
    anchorPosBefore = view.viewport.from
    const coords = view.coordsAtPos(anchorPosBefore)
    if (coords) anchorTopBefore = coords.top
  }
  let mappedAnchorPos = null
  try {
    if (anchorTopBefore !== null) {
      // Build the transaction WITHOUT dispatching yet, so its own
      // ChangeSet can map anchorPosBefore forward through the edit's
      // length delta -- a raw numeric offset does not auto-track through
      // a transaction; view.state.update() gives the real mapping CM6
      // itself uses, rather than hand-rolled from/to/insert.length
      // arithmetic that would silently drift out of sync with any future
      // change to this function's own change shape.
      const tr = view.state.update({
        changes: { from, to, insert },
        annotations: [
          appWriteOrigin.of(origin),
          isolateHistory.of(isolation)
        ]
      })
      mappedAnchorPos = tr.changes.mapPos(anchorPosBefore)
      view.dispatch(tr)
    } else {
      view.dispatch({
        changes: { from, to, insert },
        annotations: [
          appWriteOrigin.of(origin),
          isolateHistory.of(isolation)
        ]
      })
    }
  } finally {
    endWrite(docId)
    lastWriteEndAt.set(docId, Date.now())
  }
  if (mappedAnchorPos !== null) {
    preserveViewportAnchorAcrossRemeasure(view, mappedAnchorPos, anchorTopBefore)
  }
}

// CM6's own re-measurement of a soft-wrapped document's line heights does
// not always settle within a single animation frame -- this file's own
// WRITE_SCROLL_GRACE_MS comment above documents an adjacent finding
// ("CM6's own reflow/remeasure-driven scrollTop compensation can chain
// across more than one animation frame under real system load") for a
// related problem, and empirical measurement this session confirmed the
// same is true here. Re-measuring and re-compensating across several
// consecutive animation frames (rather than once, synchronously, right
// after dispatch) is what makes this correction converge reliably,
// comfortably inside scroll-sync.spec.js's own 600ms settle wait.
const OFF_VIEWPORT_SETTLE_FRAMES = 20

// Keeps the document position `anchorPos` visually pinned at `targetTop`
// (its on-screen Y coordinate immediately before the write) by nudging
// scrollDOM.scrollTop by exactly however far CM6's own remeasurement moved
// it, each frame, until it settles or the frame budget runs out. This is
// scroll COMPENSATION, not a scrollTop snapshot/restore -- restoring the
// raw scrollTop value does nothing here, because scrollTop itself never
// drifts in this scenario; it is what the SAME scrollTop value renders that
// changes.
function preserveViewportAnchorAcrossRemeasure (view, anchorPos, targetTop, framesRemaining = OFF_VIEWPORT_SETTLE_FRAMES) {
  if (typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => {
    const coords = view.coordsAtPos(anchorPos)
    if (coords) {
      const delta = coords.top - targetTop
      if (Math.abs(delta) > 0.5) {
        view.scrollDOM.scrollTop += delta
      }
    }
    if (framesRemaining > 1) {
      preserveViewportAnchorAcrossRemeasure(view, anchorPos, targetTop, framesRemaining - 1)
    }
  })
}

// [15-02] A direct setter onto the SAME lastWriteEndAt map dispatchAppWrite's
// own finally block populates -- for a write that does NOT go through
// dispatchAppWrite at all (a raw DOM/state property assignment with no
// dispatch bracket), so it still gets the same wasRecentAppWrite()
// suppression window dispatchAppWrite's own writes get for free. No
// annotation, no dispatch -- this is not a CM6 transaction.
//
// One caller, by design: session/restore.js's boot-time scrollTop write
// (`session/restore.js`'s `setDocumentScrollTop()` call, immediately before
// its own `setActiveDocId(activeDocId)` call) -- see
// `.planning/todos/pending/session-restore-scrolltop-boot-race.md` and
// 15-02-PLAN.md's own <source_findings> for the exact race this closes.
export function markRecentAppWrite (docId) {
  lastWriteEndAt.set(docId, Date.now())
}

// [13-VERIFICATION.md WR-01] lastWriteEndAt is an eighth per-docId Map, and
// like the seven sync-controller.js owns it must release a closed document's
// entry -- otherwise it regresses exactly the leak class T-5-05 (05-15 gap
// closure) already fixed, since documents.js's nextDocId counter never reuses
// a closed docId.
//
// This does NOT live inside sync-controller.js's discardDocState(): this
// module imports FROM sync-controller.js, so calling the other way would
// close an import cycle. documents.js's closeDocument() already owns
// close-time cleanup and calls discardDocState() there, so this is invoked
// alongside it -- one call site, same place, no cycle.
export function discardWriteTimestamp (docId) {
  lastWriteEndAt.delete(docId)
}
