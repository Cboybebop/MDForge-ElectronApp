// @vitest-environment jsdom
//
// documents.js self-wires its bootstrap document (docId 1, wrapping the
// shared CM6 EditorView mounted into #md-input) at module-load time -- same
// pattern editor-events.test.js/cm-view.test.js already establish: build
// the DOM fixture BEFORE importing the module under test, then dynamically
// import.
//
// [12-02] #md-input is now a bare mount-host div, not a textarea -- CM6's
// EditorView appends its own `.cm-editor` root into it at mount time. The
// fixture still includes #preview and #toggle-sync-scroll even though this
// plan's own documents.js does not yet wire any sync/input extension into
// the shared view (12-04-PLAN.md restores that, CM6-shaped) -- kept for
// parity with 12-01-PLAN.md's cm-view.test.js construction pattern.
//
// [12-REVIEW.md CR-02 fix] `#empty-state` was added to this fixture as part
// of that fix: setActiveDocId() now calls sync-controller.js's real flush()
// for the outgoing document on every switch (previously only tab-bar.js's
// activateTab() did, and only when IT was the caller), which can genuinely
// invoke render.js's renderMarkdown() synchronously if that document had a
// pending preview-render debounce -- render.js's own `finally` block
// unconditionally toggles `#empty-state`'s class list. Without this element,
// any test in this file that types into the active document (a genuine,
// non-app-tagged CM6 transaction, which createSyncExtensions() always
// schedules a debounced render for) and then switches away from it now
// throws here instead of the switch completing.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { isolateHistory, undoDepth } from '@codemirror/commands';
import { serializeHistoryForTab } from './session/history-serialization.js';

let documents;
let scheduleFlush;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <div id="md-input"></div>
    </div>
    <div id="preview" contenteditable="true"></div>
    <div id="empty-state"></div>
    <input type="checkbox" id="toggle-sync-scroll" checked />
  `;
  documents = await import('./documents.js');
  ({ scheduleFlush } = await import('./markdown/sync-controller.js'));
});

describe('bootstrap document', () => {
  it('creates docId 1 wrapping the shared EditorView mounted into #md-input, not a clone', () => {
    const doc = documents.getDocument(1);
    expect(doc).toBeTruthy();
    expect(doc.state.doc.toString()).toBe('');
    expect(documents.getActiveDocId()).toBe(1);
    expect(documents.getActiveEditor()).toBeTruthy();
    // The shared view's own DOM root (`.cm-editor`) is mounted directly
    // inside #md-input -- there is exactly one EditorView for the app's
    // whole lifetime, never one per tab.
    expect(documents.getActiveEditor().dom.parentElement).toBe(document.getElementById('md-input'));
  });

  it('starts clean (not dirty)', () => {
    expect(documents.isDocumentDirty(1)).toBe(false);
    expect(documents.isAnyDocumentDirty()).toBe(false);
  });
});

describe('createDocument', () => {
  it('creates a new document with its own EditorState, not yet active', () => {
    const docId = documents.createDocument({ initialContent: 'hello' });
    const doc = documents.getDocument(docId);

    expect(doc.state.doc.toString()).toBe('hello');
    // There is no DOM visibility concept anymore -- a freshly-created
    // document's state simply isn't the one mounted into the shared view
    // yet; the caller must explicitly activate it.
    expect(documents.getActiveDocId()).toBe(1);
    expect(doc.dirty).toBe(false);
    expect(doc.filePath).toBe(null);

    documents.closeDocument(docId); // cleanup -- restore single-doc state
  });

  // [12-02] The former "inherits placeholder/spellcheck live from the
  // original #md-input" test is deleted entirely -- its premise (a per-tab
  // DOM node inheriting attributes from a template element) no longer
  // exists. Spellcheck is now a CM6 extension set once in cm-view.js's
  // createEditorState(), not a per-node attribute copy; there is no
  // per-tab DOM node left to inherit anything onto.
});

// [15-02] createDocument's new historyJson param -- Plan 15-01's
// restoreHistoryState/serializeHistoryForTab contract, wired into the
// stateFactory. Uses REAL EditorState/EditorView construction (dispatch
// real transactions to build genuine history), mirroring this file's own
// existing style, not mocks.
describe('createDocument with historyJson', () => {
  it('default (no historyJson / null): behavior is completely unchanged -- builds via createEditorState, undoDepth 0', () => {
    const docId = documents.createDocument({ initialContent: 'plain' });
    const doc = documents.getDocument(docId);

    expect(doc.state.doc.toString()).toBe('plain');
    expect(undoDepth(doc.state)).toBe(0);

    documents.closeDocument(docId); // cleanup
  });

  it('a real, doc-matching serialized history restores genuine undo depth', () => {
    // Build a real document via a temporary EditorView, exactly mirroring
    // history-serialization.test.js's own mountRealView/round-trip pattern.
    const tempDocId = documents.createDocument({ initialContent: 'start' });
    documents.setActiveDocId(tempDocId);
    const view = documents.getActiveEditor();
    view.dispatch({ changes: { from: 5, to: 5, insert: ' edit' }, annotations: [isolateHistory.of('full')] });
    const finalContent = view.state.doc.toString();
    const historyJson = serializeHistoryForTab(view.state);
    expect(historyJson).not.toBeNull();
    documents.closeDocument(tempDocId); // cleanup the scratch document

    const docId = documents.createDocument({ initialContent: finalContent, historyJson });
    const doc = documents.getDocument(docId);

    expect(doc.state.doc.toString()).toBe(finalContent);
    expect(undoDepth(doc.state)).toBeGreaterThan(0);

    documents.closeDocument(docId); // cleanup
  });

  it('a historyJson that fails to parse falls back to a plain createEditorState result, never throws', () => {
    const docId = documents.createDocument({ initialContent: 'fallback', historyJson: 'not valid json{{{' });
    const doc = documents.getDocument(docId);

    expect(doc.state.doc.toString()).toBe('fallback');
    expect(undoDepth(doc.state)).toBe(0);

    documents.closeDocument(docId); // cleanup
  });

  it('a historyJson whose doc does not match initialContent falls back to a plain createEditorState result', () => {
    const mismatched = JSON.stringify({
      doc: 'something else entirely',
      selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
      history: { done: [], undone: [] },
    });

    const docId = documents.createDocument({ initialContent: 'real content', historyJson: mismatched });
    const doc = documents.getDocument(docId);

    expect(doc.state.doc.toString()).toBe('real content');
    expect(undoDepth(doc.state)).toBe(0);

    documents.closeDocument(docId); // cleanup
  });
});

describe('setActiveDocId', () => {
  it("setState() swaps the shared view onto the newly-active document's content -- the view node itself is never removed", () => {
    const docId = documents.createDocument({ initialContent: 'second doc' });

    documents.setActiveDocId(docId);
    expect(documents.getActiveDocId()).toBe(docId);
    expect(documents.getActiveEditor().state.doc.toString()).toBe('second doc');
    expect(document.getElementById('md-input')).toBeTruthy(); // still attached, not removed

    documents.setActiveDocId(1);
    expect(documents.getActiveEditor().state.doc.toString()).toBe('');
    expect(document.getElementById('md-input')).toBeTruthy(); // still the same, only node

    documents.closeDocument(docId); // cleanup
  });

  it('is a no-op for an unknown docId', () => {
    const before = documents.getActiveDocId();
    documents.setActiveDocId(999999);
    expect(documents.getActiveDocId()).toBe(before);
  });

  it("CR-03: caches the OUTGOING document's live scrollTop into doc.scrollTop before switching away", () => {
    const docId = documents.createDocument({ initialContent: 'second doc' });
    documents.setActiveDocId(docId);
    documents.getActiveEditor().scrollDOM.scrollTop = 321;

    documents.setActiveDocId(1); // switch away from docId

    expect(documents.getDocument(docId).scrollTop).toBe(321);

    documents.closeDocument(docId); // cleanup
  });

  it("CR-03: re-applies a document's cached scrollTop to the shared view the moment it becomes active again -- fixes a value that was only ever set while inactive (mirrors session/restore.js's own setDocumentScrollTop() call on a not-yet-active plan entry)", () => {
    const docId = documents.createDocument({ initialContent: 'second doc' });
    // Seed the cache directly via setDocumentScrollTop while docId is not
    // active -- exactly what session/restore.js does for every non-active
    // plan entry.
    documents.setDocumentScrollTop(docId, 777);

    documents.setActiveDocId(docId);

    expect(documents.getActiveEditor().scrollDOM.scrollTop).toBe(777);

    documents.closeDocument(docId); // cleanup
  });

  // [12-02, T-12-06] The self-discovered, load-bearing regression test this
  // plan's own objective requires: EditorView.dispatch() updates only the
  // shared view's own internal EditorState -- it never writes back into
  // this module's Map. Proven to FAIL against a version of setActiveDocId()
  // with the `prevDoc.state = getSharedView().state` capture line removed
  // (temporarily commented out, re-run, confirmed red, then restored --
  // see this task's own commit message for the fail-then-pass record) --
  // this test has teeth, not just an assertion that happens to pass.
  it('preserves edits made to a document while it was active, across switching away and back (DOC-09)', () => {
    const a = documents.getActiveDocId(); // docId 1, bootstrap, content ''
    const b = documents.createDocument({ initialContent: 'doc B' });

    // Simulate a real keystroke with no annotation -- exactly what CM6's
    // own default keymap dispatches for typing, which is active regardless
    // of any extension this app registers.
    documents.getActiveEditor().dispatch({
      changes: { from: 0, to: 0, insert: 'typed while active' },
    });

    documents.setActiveDocId(b);
    documents.setActiveDocId(a);

    expect(documents.getActiveEditor().state.doc.toString()).toContain('typed while active');

    // [12-04] Cleanup, now load-bearing: with createSyncExtensions(docId)
    // wired into every EditorState (this plan), the raw dispatch() above is
    // no longer a no-op side-effect-wise -- its updateListener genuinely
    // marks docId `a` (the persistent bootstrap document, docId 1, which
    // outlives this test) dirty. Before 12-04, no extension observed that
    // dispatch, so this cleanup wasn't needed; leaving it dirty now would
    // leak into every later test in this file that assumes a clean starting
    // state (e.g. isAnyDocumentDirty's own first assertion).
    documents.markDocumentClean(a);
    documents.closeDocument(b); // cleanup
  });

  // [12-REVIEW.md CR-02] Reproduces the cross-document corruption at its
  // source: a document with a genuinely pending sync-controller debounce
  // (scheduled by a real, non-app-tagged CM6 edit, exactly like
  // editor-events.js's own updateListener does for ordinary typing) must
  // have that debounce flushed SYNCHRONOUSLY, against ITS OWN docId, the
  // moment setActiveDocId() switches away from it -- never left pending to
  // resolve later against whichever document happens to be active when its
  // timer eventually fires. Before this fix, three of five real
  // "switch the active document" call sites (files/new.js, both branches of
  // files/open.js, tab-bar.js's reopenClosedTab()) never flushed at all,
  // reproducibly landing an outgoing document's stale write against the
  // incoming document once its debounce timer fired late.
  it('CR-02: flushes the outgoing document\'s pending sync-controller debounce BEFORE switching, so a stale timer can never resolve against the newly active document', () => {
    vi.useFakeTimers();

    const a = documents.getActiveDocId();
    const b = documents.createDocument({ initialContent: 'doc B' });

    // Mirrors editor-events.js's own scheduleFlush('preview', () =>
    // renderMarkdown(...), 60, docId) call shape exactly: the scheduled
    // function reads getActiveDocId() itself, at FIRE time -- exactly the
    // mechanism CR-02 exploited when no flush() ran before a switch.
    const resolvedDocIds = [];
    scheduleFlush(
      'preview',
      () => resolvedDocIds.push(documents.getActiveDocId()),
      60,
      a
    );

    // Switch away from `a` via the plain public API, with NO explicit
    // flush(a) call from this test -- exactly what files/new.js's
    // newFile()/files/open.js's applyOpenedFile()/tab-bar.js's
    // reopenClosedTab() do (and, before this fix, three of those four did
    // this unsafely).
    documents.setActiveDocId(b);

    // The pending callback must have already run, synchronously, during the
    // switch itself -- BEFORE `b` ever became active -- resolving
    // getActiveDocId() as `a`, not `b`.
    expect(resolvedDocIds).toEqual([a]);

    // Advancing time confirms the ORIGINAL timer is genuinely gone (flushed,
    // not merely raced) -- it must never also fire a second time later,
    // which would be exactly the "resolves against whichever document is
    // active when it happens to fire" bug CR-02 describes.
    vi.advanceTimersByTime(1000);
    expect(resolvedDocIds).toEqual([a]);

    documents.markDocumentClean(a);
    documents.closeDocument(b); // cleanup
    vi.useRealTimers();
  });

  // [12-REVIEW.md CR-02] Sanity check for the `prevDoc` guard's BEHAVIORAL
  // side, complementing sync-controller.test.js's own direct proof that
  // discardDocState() deletes (not merely resets) a closed document's Map
  // entries: closing the ACTIVE document exercises closeDocument()'s
  // internal setActiveDocId() call (the exact call this fix's `if (prevDoc)`
  // guard applies to) against a docId that discardDocState() has already run
  // for -- this must not throw, hang, or resurrect that docId's cancelled
  // pending debounce.
  it('CR-02 guard: closing the active document (which triggers its own internal setActiveDocId call) does not throw or resurrect that document\'s already-cancelled pending debounce', () => {
    vi.useFakeTimers();

    const a = documents.createDocument({ initialContent: 'A' });
    documents.setActiveDocId(a); // `a` active -- closeDocument(a) below exercises the wasActive->setActiveDocId(next) branch

    const fn = vi.fn();
    scheduleFlush('preview', fn, 1000, a);

    expect(() => documents.closeDocument(a)).not.toThrow();

    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled(); // cancelled by discardDocState(), never resurrected

    vi.useRealTimers();
  });
});

describe('closeDocument', () => {
  it('activates a remaining document when the active one is closed', () => {
    const a = documents.createDocument({ initialContent: 'A' });
    const b = documents.createDocument({ initialContent: 'B' });
    documents.setActiveDocId(b);

    documents.closeDocument(b);

    expect(documents.getDocument(b)).toBeUndefined();
    expect(documents.getActiveDocId()).not.toBe(b);

    documents.closeDocument(a); // cleanup
  });

  it('WR-02: activates the tab that occupied the NEXT index, not always the earliest-created document', () => {
    const a = documents.createDocument({ initialContent: 'A' });
    const b = documents.createDocument({ initialContent: 'B' });
    const c = documents.createDocument({ initialContent: 'C' });
    // Tab order is [1 (bootstrap), a, b, c] -- activate and close the
    // MIDDLE tab (b). Map insertion order alone would jump back to docId 1
    // (the earliest-created document); the fix activates b's neighbour (c).
    documents.setActiveDocId(b);

    documents.closeDocument(b);

    expect(documents.getActiveDocId()).toBe(c);

    documents.closeDocument(a);
    documents.closeDocument(c);
  });

  it('WR-02: falls back to the previous index when the closed (active) tab was the last one', () => {
    const a = documents.createDocument({ initialContent: 'A' });
    const b = documents.createDocument({ initialContent: 'B' });
    // Tab order is [1 (bootstrap), a, b] -- b is last.
    documents.setActiveDocId(b);

    documents.closeDocument(b);

    expect(documents.getActiveDocId()).toBe(a);

    documents.closeDocument(a);
  });

  it('cancels any pending sync-controller debounce for that docId before removing it (Pitfall 4)', () => {
    vi.useFakeTimers();

    const docId = documents.createDocument({ initialContent: 'x' });
    const fn = vi.fn();
    scheduleFlush('left', fn, 1000, docId);

    documents.closeDocument(docId);
    vi.advanceTimersByTime(5000);

    expect(fn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('is a no-op for an unknown docId', () => {
    expect(() => documents.closeDocument(999999)).not.toThrow();
  });
});

// [12-08] getDocumentContent(docId)/replaceDocumentContent(docId, newText) --
// the one shared content-access primitive pair 12-11/12-12-PLAN.md's six
// call sites (save.js's own "reload theirs" branch chief among them) will
// consume. T-12-12/T-12-13 (this plan's own threat register): reading or
// silently preserving history for the wrong source is a data-integrity
// failure, not a crash -- covered directly below, for both the active and
// background branches.
describe('getDocumentContent / replaceDocumentContent', () => {
  it('getDocumentContent(activeDocId) reflects a dispatch made directly against the live shared view, not a possibly-stale Map entry (T-12-12)', () => {
    const docId = documents.createDocument({ initialContent: 'original' });
    documents.setActiveDocId(docId);

    documents.getActiveEditor().dispatch({
      changes: { from: 0, to: 'original'.length, insert: 'live edit' },
    });

    expect(documents.getDocumentContent(docId)).toBe('live edit');

    documents.closeDocument(docId); // cleanup
  });

  it("getDocumentContent(backgroundDocId) reads that document's own stored state, unaffected by whichever document is currently active", () => {
    const a = documents.createDocument({ initialContent: 'doc A' });
    const b = documents.createDocument({ initialContent: 'doc B' });
    documents.setActiveDocId(a); // a active, b is background

    expect(documents.getDocumentContent(b)).toBe('doc B');
    expect(documents.getDocumentContent(a)).toBe('doc A');

    documents.closeDocument(a);
    documents.closeDocument(b); // cleanup
  });

  it('getDocumentContent returns null for an unknown docId, never throws', () => {
    expect(documents.getDocumentContent(999999)).toBe(null);
  });

  it('replaceDocumentContent(activeDocId, newText) immediately updates both the live view and the Map entry', () => {
    const docId = documents.createDocument({ initialContent: 'before' });
    documents.setActiveDocId(docId);

    documents.replaceDocumentContent(docId, 'new text');

    expect(documents.getActiveEditor().state.doc.toString()).toBe('new text');
    expect(documents.getDocument(docId).state.doc.toString()).toBe('new text');

    documents.closeDocument(docId); // cleanup
  });

  it("replaceDocumentContent(backgroundDocId, newText) updates only that document's own Map entry -- the shared view (showing a different active document) is unaffected until switched to", () => {
    const a = documents.createDocument({ initialContent: 'doc A' });
    const b = documents.createDocument({ initialContent: 'doc B' });
    documents.setActiveDocId(a); // a active, b is background

    documents.replaceDocumentContent(b, 'new text');

    expect(documents.getActiveEditor().state.doc.toString()).toBe('doc A'); // unaffected
    expect(documents.getDocument(b).state.doc.toString()).toBe('new text');

    documents.setActiveDocId(b); // switch to the background document afterward
    expect(documents.getActiveEditor().state.doc.toString()).toBe('new text');

    documents.closeDocument(a);
    documents.closeDocument(b); // cleanup
  });

  it('replaceDocumentContent on the active document resets its undo stack -- mirrors the legacy `.value =` "discard means discard, including undo" contract (T-12-13)', () => {
    const docId = documents.createDocument({ initialContent: 'start' });
    documents.setActiveDocId(docId);

    documents.getActiveEditor().dispatch({
      changes: { from: 0, to: 0, insert: 'edit ' },
    });
    expect(undoDepth(documents.getActiveEditor().state)).toBeGreaterThan(0);

    documents.replaceDocumentContent(docId, 'reloaded from disk');

    expect(undoDepth(documents.getActiveEditor().state)).toBe(0);

    documents.closeDocument(docId); // cleanup
  });
});

describe('markDocumentDirty / markDocumentClean / isDocumentDirty / isAnyDocumentDirty', () => {
  it('isAnyDocumentDirty is true iff at least one open document is dirty', () => {
    expect(documents.isAnyDocumentDirty()).toBe(false);

    const docId = documents.createDocument({ initialContent: 'y' });
    documents.markDocumentDirty(docId);
    expect(documents.isDocumentDirty(docId)).toBe(true);
    expect(documents.isAnyDocumentDirty()).toBe(true);

    documents.markDocumentClean(docId);
    expect(documents.isDocumentDirty(docId)).toBe(false);
    expect(documents.isAnyDocumentDirty()).toBe(false);

    documents.closeDocument(docId); // cleanup
  });
});

describe('setDocumentMissing / getDocumentIdByPath', () => {
  it('registerDocument seeds missing: false on a fresh document', () => {
    const docId = documents.createDocument({ initialContent: 'z' });
    expect(documents.getDocument(docId).missing).toBe(false);

    documents.closeDocument(docId); // cleanup
  });

  it('setDocumentMissing(docId, true) sets the flag and adds the "missing" class to the tab element', () => {
    const docId = documents.createDocument({ initialContent: 'z' });
    const tabEl = document.createElement('div');
    tabEl.id = `tab-${docId}`;
    document.body.appendChild(tabEl);

    documents.setDocumentMissing(docId, true);

    expect(documents.getDocument(docId).missing).toBe(true);
    expect(tabEl.classList.contains('missing')).toBe(true);

    tabEl.remove();
    documents.closeDocument(docId); // cleanup
  });

  it('setDocumentMissing(docId, false) clears the flag and removes the class (recovery path)', () => {
    const docId = documents.createDocument({ initialContent: 'z' });
    const tabEl = document.createElement('div');
    tabEl.id = `tab-${docId}`;
    document.body.appendChild(tabEl);

    documents.setDocumentMissing(docId, true);
    documents.setDocumentMissing(docId, false);

    expect(documents.getDocument(docId).missing).toBe(false);
    expect(tabEl.classList.contains('missing')).toBe(false);

    tabEl.remove();
    documents.closeDocument(docId); // cleanup
  });

  it('setDocumentMissing on an unknown docId is a silent no-op, never throws', () => {
    expect(() => documents.setDocumentMissing(999999, true)).not.toThrow();
  });

  it('setDocumentMissing never touches dirty state -- the two flags are fully independent', () => {
    const docId = documents.createDocument({ initialContent: 'z' });
    documents.markDocumentDirty(docId);

    documents.setDocumentMissing(docId, true);
    expect(documents.isDocumentDirty(docId)).toBe(true); // untouched by setDocumentMissing
    expect(documents.getDocument(docId).missing).toBe(true);

    documents.markDocumentClean(docId);
    expect(documents.getDocument(docId).missing).toBe(true); // untouched by markDocumentClean

    documents.closeDocument(docId); // cleanup
  });

  it('getDocumentIdByPath returns the docId of the open document whose filePath matches, or null if none match', () => {
    const docId = documents.createDocument({ filePath: '/some/dir/note.md', initialContent: 'z' });

    expect(documents.getDocumentIdByPath('/some/dir/note.md')).toBe(docId);
    expect(documents.getDocumentIdByPath('/no/such/path.md')).toBe(null);

    documents.closeDocument(docId); // cleanup
  });
});

// This test deliberately runs LAST in this file: it closes docId 1 (the
// bootstrap document). [12-02] Unlike the textarea era, this no longer
// removes #md-input from the DOM -- the one shared EditorView node stays
// mounted for the app's whole lifetime; only the Map entry and its retained
// EditorState go away. Every test above still assumes docId 1 exists.
describe('closing the last open document', () => {
  it('auto-creates a fresh Untitled document and activates it -- never leaves zero documents open', () => {
    const originalId = documents.getActiveDocId();
    expect(documents.getDocument(originalId)).toBeTruthy();
    const originalState = documents.getDocument(originalId).state;

    documents.closeDocument(originalId);

    const newId = documents.getActiveDocId();
    expect(newId).not.toBe(originalId);
    const newDoc = documents.getDocument(newId);
    expect(newDoc).toBeTruthy();
    expect(newDoc.state).not.toBe(originalState);
    expect(documents.getActiveEditor().state.doc.toString()).toBe(''); // visible -- the sole remaining, active document
    expect(newDoc.dirty).toBe(false);
  });
});
