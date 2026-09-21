// Cross-pane scroll-sync — ported from index.html:879-890 (`syncPaneScroll`),
// 1165-1167 and 1206-1208 (the two scroll listener wiring sites).
//
// PATTERNS.md Shared Pattern 4: `isSyncingScroll` is the ONE re-entrancy guard,
// shared between both scroll directions. Both wiring call sites live together
// in this file and call the same exported function — neither the raw-editor
// nor the preview listener rolls its own copy of the guard.
//
// --- 05-02 Task 3: restructured from self-wiring to attachLeftScrollSync() -
//
// Previously this module cached `document.getElementById('md-input')` once
// at module-load time and attached the left-pane scroll listener directly
// to it. With multiple documents, every open document had its OWN
// `<textarea>` surface — so the left-pane half of this wiring became
// `attachLeftScrollSync(textareaEl, docId)`, called once per created
// surface by documents.js's createDocument(), each instance closing over
// its own docId. The preview pane stays a SINGLE shared element
// (05-RESEARCH.md's own finding: the preview is document-independent,
// unaffected by tabs), so its own scroll listener stays self-wired at
// module-load time exactly as before — it now targets whichever document is
// currently active (documents.js's getActiveEditor()) instead of a single
// captured `mdInput`, since scrolling the shared preview must always sync
// into the surface the user can actually see.
//
// isSyncingScroll remains the ONE shared guard across every surface: only
// one document's textarea is ever visible/scrollable at a time, so a single
// module-level guard is still correct, not a per-surface one.
//
// --- 12-04 Task 2: retargeted for CM6's ONE shared scrollDOM -------------
//
// 12-02-PLAN.md dissolved the one-`<textarea>`-per-document model entirely:
// there is now exactly ONE shared CM6 `EditorView`/`scrollDOM` for the
// app's whole lifetime. Calling the OLD `attachLeftScrollSync(textareaEl,
// docId)` once per created document (mirroring the textarea-era cardinality)
// would attach N duplicate 'scroll' listeners to that SAME node, each
// closing over a DIFFERENT (increasingly stale) captured docId — silently
// gating scroll-sync suppression against the wrong document the moment a
// second tab exists (T-12-08). `attachLeftScrollSync(scrollDOM)` now takes
// no docId at all and is called exactly ONCE, by documents.js, against the
// one shared `scrollDOM`; the guard resolves the ACTIVE docId fresh on
// every scroll event via `getActiveDocId()`, mirroring this same file's own
// preview-side listener below (which already resolves `getActiveEditor()`
// fresh) and back-convert.js's T-5-03 "resolve at point of use, never
// cache" discipline.

import { getActiveEditor, getActiveDocId } from '../documents.js';
import { getActiveOrigin } from '../markdown/sync-controller.js';
// [13-02] wasRecentAppWrite widens this file's own suppression window past
// the synchronous beginWrite/endWrite bracket -- see cm-dispatch.js's own
// header comment on lastWriteEndAt/WRITE_SCROLL_GRACE_MS for the confirmed
// async-timing gap this closes (T-13-05).
import { wasRecentAppWrite } from '../markdown/cm-dispatch.js';

let isSyncingScroll = false;

// Ports index.html:879-890 exactly.
export function syncPaneScroll(source, target) {
  const toggleSyncScroll = document.getElementById('toggle-sync-scroll');
  if (!toggleSyncScroll.checked || isSyncingScroll) return;

  const sourceMax = source.scrollHeight - source.clientHeight;
  const targetMax = target.scrollHeight - target.clientHeight;
  if (sourceMax <= 0 || targetMax <= 0) return;

  const ratio = source.scrollTop / sourceMax;
  isSyncingScroll = true;
  target.scrollTop = ratio * targetMax;
  requestAnimationFrame(() => { isSyncingScroll = false; });
}

// Attaches the left-pane -> preview half of scroll-sync to the ONE shared
// CM6 scrollDOM. Called exactly ONCE by documents.js, at the same point the
// shared view is mounted (bootstrap) -- NOT once per document (12-04-PLAN.md
// objective: the old one-call-per-document cardinality was correct for one
// scrollable node per tab, but under CM6's single shared scrollDOM it would
// attach N duplicate listeners to the same node, T-12-08).
export function attachLeftScrollSync(scrollDOM) {
  scrollDOM.addEventListener('scroll', () => {
    // [v1.0 UAT] Do not sync a scroll the APP caused, only one the USER did.
    //
    // Editing in the preview makes back-convert.js write into the shared
    // raw-pane surface, which requires focusing it -- and focusing scrolls
    // it to the caret. That is a genuine scroll event, so isSyncingScroll
    // (which only breaks sync->sync loops) does not catch it. Without this
    // guard the caret-scroll drags the preview to match, yanking the reader
    // away from wherever they were: the "jumping up and down while editing
    // in the preview" reported in v1.0 UAT.
    //
    // getActiveOrigin() is non-null for exactly the duration of an
    // app-initiated write (beginWrite/endWrite), which is precisely the
    // window we must ignore. Reusing it keeps one origin mechanism rather
    // than inventing a second flag that could drift from it.
    //
    // [12-04, T-12-08] getActiveDocId() is resolved FRESH, inside the
    // listener, on every single scroll event -- never captured once at
    // attach-time. There is now only one shared scrollDOM serving every
    // document, so a docId captured at attach-time would silently go stale
    // the moment the user switches tabs, gating suppression against
    // whichever document happened to be active when this listener was
    // attached rather than the one the user is actually looking at.
    const docId = getActiveDocId();
    if (getActiveOrigin(docId) !== null) return;
    // [13-02, T-13-05] The synchronous origin check above only catches a
    // scroll event that fires WHILE beginWrite/endWrite's bracket is still
    // open. Confirmed empirically this session: the raw pane's own internal
    // scroll adjustment after a dispatched write can fire its native
    // 'scroll' event asynchronously, arriving after endWrite() has already
    // cleared the origin -- this second check widens the suppression
    // window to cover that gap.
    if (wasRecentAppWrite(docId)) return;
    syncPaneScroll(scrollDOM, preview);
  });
}

// The preview -> left-pane half stays self-wired, module-load time, exactly
// as before -- the preview element itself is document-independent.
const preview = document.getElementById('preview');

preview.addEventListener('scroll', () => {
  const activeEditor = getActiveEditor();
  if (activeEditor) syncPaneScroll(preview, activeEditor);
});
