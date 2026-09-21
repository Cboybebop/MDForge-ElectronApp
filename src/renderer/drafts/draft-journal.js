// Renderer half of the draft journal (PERS-01, PERS-03) -- mirrors
// markdown/sync-controller.js's own scheduleFlush/flush/cancelPending
// shape (single-pending-timer-per-key, cleared before a new one is armed)
// but keeps its own separate per-docId Map here rather than adding a new
// entry to sync-controller.js's own Maps -- this file's concern (whether a
// document's CONTENT has been journalled to disk) is distinct from that
// file's concern (whether a pending preview<->markdown conversion has been
// applied).
//
// Exactly THREE immediate-flush triggers are wired, matching 06-CONTEXT.md's
// locked list -- no more, no fewer:
//   1. Window blur -- this file's own self-wired `window.addEventListener(
//      'blur', flushAllDrafts)` below, at module load.
//   2. Tab switch -- documents.js's setActiveDocId() calls flushDraftNow()
//      directly against the OUTGOING docId (wired in 06-05 Task 2).
//   3. Before-quit -- quit-handshake.js's onQueryDirtyState handler calls
//      flushAllDrafts() as its first statement, before main is even told
//      which documents are dirty (wired in 06-05 Task 3).
// 06-CONTEXT.md's own justification for accepting a debounced ~2s window is
// that every way of leaving a document forces a write first -- these three
// triggers are what make that premise true. Do not describe broader or
// narrower coverage here than what is actually wired in this plan.
//
// Per this codebase's established convention (sync-controller.js, split.js,
// tabs/closed-stack.js): module state below is private, exposed only via
// named getter/setter functions -- never a bare `export let`.
import { flush } from '../markdown/sync-controller.js';
import { getDocument, getDocumentContent } from '../documents.js';
import { showStatus } from '../status.js';

const DRAFT_DEBOUNCE_MS = 2000;

let pendingTimers = new Map(); // docId -> timer
let knownUuids = new Map(); // docId -> draft uuid
// [WR-03, 06-REVIEW.md] docId -> the in-flight writeDraft() Promise (the
// SAME promise flushDraftNow() returns), for exactly as long as that write
// has been initiated but not yet settled. cancelDraftFlush() can only
// cancel a PENDING (not-yet-fired) setTimeout -- it has no way to cancel a
// write whose IPC round trip has already started. This map is what lets
// deleteDraftForDoc() (called from markDocumentClean()/closeDocument())
// notice "a write for this doc is already in flight" and chain the delete
// to run the instant that write lands, instead of seeing no known uuid yet
// and wrongly concluding there is nothing to delete.
let inFlightWrites = new Map(); // docId -> Promise

/**
 * Arms a debounced draft write for `docId`, DRAFT_DEBOUNCE_MS after the
 * document became dirty. No-ops entirely (no timer armed) when the
 * `writeDraft` bridge method is absent -- this is what keeps
 * documents.test.js's un-stubbed `window.mdforge` fixture safe: without
 * this guard, a real 2-second setTimeout would leak past that unrelated
 * test file's own lifetime and later throw against an undefined global.
 */
export function scheduleDraftWrite(docId) {
  if (!window.mdforge?.writeDraft) return;

  const existing = pendingTimers.get(docId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    flushDraftNow(docId);
  }, DRAFT_DEBOUNCE_MS);
  pendingTimers.set(docId, timer);
}

/**
 * Forces docId's pending draft write to happen NOW, synchronously
 * initiating the IPC call -- the debounce timer's own callback, and the
 * function every immediate-flush trigger (tab switch, blur, before-quit)
 * calls directly. Safe to call unconditionally, including against a clean
 * document or one with nothing pending: clears any armed timer first (so a
 * later debounce cannot double-write), then no-ops with no write and no IPC
 * call when the bridge is absent, the document no longer exists (closed
 * before this ran), or the document is not dirty (06-CONTEXT.md's "only
 * dirty documents are journalled" rule -- this function can now be called
 * speculatively on a clean document by the tab-switch hook).
 *
 * [06-10, Rule 1 - Bug] Returns the in-flight write's own Promise (or
 * `undefined` for every no-op path above) -- found and fixed while writing
 * this plan's own clean-quit-drafts.spec.js: without a way to AWAIT this
 * call, quit-handshake.js's before-quit trigger could only ever INITIATE a
 * write, never wait for it to actually land on disk, before main's
 * subsequent sweepAllDrafts()+app.quit() sequence ran. Under an instant
 * (or merely fast) quit-decision response, that race is real, not
 * theoretical: it reproduced directly against this app once tested with a
 * mocked dialog that resolves in a microtask rather than genuine human
 * response time, leaving a half-written draft (`<uuid>.md` present,
 * `<uuid>.json` absent) behind after an ostensibly clean quit -- exactly
 * the PERS-03 violation ROADMAP criterion 3 forbids. Every EXISTING caller
 * of this function (the debounce timer's own callback, and documents.js's
 * tab-switch trigger) already ignores its return value, so returning a
 * Promise here changes nothing for them.
 */
export function flushDraftNow(docId) {
  const existing = pendingTimers.get(docId);
  if (existing) clearTimeout(existing);
  pendingTimers.delete(docId);

  if (!window.mdforge?.writeDraft) return undefined;

  const doc = getDocument(docId);
  if (!doc || !doc.dirty) return undefined;

  // A pending preview->markdown debounce must never be silently stale in a
  // journalled draft -- same discipline files/save.js's saveFile() already
  // follows (flush() as the first step, before the document's content is
  // read via getDocumentContent(docId) -- the retired per-doc surface field
  // is no longer touched here at all).
  flush(docId);

  const knownUuid = knownUuids.get(docId) ?? null;
  const writePromise = window.mdforge
    .writeDraft(knownUuid, getDocumentContent(docId), { filePath: doc.filePath, name: doc.name })
    .then(({ uuid }) => {
      knownUuids.set(docId, uuid);
    })
    .catch((err) => {
      // [CR-01, 06-REVIEW.md] A draft write CAN genuinely reject -- disk
      // full, a OneDrive/Defender lock, or atomic-write.js's own EPERM/
      // EBUSY/EACCES retry budget exhausted -- exactly the class of
      // failure atomic-write.js's own header comment exists to describe,
      // not an exotic edge case. Before this fix, this rejection had no
      // `.catch()` anywhere on its path: it propagated out of
      // flushAllDrafts()'s `Promise.all(...)`, through quit-handshake.js's
      // `await flushAllDrafts()`, as an unhandled rejection inside that
      // handler -- `sendDirtyDocuments()` never ran, and main's own
      // `ipcMain.once('app:dirty-documents', ...)` (before-quit.js) waited
      // forever with `event.preventDefault()` already standing: the app
      // could never quit again, with zero console-visible error to the
      // user. Catching it here (rather than letting the debounce timer's
      // callback or an immediate-flush trigger's caller discover it)
      // means EVERY caller of flushDraftNow()/flushAllDrafts() -- the
      // quit handshake included -- always sees a resolved (never
      // rejected) promise. The user is still told, via the status badge,
      // that this document's most recent debounce cycle was not backed
      // up -- silently swallowing the error entirely would trade a hang
      // for silent data loss, which is worse in a crash-recovery feature.
      console.error(`draft-journal: write failed for doc ${docId}:`, err);
      try {
        showStatus(`Could not back up "${displayNameFor(doc)}" — ${err?.message || 'draft write failed'}`, 'error', 5000);
      } catch {
        // #status-badge is absent in some environments (e.g. a DOM-less
        // test fixture) -- the console.error above is the guaranteed
        // signal; a UI-layer failure must never re-throw out of an
        // already-handled write failure.
      }
    })
    .finally(() => {
      // [WR-03, 06-REVIEW.md] Only clear THIS docId's in-flight entry if
      // it is still the exact promise this call started -- guards against
      // a (today theoretical, since pendingTimers/the dirty check already
      // serialize this in practice) later flushDraftNow(docId) call
      // clobbering a NEWER in-flight write's own bookkeeping.
      if (inFlightWrites.get(docId) === writePromise) inFlightWrites.delete(docId);
    });

  inFlightWrites.set(docId, writePromise);
  return writePromise;
}

// Mirrors quit-handshake.js's own displayNameFor() (duplicated rather than
// imported -- quit-handshake.js already imports THIS module, so importing
// back would create a cycle): filename only for a saved document, the
// assigned/fallback 'Untitled' name otherwise.
function displayNameFor(doc) {
  if (!doc.filePath) return doc.name || 'Untitled';
  return doc.filePath.split(/[\\/]/).pop();
}

/**
 * Flushes every currently-pending document's draft write, immediately.
 * This is the single function BOTH the window-blur listener below AND
 * quit-handshake.js's before-quit trigger call -- before-quit's own call
 * site lives in quit-handshake.js, not in this file.
 *
 * [06-10, Rule 1 - Bug] Returns a Promise that resolves once every write
 * INITIATED by this call has genuinely LANDED on disk -- see
 * flushDraftNow()'s own comment above for why this matters. The window-
 * blur listener below still calls this without awaiting it (blur has no
 * "quit sequence" racing behind it), which remains correct and unchanged.
 */
export function flushAllDrafts() {
  return Promise.all(
    Array.from(pendingTimers.keys()).map((docId) => flushDraftNow(docId))
  );
}

// Immediate-flush trigger 1 of 3: window blur. Harmless in a no-bridge test
// fixture -- scheduleDraftWrite's own guard above means pendingTimers can
// never contain an entry when window.mdforge is absent, so this always
// iterates an empty Map in that case.
window.addEventListener('blur', flushAllDrafts);

/**
 * Cancels docId's pending debounced write WITHOUT invoking it -- mirrors
 * sync-controller.js's cancelPending's exact contract (cancel, don't
 * flush).
 */
export function cancelDraftFlush(docId) {
  const existing = pendingTimers.get(docId);
  if (existing) clearTimeout(existing);
  pendingTimers.delete(docId);
}

// Shared by both branches of deleteDraftForDoc() below.
function deleteKnownUuidNow(docId, uuid) {
  knownUuids.delete(docId);
  // [CR-02, 06-REVIEW.md] Defense in depth: main's draft:delete handler now
  // throws (rather than silently no-oping) on a uuid that fails its own
  // UUID_RE validation. Every uuid reaching this call site today always
  // came from a value main itself returned or recorded, so this should
  // never actually reject -- but this call's return value was never
  // awaited or handled before, and an unvalidated future caller must not
  // turn into an unhandled promise rejection in the renderer.
  window.mdforge.deleteDraft(uuid).catch((err) => {
    console.error(`draft-journal: deleteDraft failed for doc ${docId}:`, err);
  });
}

/**
 * Deletes docId's on-disk draft, idempotently. A docId with no known uuid
 * AND no in-flight write (no draft was ever written for it, or already
 * deleted) returns immediately without calling the `deleteDraft` bridge
 * method at all -- there is nothing to delete.
 *
 * [WR-03, 06-REVIEW.md] markDocumentClean()/closeDocument() call
 * cancelDraftFlush() (cancels a PENDING timer) immediately before this --
 * but a write already IN FLIGHT (started moments earlier by an immediate-
 * flush trigger, or by the debounce timer itself just firing) cannot be
 * cancelled that way: its IPC round trip is already running, and
 * `knownUuids` will not reflect it until it resolves. Before this fix,
 * that left a real, reachable race: a save-success (or close-with-discard)
 * racing a still-in-flight draft write would see `knownUuids.has(docId)
 * === false`, conclude there was nothing to delete, and let that in-flight
 * write land moments later -- orphaning a full, valid `<uuid>.md`+
 * `<uuid>.json` pair on disk for a document this app itself already
 * considers clean. That orphan survives until the next clean-quit sweep,
 * or (if the process crashes first) resurfaces at the next launch as a
 * false-positive "recovered" entry (06-CONTEXT.md's "crash state is
 * derived, never flagged" rule is exactly what makes a stale draft this
 * dangerous). If a write IS in flight, the delete is now chained to run
 * the instant that write settles (CR-01 means it always resolves, never
 * rejects), by which point `knownUuids` reflects whatever uuid (if any)
 * that write actually used.
 */
export function deleteDraftForDoc(docId) {
  const inFlight = inFlightWrites.get(docId);
  if (inFlight) {
    inFlight.then(() => {
      const uuid = knownUuids.get(docId);
      if (uuid == null) return; // the write failed and never registered one
      deleteKnownUuidNow(docId, uuid);
    });
    return;
  }

  if (!knownUuids.has(docId)) return;
  deleteKnownUuidNow(docId, knownUuids.get(docId));
}

/**
 * Setter used by session/restore.js (a later plan): when a recovered
 * document already has a known draft uuid from the restore plan, this
 * seeds it so the FIRST subsequent write reuses that exact file instead of
 * creating a duplicate.
 */
export function registerKnownDraftUuid(docId, uuid) {
  knownUuids.set(docId, uuid);
}

/**
 * Getter used by session-writer.js (a later plan) to persist which draft
 * (if any) backs a given session tab.
 */
export function getKnownDraftUuid(docId) {
  return knownUuids.get(docId);
}
