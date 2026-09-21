// Single owner of per-document state -- supersedes the former single-
// document module's two module-scope globals (`filePath`, `isDirty`)
// (05-CONTEXT.md "Document Model & Tab State"). Extends the same
// getter/setter-only discipline sync-controller.js/split.js already use,
// from ONE global slot to ONE Map entry per docId --
// composition-gate.js's own header comment is the closest existing
// articulation of why a Map-of-instances is correct here (composing/being
// dirty in one document must never leak into another's state) and a bare
// module-singleton is not.
//
// D1 (05-01), SUPERSEDED by 12-02: every open document's raw-Markdown
// surface used to be a permanently DOM-attached `<textarea>`, CSS-toggled
// (inline `style.display`) and never `.remove()`d while the document
// stayed open. 12-02-PLAN.md dissolves that constraint entirely: there is
// now exactly ONE shared CM6 `EditorView` DOM node for the app's whole
// lifetime (mounted once, at bootstrap, into `#md-input`), and each open
// document instead retains its own `EditorState` object -- a plain,
// serializable value, not a DOM node -- swapped into the shared view via
// `view.setState()` on tab switch (see `setActiveDocId` below). History
// (undo/redo) now lives inside that `EditorState`, so there is nothing
// left to keep alive in the DOM.
//
// [05-02, historical] Migration obligation this file created
// (05-PATTERNS.md): every consumer of the former single-document module's
// markDirty()/markClean()/setFileLabel() had to eventually move to this
// module's per-doc equivalents. That migration completed in 05-08, which
// deleted the former singleton module outright once every consumer
// (editor-events.js, back-convert.js, files/*, clipboard/*, main.js,
// quit-handshake.js) was migrated -- documents.js is now the sole
// dirty/state-tracking mechanism app-wide.

import { discardDocState, flush } from './markdown/sync-controller.js';
import { discardWriteTimestamp } from './markdown/cm-dispatch.js';
import {
  scheduleDraftWrite,
  flushDraftNow,
  cancelDraftFlush,
  deleteDraftForDoc,
} from './drafts/draft-journal.js';
import { createEditorState, mountSharedView, getSharedView } from './markdown/cm-view.js';
// [15-02] restoreHistoryState is Plan 15-01's own null-on-any-failure
// contract -- createDocument's stateFactory below trusts it entirely rather
// than re-validating here, keeping every correctness check in exactly one
// place (history-serialization.js), per this codebase's established
// single-responsibility precedent (restore-plan.js's own "ordering/dedup
// only, not validation" header comment).
import { restoreHistoryState } from './session/history-serialization.js';
// [12-04] createSyncExtensions(docId) (12-03-PLAN.md's contract) is threaded
// into every per-tab EditorState below, closing the gap 12-02-PLAN.md
// deliberately left open (see registerDocument()'s own former comment,
// superseded by this one).
import { createSyncExtensions } from './markdown/editor-events.js';
// [12-04] attachLeftScrollSync(scrollDOM) is called exactly ONCE below, at
// the shared view's mount point -- NOT per-document (T-12-08: the shared
// scrollDOM would otherwise accumulate one duplicate listener per open
// tab). This import is circular with panes/scroll-sync.js (which imports
// getActiveEditor/getActiveDocId from this module) -- safe here because
// neither module reads the other's exports at its own top level, only
// inside function bodies invoked later (scroll-sync.js's listener
// callbacks; this module's own call below, made after scroll-sync.js has
// fully finished evaluating and exporting attachLeftScrollSync).
import { attachLeftScrollSync } from './panes/scroll-sync.js';

let documents = new Map(); // docId -> { filePath, dirty, state, savedSelection, scrollTop, frontMatter }
let activeDocId = null;
let nextDocId = 1;

// Registers a document's Map entry, building its EditorState via a
// caller-supplied `stateFactory(docId)` rather than a pre-built state
// object -- [12-04] createSyncExtensions(docId) must be baked into the
// state's own extensions, and docId is only known once allocated
// (nextDocId++) here, one line below. Building the state AFTER allocation
// (caller supplies a factory, not a finished value) is what makes that
// possible without a separate "allocate, then patch extensions" step.
// initBootstrapDocument() below reads the just-mounted shared view's own
// (already sync-wired, see the mountSharedView() call site) initial state;
// createDocument() builds a fresh one via createEditorState().
function registerDocument({ filePath, stateFactory }) {
  const docId = nextDocId++;
  documents.set(docId, {
    filePath,
    // [05-05, Rule 3 - Blocking] `name` is the ONLY new field this plan
    // adds to the per-doc record: an explicitly ASSIGNED display name for a
    // path-less document (e.g. 'Untitled 2'), set once at creation time by
    // files/new.js's allocateUntitledName() via setDocumentName() below.
    // Without this field, tab-bar.js's displayName() (05-04) and this
    // file's own notifyWindowTitle() (below) have no way to distinguish one
    // untitled document from another -- both hard-coded the literal string
    // 'Untitled' for every path-less document, which was correct only
    // because 05-04 never had a second one open. `null` means "no assigned
    // name yet" (the bootstrap document's permanent state, and any
    // path-having document's irrelevant-but-harmless default) -- both
    // consumers below fall back to the literal 'Untitled' in that case.
    name: null,
    dirty: false,
    // [07-03, WORK-06 groundwork] Set true only by setDocumentMissing() below
    // when a later reconciliation plan (07-09) detects this document's
    // filePath no longer resolves on disk (deleted/moved/trashed outside the
    // app). Purely a visual marker -- WORK-06's absolute invariant is that a
    // watcher event never closes a tab and never discards content, so this
    // field is deliberately independent of `dirty`/`state`/lifecycle: no
    // code path that flips it may touch any of those.
    missing: false,
    state: stateFactory(docId),
    savedSelection: null,
    scrollTop: 0,
    frontMatter: '',
  });
  // [12-04] Sync/input/Tab-key wiring is now baked into every state built
  // above via createSyncExtensions(docId) (12-02-PLAN.md deliberately left
  // this gap open; 12-03-PLAN.md defined the extensions; this is where they
  // land). Scroll-sync is deliberately NOT wired per-document here -- there
  // is only ONE shared scrollDOM for the app's whole lifetime, so
  // attachLeftScrollSync() is called exactly once, at the mountSharedView()
  // call site below, never per-document (see this plan's own objective on
  // the duplicate-listener bug that would otherwise cause).
  return docId;
}

// Self-wiring, matching this codebase's established convention (main.js's
// own header comment: every module attaches its own state/listeners at
// module-load time). Creates docId 1 wrapping the shared EditorView's own
// initial EditorState -- mountSharedView() below has already mounted that
// view into the REAL, pre-existing #md-input element from index.html
// before this runs.
function initBootstrapDocument() {
  // stateFactory ignores the docId argument registerDocument() would pass
  // it -- the shared view's initial state (mounted below) was already built
  // with createSyncExtensions(nextDocId) while nextDocId was still 1, i.e.
  // sync-wired for exactly the docId this call is about to allocate. Reuse
  // it rather than constructing a second, throwaway sync-wired state.
  const docId = registerDocument({ filePath: null, stateFactory: () => getSharedView().state });
  // Routed through setActiveDocId() (rather than a direct `activeDocId =
  // docId` assignment) so the window title is set correctly
  // ("Untitled — MD Forge") on fresh launch, per 05-UI-SPEC.md Surface 4's
  // format table, without duplicating setActiveDocId's own logic here.
  setActiveDocId(docId);
  return docId;
}

// [12-02] The ONE shared EditorView for the app's whole lifetime, mounted
// here once, before any document (bootstrap or restored) is registered --
// every registerDocument()/setActiveDocId() call below assumes
// getSharedView() already returns a real view. [12-04] Built with
// createSyncExtensions(nextDocId) rather than no extensions: this is the
// very first EditorState this module ever constructs, and nextDocId is
// guaranteed to still be 1 here (no registerDocument() call -- the only
// code that increments it -- has run yet), which is exactly the docId
// initBootstrapDocument() below allocates for this same state moments
// later. Without this, the bootstrap document (docId 1) would be the one
// document in the app with no sync wiring, since it never goes through
// createEditorState() a second time.
mountSharedView(document.getElementById('md-input'), createEditorState('', createSyncExtensions(nextDocId)));
// [12-04] Wired exactly ONCE, here, against the one shared scrollDOM this
// app will ever have -- see this file's own import comment and
// panes/scroll-sync.js's header for why this must never be called per
// document.
attachLeftScrollSync(getSharedView().scrollDOM);

// 06-05, Pitfall 1 fix (06-RESEARCH.md): initBootstrapDocument() used to run
// unconditionally here, which would add a stray extra "Untitled" tab on top
// of any restored session or crash-recovered draft. main already composed
// the single ordered restore plan (recovery, then argv/association, then
// remaining session tabs -- PERS-06) before this module was ever loaded
// (06-04's boot sequencing registers `restore:get-plan` as a synchronous IPC
// responder before createWindow runs), so a non-empty plan means
// session/restore.js (a later plan) is solely responsible for populating
// tabs instead. Guarded with optional chaining, not a hard call -- several
// existing jsdom test fixtures (documents.test.js) build a DOM without
// stubbing `window.mdforge`, and an empty plan (`{ plan: [] }`) is the
// correct fallback for those, matching this module's pre-existing behavior.
// `restorePlan` is intentionally NOT exported -- session/restore.js calls
// `window.mdforge.getRestorePlan()` itself rather than this module adding a
// new export surface for it.
const restorePlan = window.mdforge?.getRestorePlan?.() ?? { plan: [] };
if (restorePlan.plan.length === 0) {
  initBootstrapDocument();
}
// [12-02] else: session/restore.js populates every tab itself, ending with
// its own setActiveDocId() call once every plan entry is registered. The
// former compensating branch here (`ORIGINAL_MD_INPUT.style.display =
// 'none'`) is deleted entirely -- it existed only to keep a second, always-
// visible textarea from showing up beside session/restore.js's own restored
// surface. There is now exactly one shared view node; nothing else to hide.

// [15-02] historyJson is OPTIONAL and defaults to null -- every existing
// caller (files/new.js, files/open.js, tabs reopen, etc.) passes no third
// argument, so their behavior is provably unchanged: restoreHistoryState is
// simply never called for them. When historyJson IS supplied,
// restoreHistoryState(historyJson, initialContent, extensions) owns every
// correctness check (parse, shape, doc-match, version-mismatch, bounds) and
// returns either a real, history-carrying EditorState or null -- a null
// result falls straight through to the existing createEditorState() call,
// exactly as if historyJson had never been passed.
export function createDocument({ filePath = null, initialContent = '', historyJson = null } = {}) {
  return registerDocument({
    filePath,
    stateFactory: (docId) => {
      const extensions = createSyncExtensions(docId);
      if (historyJson) {
        const restored = restoreHistoryState(historyJson, initialContent, extensions);
        if (restored) return restored;
      }
      return createEditorState(initialContent, extensions);
    },
  });
}

export function closeDocument(docId) {
  const doc = documents.get(docId);
  if (!doc) return;

  // Pitfall 4 / threat T-5-02: a closed document's pending sync-controller
  // debounce must never fire later against a docId this Map no longer has
  // an entry for. T-5-05 (05-15 gap closure, 05-VERIFICATION.md Gap 2): a
  // closed document must ALSO release its entries in sync-controller.js's
  // other six per-docId Maps (revision/activeOrigin/lastApplied/pending/
  // documentBody/documentBlocks/frontMatter) -- not merely cancel its
  // pending timers -- since this file's own nextDocId counter never reuses
  // a closed docId, and documentBodyMap/documentBlocksMap hold that
  // document's full content, which would otherwise be retained forever.
  // discardDocState() does both halves; call it FIRST, before the Map
  // entry here is gone.
  discardDocState(docId);
  // [13-VERIFICATION.md WR-01] cm-dispatch.js's lastWriteEndAt is an EIGHTH
  // per-docId Map, added in 13-02 for the scroll-suppression grace window.
  // It belongs to the same leak class the seven above do, and must be
  // released here too. It is a separate call rather than part of
  // discardDocState() only because cm-dispatch.js imports FROM
  // sync-controller.js -- putting it there would close an import cycle.
  discardWriteTimestamp(docId);
  // [06-05, PERS-03] Closing a document (with-discard path, which never
  // calls markDocumentClean) must also delete its own draft file,
  // idempotently -- cancel first, so no pending debounced write can
  // resurrect it after deletion.
  cancelDraftFlush(docId);
  deleteDraftForDoc(docId);

  const wasActive = activeDocId === docId;
  // [05-REVIEW.md WR-02] Capture the closed tab's own insertion-order index
  // BEFORE deleting it, so activating "the tab that now occupies that same
  // index" (the near-universal tabbed-editor convention of activating a
  // neighbour, not always the earliest-created tab) is possible.
  // getDocumentIds()'s own documented invariant is that Map iteration order
  // IS tab order, so this is exactly the tab bar's own visual ordering.
  const orderedIds = Array.from(documents.keys());
  const closedIndex = orderedIds.indexOf(docId);

  // [12-02] No `.remove()` call anymore -- there is nothing to remove; the
  // one shared EditorView node stays mounted for the app's whole lifetime.
  // The EditorState reference itself is dropped simply by the
  // `documents.delete(docId)` below removing the Map entry. No other
  // closure in this file retains a reference to a closed doc's `state`
  // (mirrors the discardDocState()-covered leak class this file already
  // guards against, PITFALLS.md Performance Traps table, applied to CM6
  // state objects instead of DOM nodes). If `docId` is the active document,
  // `setActiveDocId()` below only ever writes an outgoing document's state
  // back onto a Map entry that still exists (it guards with `if (prevDoc)`)
  // -- by the time that call happens here, this docId's own entry is
  // already gone, so that guard is what prevents resurrecting a deleted
  // entry, not any special-casing in this function.
  documents.delete(docId);

  if (documents.size === 0) {
    // Never leave zero documents open.
    const freshId = createDocument({});
    setActiveDocId(freshId);
    return;
  }

  if (wasActive) {
    // The tab that occupied the NEXT index becomes active; if the closed
    // tab was last, fall back to the tab now occupying the PREVIOUS index
    // (the new last tab) -- both reduce to remainingIds[closedIndex] once
    // the closed id itself is removed and the index is clamped to the
    // shrunk array's bounds.
    const remainingIds = orderedIds.filter((id) => id !== docId);
    const nextIndex = Math.min(closedIndex, remainingIds.length - 1);
    setActiveDocId(remainingIds[nextIndex]);
  }
}

export function setActiveDocId(docId) {
  if (!documents.has(docId)) return;
  // [06-05, PERS-01] Captured BEFORE the `activeDocId = docId` reassignment
  // below -- this is the OUTGOING document's id, the one the immediate-flush
  // call at the bottom of this function must target. `null` on the very
  // first activation during bootstrap/restore, which the guard below skips.
  const previousDocId = activeDocId;
  // [12-02, DOC-09 correctness fix -- required regardless of sync wiring,
  // see this plan's own objective] `EditorView.dispatch()` produces a NEW
  // `EditorState` and updates the VIEW's own internal reference only -- it
  // never writes that state back into this Map. CM6's default keymap
  // already handles typing/backspace/etc. as core view behaviour, active
  // regardless of whether this app registers any extension at all, so a
  // user CAN already type into the mounted raw pane the moment this plan
  // lands. Without this capture, switching away from a document (to
  // another) and back would silently discard every edit made to it since
  // the last time this function ran for it -- a silent, catastrophic
  // data-loss bug. This mirrors the exact "capture on hide, before it's
  // lost" discipline this function already applies to scroll position in
  // the same block, just for content/history too.
  if (previousDocId != null && previousDocId !== docId) {
    const prevDoc = documents.get(previousDocId);
    if (prevDoc) {
      // [12-REVIEW.md CR-02 fix] Flush the OUTGOING document's pending
      // sync-controller debounce (a scheduled preview render or a scheduled
      // preview->markdown splice) BEFORE anything below reassigns
      // `activeDocId` or swaps the shared view's state. Both of
      // scheduleFlush()'s callbacks resolve their target docId via
      // getActiveDocId()'s DEFAULT parameter AT FIRE TIME, not at the moment
      // they were scheduled (editor-events.js's renderMarkdown(md) call,
      // back-convert.js's syncPreviewBlockToMarkdown() call) -- so a timer
      // still pending from THIS (soon-to-be-outgoing) document must be
      // forced to run now, while `activeDocId` still names it, or it will
      // fire later against whichever document becomes active next and
      // corrupt it (CR-02: real, reachable by chaining a keystroke into
      // Ctrl+N/Ctrl+Shift+T/Open). Centralizing this call here -- the one
      // function every "switch the active document" call site already
      // calls (tab-bar.js's activateTab()/reopenClosedTab(), files/new.js,
      // both branches of files/open.js) -- makes the discipline
      // structurally impossible for a future call site to omit, rather than
      // relying on each one remembering to call flush(previousDocId) itself
      // (three of five call sites had not, at the time of this fix).
      //
      // Guarded by `prevDoc` existing (not merely `previousDocId != null`):
      // closeDocument() calls discardDocState(docId) and deletes the Map
      // entry for the CLOSING document BEFORE it calls this function to
      // activate whichever document becomes active next -- flush()'s own
      // ensureDocState(docId) unconditionally re-seeds all seven of
      // sync-controller.js's per-docId Maps on any call, so calling
      // flush(previousDocId) here for an already-closed, already-discarded
      // docId would silently resurrect exactly the unbounded per-document
      // Map leak discardDocState() exists to prevent (05-15/T-5-05). A
      // closed document can have no genuinely pending debounce of its own
      // by the time this runs (discardDocState's own cancelPending() already
      // cleared it), so skipping flush() here for that case loses nothing.
      flush(previousDocId);
      prevDoc.state = getSharedView().state;
      prevDoc.scrollTop = getSharedView().scrollDOM.scrollTop;
    }
  }
  activeDocId = docId;
  // [CR-03, 06-REVIEW.md, re-derived for 12-02] Swap the shared view onto
  // the now-active document's retained state -- history() lives inside
  // that EditorState object, untouched by setState()'s own plugin-reinit
  // logic (12-RESEARCH.md section 5, confirmed directly against
  // @codemirror/view source), which is what makes DOC-09's independent
  // per-tab undo stacks real. setState() does NOT touch
  // scrollDOM.scrollTop (same source confirmation), so the incoming
  // document's cached scroll position is re-applied explicitly on the next
  // line -- the same "capture on hide, re-apply on show" mechanism this
  // file already used for the textarea era, now against the shared view's
  // scrollDOM instead of a per-doc surface.
  const activeDoc = documents.get(docId);
  const view = getSharedView();
  view.setState(activeDoc.state);
  view.scrollDOM.scrollTop = activeDoc.scrollTop;
  notifyWindowTitle();
  // [06-05, PERS-01] Immediate-flush trigger 2 of 3 (tab switch): flush the
  // OUTGOING document's pending draft write the moment the user switches
  // away from it. Safe to call unconditionally on every tab switch --
  // flushDraftNow() itself no-ops on a clean document, one with nothing
  // pending, or a docId that no longer exists.
  if (previousDocId != null && previousDocId !== docId) flushDraftNow(previousDocId);
}

export function getActiveDocId() {
  return activeDocId;
}

export function getDocument(docId) {
  return documents.get(docId);
}

// Insertion-order snapshot of every currently-open docId -- Map preserves
// insertion order, which is also tab order (05-UI-SPEC.md Surface 1: "one
// .tab per open document... iterate in insertion/tab order"). Returns a new
// array, not the live Map's key iterator, so a caller (tabs/tab-bar.js)
// can safely iterate it even while this module mutates `documents` mid-loop
// (e.g. closeDocument()'s auto-recreate path).
export function getDocumentIds() {
  return Array.from(documents.keys());
}

// [07-03] Promotes files/open.js's file-private findOpenDocumentByPath()
// (05-05) into this module's own exported, reusable lookup -- every later
// reconciliation call site (07-09's watcher-event handling, and any other
// future caller needing "which open document, if any, points at this exact
// absolute path") gets one shared implementation instead of each caller
// re-walking the Map ad hoc. Mirrors getDocumentIds()'s own Map-iteration
// precedent; returns `null` (not `undefined`) when no open document matches,
// matching this module's existing no-match convention (e.g. getDocument()'s
// callers already treat a falsy return as "no match").
export function getDocumentIdByPath(filePath) {
  for (const [docId, doc] of documents) {
    if (doc.filePath === filePath) return docId;
  }
  return null;
}

// [12-02] Returns the single shared EditorView directly -- no per-doc
// lookup needed; there is only ever one view node for the app's whole
// lifetime. No caller needs to know how the active document's state is
// resolved -- a caller needing the docId itself already calls
// getActiveDocId() separately (confirmed: back-convert.js, preview/
// events.js already do this). Note for future consumers (12-08-PLAN.md
// onward): reading a NON-active document's content, or writing to one,
// requires resolving the correct source (this live view for the active
// doc, `doc.state` for any other) -- this plan does not yet add that
// helper; 12-08-PLAN.md adds getDocumentContent(docId)/
// replaceDocumentContent(docId, text) for exactly that need, building on
// the state-capture discipline setActiveDocId() establishes above.
export function getActiveEditor() {
  return getSharedView();
}

// [12-08] The one shared content-read primitive 12-11/12-12-PLAN.md's six
// call sites (save.js, reconcile.js, draft-journal.js, files/open.js,
// session/restore.js, session/session-writer.js) need instead of each
// re-deriving this branch ad hoc. The active document's true current
// content lives in the shared view's own LIVE state (getActiveEditor()'s
// `.state`, NOT this Map's `doc.state`, which setActiveDocId() only
// refreshes when the user switches AWAY from it -- see that function's own
// state-capture comment); a background document's true current content is
// exactly `doc.state`, guaranteed fresh by that same capture. Returns
// `null` (not throwing) for an unknown docId, matching this module's
// existing no-match convention (getDocument(), getDocumentIdByPath()).
export function getDocumentContent(docId) {
  const doc = documents.get(docId);
  if (!doc) return null;
  return docId === activeDocId ? getSharedView().state.doc.toString() : doc.state.doc.toString();
}

// [12-08] The "discard my edits, reload from disk" primitive save.js's own
// reload-theirs branch and reconcile.js's external-change branch need.
// Deliberately builds a FRESH EditorState via createEditorState() (the same
// factory every other per-doc state in this file uses) rather than a
// dispatched transaction -- a transaction would PRESERVE/extend this
// document's undo history, but the user explicitly chose to discard their
// in-memory edits, so (per save.js's own WR-03 comment, the historical
// `.value =` behavior this mirrors) there is nothing on that stack worth
// keeping. A future reader must not "fix" this into a dispatchAppWrite-based
// transaction -- doing so would silently change the user-facing "discard
// means discard, including undo" contract this function exists to
// preserve. Silently no-ops for an unknown docId (matches this module's
// existing setter convention); only pushes the fresh state live via
// setState() when `docId` is the currently active document -- a background
// document's fresh state simply replaces its Map entry, becoming visible
// the next time the user switches to it (setActiveDocId()'s own
// view.setState(activeDoc.state) call).
export function replaceDocumentContent(docId, newText) {
  const doc = documents.get(docId);
  if (!doc) return;
  const freshState = createEditorState(newText, createSyncExtensions(docId));
  doc.state = freshState;
  if (docId === activeDocId) {
    getSharedView().setState(freshState);
  }
}

// [05-04, historical] New setter, symmetric with markDocumentDirty/
// markDocumentClean below. Originally needed so the former single-document
// module's setFilePath() bridge (files/new.js, files/open.js, files/save.js
// -- none migrated off that singleton until 05-08) could keep THIS
// module's per-doc filePath in sync for the bootstrap document. 05-08
// migrated every one of those callers to call this setter directly;
// documents.js is now the sole owner of this state.
export function setDocumentFilePath(docId, filePath) {
  const doc = documents.get(docId);
  if (!doc) return;
  doc.filePath = filePath;
  if (docId === activeDocId) notifyWindowTitle();
}

// [05-05, Rule 3 - Blocking] New setter, symmetric with
// setDocumentFilePath() above -- files/new.js's Untitled-naming allocation
// (05-UI-SPEC.md Surface 1: "Untitled, then Untitled 2, ... allocated
// against currently-open untitled documents") needs somewhere to PERSIST
// the name it computed at creation time, or every consumer that reads it
// back (tab-bar.js's displayName(), this file's own notifyWindowTitle()
// below) has no way to tell two untitled documents apart. Without this,
// Task 2's own acceptance criteria (two New documents named 'Untitled' and
// 'Untitled 2') could not be satisfied by any amount of new.js-local logic
// alone, since new.js has no other place to make that name observable.
export function setDocumentName(docId, name) {
  const doc = documents.get(docId);
  if (!doc) return;
  doc.name = name;
  if (docId === activeDocId) notifyWindowTitle();
}

// [06-05] PERS-04's scroll-position restore needs a real setter that
// writes the LIVE view property when this docId is the active one --
// mirrors 06-RESEARCH.md Pitfall 2's original finding (a cache-only field
// written once at creation time and never updated is permanently stale)
// applied to the shared CM6 view instead of a per-doc DOM node. [12-02]
// There is no per-doc DOM node to write anymore -- `getSharedView().
// scrollDOM` is the one live surface, and it only reflects THIS docId's
// scroll position while this docId is the active one; writing to it for a
// background document would corrupt whichever OTHER document is currently
// showing. Always write the cache (`doc.scrollTop`) -- what setActiveDocId()
// above reads back the first time the user actually switches to that
// background tab -- and only also write the live DOM property when this
// docId is already active.
export function setDocumentScrollTop(docId, value) {
  const doc = documents.get(docId);
  if (!doc) return;
  doc.scrollTop = value;
  if (docId === activeDocId) {
    const view = getSharedView();
    if (view) view.scrollDOM.scrollTop = value;
  }
}

// [05-05, Rule 2 - Missing Critical] Live tab-dot repaint added.
// 05-04-SUMMARY.md documented this as a KNOWN, deliberate omission at the
// time ("the tab's own dirty dot does not repaint live on a keystroke...
// only on tab-bar-triggered re-renders... a later plan introducing genuine
// multi-tab switching should re-evaluate whether a reactive hook is now
// justified, since with only one document open this plan could not
// demonstrate the gap end-to-end") -- this IS that later plan: this plan's
// own Task 2 explicitly requires "typing in it marks it dirty (tab dot
// fills...)" as an observable, testable behavior, which is now genuinely
// demonstrable with two real tabs open. `document.getElementById` is a
// plain DOM reach, not a module import of tabs/tab-bar.js -- the
// one-directional dependency direction 05-04 established (tab-bar.js
// imports documents.js, never the reverse) is preserved exactly; this
// mirrors notifyWindowTitle()'s own existing "reach across via a DOM/IPC
// call, not an import" pattern below.
export function markDocumentDirty(docId) {
  const doc = documents.get(docId);
  if (!doc) return;
  doc.dirty = true;
  document.getElementById(`tab-${docId}`)?.classList.add('dirty');
  // [06-05, PERS-01] A document becoming dirty schedules a debounced (~2s)
  // draft write -- same call site as the tab-dot repaint above, per this
  // plan's own key_links: "direct call, same call site as the existing
  // tab-dot repaint".
  scheduleDraftWrite(docId);
  if (docId === activeDocId) notifyWindowTitle();
}

export function markDocumentClean(docId) {
  const doc = documents.get(docId);
  if (!doc) return;
  doc.dirty = false;
  document.getElementById(`tab-${docId}`)?.classList.remove('dirty');
  // [06-05, PERS-03] A document becoming clean (save success) deletes its
  // draft file, idempotently. cancelDraftFlush() runs FIRST -- a pending
  // debounced write armed just before this document became clean must not
  // be allowed to resurrect the draft deleteDraftForDoc() is about to
  // delete.
  cancelDraftFlush(docId);
  deleteDraftForDoc(docId);
  if (docId === activeDocId) notifyWindowTitle();
}

// [07-03, WORK-06 groundwork] New setter, mirroring markDocumentDirty/
// markDocumentClean's exact template above: look up the Map entry, no-op
// silently if it does not exist (a watcher event can race a tab that closed
// in the meantime -- never throw for that), flip the boolean, then toggle
// the same reach-across-DOM `.classList` idiom those two setters already
// use. Deliberately does NOT call notifyWindowTitle() -- 07-UI-SPEC.md
// Surface 4 only changes the tab's own strikethrough/tooltip, never the
// window title format. Structurally incapable of discarding content: this
// function has no code path that deletes a Map entry, mutates the shared
// EditorView's mounted content, or reads/writes `doc.dirty`/the document's
// own retained state (T-7-04).
export function setDocumentMissing(docId, isMissing) {
  const doc = documents.get(docId);
  if (!doc) return;
  doc.missing = isMissing;
  document.getElementById(`tab-${docId}`)?.classList.toggle('missing', isMissing);
}

// Surface 4 (05-UI-SPEC.md): "{dirty ? '● ' : ''}{documentName} — MD Forge",
// filename only (never the full path -- the full path lives in the tab's
// title tooltip instead). Untitled-numbering (`Untitled 2`, ...) is
// implemented by this plan (05-05) via the `doc.name` field/setDocumentName()
// above -- 05-04-PLAN.md Task 3's own note deferred it, since that plan's
// only path-less document was the bootstrap document, always exactly
// "Untitled". Guarded with optional chaining, not a hard call: several
// existing jsdom test fixtures (documents.test.js) build a DOM without
// stubbing `window.mdforge`, and this module must not throw for them.
function notifyWindowTitle() {
  const doc = documents.get(activeDocId);
  if (!doc) return;
  // [05-05, Rule 1 - Bug] Was hard-coded to the literal 'Untitled' for
  // EVERY path-less document -- correct only while 05-04 never had a
  // second one open. Now falls back to the document's own assigned `name`
  // (set by files/new.js's Untitled-naming allocation via
  // setDocumentName()) so the window title genuinely shows 'Untitled 2 —
  // MD Forge' per 05-UI-SPEC.md Surface 4's own worked example, not
  // 'Untitled — MD Forge' for every untitled tab regardless of which one
  // is active.
  const name = doc.filePath ? doc.filePath.split(/[\\/]/).pop() : doc.name || 'Untitled';
  window.mdforge?.setWindowTitleInfo?.(name, doc.dirty);
}

export function isDocumentDirty(docId) {
  return documents.get(docId)?.dirty ?? false;
}

export function isAnyDocumentDirty() {
  for (const doc of documents.values()) {
    if (doc.dirty) return true;
  }
  return false;
}
