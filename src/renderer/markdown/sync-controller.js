// Sync controller -- replaces the old isUpdating-mutex module's `isUpdating`
// boolean (03-CONTEXT.md "Sync Loop Control & Debouncing"; ROADMAP
// criterion 5). That module is deleted as of 03-04-PLAN.md once this file
// became the last-remaining sync-direction guard both render.js (03-03) and
// back-convert.js (03-04) import.
//
// A single shared boolean mutex cannot distinguish "I caused this update" from
// "the other pane caused this update" -- that structural gap is the actual
// cause of the caret bugs and dropped edits this phase repairs. This module
// replaces the mutex with four independent, composable primitives instead:
//
//   1. A revision counter (nextRevision/currentRevision) -- is a pending
//      async update still current, or has a newer edit superseded it?
//   2. An active-write origin tag (beginWrite/endWrite/getActiveOrigin) --
//      the real reentrancy guard. 03-03/03-04 wrap every programmatic
//      execCommand write into the OTHER pane with beginWrite(origin) /
//      endWrite() around the call, synchronously, in the same call stack
//      tick -- execCommand fires the target element's native `input` event
//      synchronously inside the call, so that element's own input listener
//      can read getActiveOrigin() while it is still set and tell an echo of
//      the write it is currently inside apart from a genuine new user edit.
//   3. An idempotence cache (isNoOp/recordApplied) -- would applying this
//      content actually change anything for this target pane?
//   4. An explicit flush() -- force any pending debounced work to run now,
//      synchronously, regardless of its timer. Anywhere stale Markdown could
//      be read or written (save, clipboard/export build, preview blur, a
//      tab switch) must call this first.
//
// This module also absorbs the document-body/blocks/frontMatter bookkeeping
// both sync directions need ONE shared copy of (getDocumentBody/Blocks/
// FrontMatter and their setters) -- render.js's per-block diff and
// back-convert.js's per-block splice compare against this single copy
// instead of each keeping an independently-drifting one.
//
// --- 05-02: per-docId rewrite ---------------------------------------------
//
// Every one of the six state slots below (revision, activeOrigin,
// lastApplied, pending, documentBody, documentBlocks, frontMatter) is now a
// `Map<docId, ...>` rather than a single module-level value shared by the
// whole app (05-RESEARCH.md Architecture Pattern 2, true under BOTH D1
// outcomes -- this rewrite does not depend on which editor surface won).
// Without this, a pending 60-90ms debounce or an in-flight beginWrite/
// endWrite origin tag for one open document could fire or clobber another
// document's state the moment two tabs are open -- a genuine cross-document
// data-corruption vector (threat T-5-02), not merely a UI bug.
//
// DEFAULT_DOC_ID and the optional-trailing-parameter design: every function
// below accepts docId as its LAST parameter, defaulting to DEFAULT_DOC_ID,
// rather than a required leading parameter. This is a deliberate deviation
// from 05-02-PLAN.md's illustrative call shape (`beginWrite(docId, 'tab-key')`)
// -- that plan's own Task 3 text hedges with "match whatever exact keyed
// signature Task 2 implemented", leaving the exact shape to this file. A
// REQUIRED leading docId parameter would silently reinterpret every
// not-yet-migrated caller's first argument (render.js's/back-convert.js's/
// preview/events.js's/format.js's `beginWrite(origin)`, `isNoOp(targetPane,
// content)`, `scheduleFlush(targetPane, fn, delayMs)`, `recordApplied(
// targetPane, content)`, `setDocumentBody(body)`, etc. -- none of which are
// in this plan's files_modified list) as a docId, corrupting their behavior
// and breaking `npm run test:unit`'s existing green suites for those files
// -- a real regression this plan's own verification step explicitly forbids
// ("npm run test:unit stays green (no regression in unrelated suites)").
// Defaulting docId to DEFAULT_DOC_ID (1, documents.js's bootstrap document's
// own id) instead means every one of those not-yet-migrated call sites keeps
// working completely unchanged -- there is only ever one document until a
// later plan (05-03 onward) migrates each call site to pass its own real
// docId explicitly, exactly as this plan's success criteria anticipates
// ("nothing outside this plan's files references the old singleton API yet
// -- later plans migrate their own call sites").
//
// Per this codebase's established convention (the old isUpdating-mutex
// module, split.js, scroll-sync.js): every piece of state below is a
// private module-level `let`, exposed only via named getter/setter
// functions. No bare `export let` anywhere in this file.
//
// Deliberately NOT implemented: a `shouldSkipWrite(targetPane, origin)`
// function, as 03-RESEARCH.md's Pattern 1 proposes. Its stated property
// ("never write into the pane whose origin produced this change") is already
// structurally unreachable in this codebase's actual data flow -- render.js
// only ever writes to #preview, back-convert.js only ever writes to
// #md-input, and neither is ever asked to write into its own trigger pane.
// Adding it would be an unused, untestable indirection. The REAL reentrancy
// risk this phase must solve is the synchronous `input`-event echo produced
// by execCommand's own write into the pane a listener is watching -- that is
// exactly what beginWrite/endWrite/getActiveOrigin above solves directly.
// Do not "restore" shouldSkipWrite from the research notes. This reasoning
// holds identically per-docId -- keep beginWrite/endWrite/getActiveOrigin
// exactly as they are, just keyed.

const DEFAULT_DOC_ID = 1;

let revisionMap = new Map();
let activeOriginMap = new Map();
let lastAppliedMap = new Map();
let pendingMap = new Map();
let documentBodyMap = new Map();
let documentBlocksMap = new Map();
let frontMatterMap = new Map();

function ensureDocState(docId) {
  if (!revisionMap.has(docId)) revisionMap.set(docId, 0);
  if (!activeOriginMap.has(docId)) activeOriginMap.set(docId, null);
  if (!lastAppliedMap.has(docId)) lastAppliedMap.set(docId, { left: null, preview: null });
  if (!pendingMap.has(docId)) pendingMap.set(docId, { left: null, preview: null });
  if (!documentBodyMap.has(docId)) documentBodyMap.set(docId, '');
  if (!documentBlocksMap.has(docId)) documentBlocksMap.set(docId, []);
  if (!frontMatterMap.has(docId)) frontMatterMap.set(docId, '');
}

export function nextRevision(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  const next = revisionMap.get(docId) + 1;
  revisionMap.set(docId, next);
  return next;
}

export function currentRevision(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  return revisionMap.get(docId);
}

// Active-write origin. Values used across this phase:
//   'user-left'   -- render.js's ordinary write into #preview, triggered by a
//                     genuine left-pane keystroke (03-03).
//   'user-right'  -- back-convert.js's ordinary per-block write into
//                     #md-input, triggered by a genuine preview keystroke
//                     (03-04).
//   'toolbar'     -- back-convert.js's per-block/multi-block write into
//                     #md-input when triggered by format.js's
//                     runFormatCommand instead of a keystroke (03-04). Kept
//                     as a DISTINCT literal from 'user-right' purely for
//                     provenance/audit clarity -- the underlying write
//                     mechanism is the same function for both.
//   'paste'       -- preview paste handler's write into #md-input (03-05).
//   'paste-plain' -- preview Ctrl+Shift+V plain-text paste handler's write
//                     into #md-input (03-05).
//   'tab-key'     -- editor-events.js's Tab handler, writing into the active
//                     document's editor surface. Deliberately NOT in any
//                     skip list downstream -- a Tab edit's own resulting
//                     `input` event is the mechanism that drives its
//                     render+dirty side effects going forward.
//
// Every literal EXCEPT 'tab-key' must appear in the left pane's own
// input-listener skip-check (03-03): 'user-right', 'toolbar', 'paste', and
// 'paste-plain' all represent a write INTO the left pane FROM the other
// pane, which must never be mistaken for a fresh left-pane keystroke.
export function beginWrite(origin, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  activeOriginMap.set(docId, origin);
}

export function endWrite(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  activeOriginMap.set(docId, null);
}

export function getActiveOrigin(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  return activeOriginMap.get(docId);
}

// Idempotence cache -- one slot per target pane, per docId. isNoOp is
// checked immediately before a DOM write; recordApplied is called
// immediately after a successful one.
export function isNoOp(targetPane, content, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  return lastAppliedMap.get(docId)[targetPane] === content;
}

export function recordApplied(targetPane, content, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  lastAppliedMap.get(docId)[targetPane] = content;
}

// Keyed debounce/flush -- one pending { fn, timer } entry per target pane,
// per docId.
export function scheduleFlush(targetPane, fn, delayMs, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  const pending = pendingMap.get(docId);
  const existing = pending[targetPane];
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending[targetPane] = null;
    fn();
  }, delayMs);
  pending[targetPane] = { fn, timer };
}

// Force any pending scheduled work to run now, synchronously, in left then
// preview order, for ONE document. Called before save, before any
// clipboard/export build, on preview blur, and before that document's tab is
// closed or switched away from -- anywhere stale Markdown could be read or
// written.
export function flush(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  const pending = pendingMap.get(docId);
  for (const targetPane of ['left', 'preview']) {
    const entry = pending[targetPane];
    if (!entry) continue;
    clearTimeout(entry.timer);
    pending[targetPane] = null;
    entry.fn();
  }
}

// Force every currently-pending document's scheduled work to run now,
// synchronously. Intended for a future "quit with multiple dirty tabs"
// aggregated flow (DOC-06) -- not called by anything in this plan.
export function flushAll() {
  for (const docId of pendingMap.keys()) {
    flush(docId);
  }
}

// Clear a document's pending debounce timers WITHOUT invoking their
// callbacks -- distinct from flush(), which runs the callback. This is the
// Pitfall-4 fix (05-RESEARCH.md): a closed document's pending 60-90ms
// debounce must never fire later against a docId that documents.js's Map no
// longer has an entry for. documents.js's closeDocument() calls this FIRST,
// before removing the docId from its own Map.
export function cancelPending(docId) {
  if (!pendingMap.has(docId)) return;
  const pending = pendingMap.get(docId);
  for (const targetPane of ['left', 'preview']) {
    const entry = pending[targetPane];
    if (!entry) continue;
    clearTimeout(entry.timer);
    pending[targetPane] = null;
  }
}

// 05-15 gap closure (T-5-05 / 05-VERIFICATION.md Gap 2): closing a document
// releases ALL SEVEN of this file's per-docId Map slots, not just its
// pending debounce timers. cancelPending() above only ever cleared
// pendingMap's own timers -- it never deleted that docId's KEY from
// pendingMap itself, nor from revisionMap/activeOriginMap/lastAppliedMap/
// documentBodyMap/documentBlocksMap/frontMatterMap. documents.js's
// closeDocument() never reuses a closed docId (nextDocId only increments),
// so every document ever opened for the life of the renderer process left
// one permanently-retained entry in all seven Maps -- a genuine, unbounded
// structural leak, not measurement noise. documentBodyMap and
// documentBlocksMap are the two worst offenders: they hold that document's
// entire body string and parsed block array, i.e. the full content of every
// document the user has ever opened, retained forever. This is exactly what
// 05-VERIFICATION.md's re-run measured as accelerating privateBytes growth
// (+10.2MB, +11.9MB, +17.4MB across cycles 0->10->25->50).
//
// discardDocState(docId) is the fix: cancel any pending timers first (via
// cancelPending, keeping its own narrower contract as the single source of
// truth for the timer-cancellation half -- documents.test.js's and this
// file's own existing "cancels pending flush on document close" tests
// depend on cancelPending's behavior staying exactly as it is), then delete
// the docId key from every one of the seven Maps. Deleting the KEY matters,
// not merely resetting to a default value -- ensureDocState()'s own
// re-seeding on next access is what a stale default value would still leak
// through a Map.has() check; an actual .delete() is the only way the total
// retained state across all seven Maps stays bounded by the number of
// CURRENTLY OPEN documents, not the number ever created in the session.
export function discardDocState(docId) {
  cancelPending(docId);
  revisionMap.delete(docId);
  activeOriginMap.delete(docId);
  lastAppliedMap.delete(docId);
  pendingMap.delete(docId);
  documentBodyMap.delete(docId);
  documentBlocksMap.delete(docId);
  frontMatterMap.delete(docId);
}

// Shared document-body/blocks/frontMatter bookkeeping -- the single copy,
// per docId, both render.js's per-block diff and back-convert.js's per-block
// splice compare against, instead of each keeping its own
// independently-drifting copy.

// Holds the Markdown BODY (front matter already stripped) as of the last
// successful sync in either direction, for one document.
export function getDocumentBody(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  return documentBodyMap.get(docId);
}

export function setDocumentBody(body, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  documentBodyMap.set(docId, body);
}

// Holds the last-known renderWithSourceMap()-shaped { index, type, srcStart,
// srcEnd } array, relative to that document's documentBody (NOT its raw
// editor-surface value, which may have a front-matter prefix).
export function getDocumentBlocks(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  return documentBlocksMap.get(docId);
}

export function setDocumentBlocks(blocks, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  documentBlocksMap.set(docId, blocks);
}

// Holds the exact matched front-matter text stripFrontMatter() returned for
// that document, verbatim, ready for reattachFrontMatter/offset arithmetic.
export function getFrontMatter(docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  return frontMatterMap.get(docId);
}

export function setFrontMatter(fm, docId = DEFAULT_DOC_ID) {
  ensureDocState(docId);
  frontMatterMap.set(docId, fm);
}
