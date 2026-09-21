// Renderer half of session persistence -- the write side of PERS-04. Mirrors
// find-replace/find-bar.js's own `#tab-bar` MutationObserver technique
// (06-CONTEXT.md/06-RESEARCH.md): tab create/close/reorder/activation all
// rebuild #tab-bar's children wholesale via renderTabBar(), so a single
// childList MutationObserver on #tab-bar catches every one of those without
// this module importing or being imported by tabs/tab-bar.js.
//
// [12-12] SUPERSEDED: this file used to ALSO run a second MutationObserver on
// #left-pane's childList, attaching a scroll listener to each newly-created
// per-document surface element (one per open textarea, back when every open
// document had its own permanently-DOM-attached textarea). Under the CM6
// model (12-02-PLAN.md) there is exactly ONE shared, STATICALLY-present
// EditorView node -- documents.js never appends a fresh per-document surface
// element to #left-pane again -- so that observer's callback would simply
// never fire again: a silent, permanent loss of "scrolling the raw pane on
// its own schedules a session write" behavior. It is replaced below with a
// single, direct 'scroll' listener attached ONCE, at module load, to the
// shared view's own scrollDOM.
//
// Deliberately self-wiring and DOM-observation-based, not an import/call
// from documents.js -- documents.js already carries two dirty-tracking
// hooks added by 06-05 (drafts/draft-journal.js); this module adds zero
// further coupling to that file, per this plan's own objective.
//
// Every DOM lookup below is guarded the same `if (el) { ... }` way
// find-bar.js's own tabBarObserver wiring is, so importing this module in a
// test with no full DOM fixture never throws.
import { getDocumentIds, getDocument, getActiveDocId, getActiveEditor } from '../documents.js';
import { getKnownDraftUuid } from '../drafts/draft-journal.js';
// [15-01] serializeHistoryForTab(state) is the write half of this phase's
// serialize/restore contract -- see history-serialization.js's own header
// comment. Threaded into buildSessionState() below via the IDENTICAL
// active/background split scrollTop already uses (CR-03, 06-REVIEW.md; 12-12
// CM6 retarget): the active tab's true-live state lives on the shared view,
// every other (background) tab's true state lives on its own retained
// `doc.state`.
import { serializeHistoryForTab } from './history-serialization.js';

const SESSION_WRITE_DEBOUNCE_MS = 500;

let pendingTimer = null;

/**
 * Snapshots the CURRENT tab order, active tab, and per-tab scroll position
 * -- always read live off documents.js's own state at call time, never
 * cached -- into the exact shape session/restore.js (06-07) and main's
 * session-store.js (06-02) both expect: `{ tabs: [{ filePath, draftUuid,
 * scrollTop }], activeIndex }`. Untitled documents (`filePath === null`) are
 * keyed by their known draft uuid instead of a path, matching
 * restore-plan.js's own dedup rule -- a tab with neither a path nor a known
 * draft uuid yet (never journalled) reports `draftUuid: null`.
 */
export function buildSessionState() {
  const ids = getDocumentIds();
  const activeDocId = getActiveDocId();
  return {
    tabs: ids.map((docId) => {
      const doc = getDocument(docId);
      return {
        filePath: doc.filePath,
        draftUuid: doc.filePath ? null : getKnownDraftUuid(docId) ?? null,
        // [CR-03, 06-REVIEW.md; 12-12 CM6 retarget] The shared view's own
        // scrollDOM is only trustworthy for the CURRENTLY ACTIVE document --
        // every OTHER document's state is a retained, off-screen EditorState
        // (documents.js's setActiveDocId() capture-on-deactivate logic), not
        // a live DOM surface at all. For every other (background) tab, read
        // documents.js's own `doc.scrollTop` cache field instead -- mirrored
        // there from the live value the LAST time that document was visible,
        // which is exactly the value that survives hiding. This mirrors
        // documents.js's own active/background split exactly.
        scrollTop: docId === activeDocId ? getActiveEditor().scrollDOM.scrollTop : doc.scrollTop,
        // [15-01, PERS-11] Same active/background split as scrollTop above:
        // the active tab's true-live EditorState is the shared view's own
        // `.state` (docId 1: 05-05, only `doc.state` for a NON-active
        // document is ever guaranteed fresh -- see documents.js's own
        // setActiveDocId() capture-on-deactivate comment). serializeHistoryForTab
        // itself never throws and returns null for an oversized/missing
        // history, so this field is always either a valid JSON string or
        // null -- never a source of a failed session write.
        history: docId === activeDocId ? serializeHistoryForTab(getActiveEditor().state) : serializeHistoryForTab(doc.state),
      };
    }),
    activeIndex: ids.indexOf(activeDocId),
  };
}

/**
 * Debounced write: a single pending timer, cleared and re-armed on every
 * call -- a burst of rapid tab-bar mutations or scroll events coalesces into
 * exactly one saveSessionState call, carrying whatever state is live at the
 * moment the debounce finally settles (not a snapshot taken at call time).
 * No-ops entirely (no timer armed) when the `saveSessionState` bridge
 * method is absent -- same discipline as draft-journal.js's
 * scheduleDraftWrite guard, for the same reason: a test fixture with no
 * stubbed window.mdforge must never leak a real timer past that test's own
 * lifetime.
 */
export function writeSessionState() {
  if (!window.mdforge?.saveSessionState) return;

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    window.mdforge.saveSessionState(buildSessionState());
  }, SESSION_WRITE_DEBOUNCE_MS);
}

/**
 * Immediate-flush trigger (window blur): clears any pending debounce timer
 * and calls saveSessionState() right now -- same bridge-presence guard as
 * writeSessionState() above, so this is also safe to call unconditionally
 * from a test fixture with no stubbed window.mdforge.
 */
export function flushSessionStateNow() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (!window.mdforge?.saveSessionState) return;

  window.mdforge.saveSessionState(buildSessionState());
}

// Self-wiring at module load, matching this codebase's established
// convention (documents.js's own header comment, find-bar.js's
// tabBarObserver). `document.getElementById` lookups are guarded, not hard
// calls -- several existing test fixtures build a DOM without every element
// this module looks for, and this module must not throw for them.
const tabBarEl = document.getElementById('tab-bar');
if (tabBarEl) {
  const tabBarObserver = new MutationObserver(() => {
    writeSessionState();
  });
  tabBarObserver.observe(tabBarEl, { childList: true });
}

// [12-12] Replaces the former per-document-surface MutationObserver (see
// this file's own header comment) -- there is exactly ONE shared, statically-
// mounted view now, so a single direct 'scroll' listener attached once, at
// module load, to its scrollDOM is both sufficient and correct. Guarded the
// same `if (...)`-style way every other self-wiring block in this file
// already is (getActiveEditor() returns null in a test fixture with no
// stubbed documents.js), so importing this module never throws.
const activeEditorForScroll = getActiveEditor();
if (activeEditorForScroll) {
  activeEditorForScroll.scrollDOM.addEventListener('scroll', writeSessionState);
}

window.addEventListener('blur', flushSessionStateNow);
