// @vitest-environment jsdom
//
// Unit tests for editor-events.js's createSyncExtensions(docId) -- 12-03
// Task 2 rewrote this suite from a bare `<textarea>` DOM-event harness into
// one that constructs real CM6 EditorState/EditorView objects and dispatches
// real transactions against them, mirroring 12-01-PLAN.md Task 1's
// cm-dispatch.test.js construct-a-real-EditorState-under-jsdom pattern
// (12-RESEARCH.md section 9: construct+dispatch+inspect is jsdom-reliable;
// only real typed-input/focus/layout-dependent behaviour is not).
//
// The debounced, composition-gated, echo-suppressing flow and the Tab-key
// handler are otherwise unchanged in INTENT from 03-03/03-06/03-REVIEW.md
// CR-02 -- only the mechanism (DOM listeners -> CM6 extensions; the old
// origin-skip-set/getActiveOrigin check -> the appWriteOrigin annotation)
// changed, per editor-events.js's own header comment.
//
// markDocumentDirty (documents.js) and scheduleFlush (sync-controller.js)
// are named-export dependencies createSyncExtensions's returned extensions
// call directly -- vi.mock() (not vi.spyOn on a namespace object) is the
// only reliable way to intercept a named ES-module export under Vitest
// (this file's own pre-12-03 header comment already established this
// empirically). beginWrite/endWrite are left as the REAL sync-controller.js
// implementations (via importActual) because dispatchAppWrite() (imported
// from cm-dispatch.js, used by the echo-suppression test below to build a
// realistic app-write transaction exactly the way production call sites
// will) calls them for its own bookkeeping -- unrelated to what these tests
// assert, but must not throw. documents.js itself is mocked wholesale (not
// just markDocumentDirty) so this file never needs a real document-registry
// fixture just to satisfy documents.js's own module-load-time bootstrap
// wiring -- editor-events.js only imports markDocumentDirty from it.

import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

vi.mock('../documents.js', () => ({
  markDocumentDirty: vi.fn(),
}));

vi.mock('./sync-controller.js', async () => {
  const actual = await vi.importActual('./sync-controller.js');
  return {
    ...actual,
    scheduleFlush: vi.fn(),
  };
});

import { markDocumentDirty } from '../documents.js';
import { scheduleFlush } from './sync-controller.js';
import { appWriteOrigin, dispatchAppWrite } from './cm-dispatch.js';
import { createSyncExtensions } from './editor-events.js';

// Arbitrary, deliberately NOT sync-controller.js's DEFAULT_DOC_ID (1) --
// proves the wiring genuinely threads the docId createSyncExtensions was
// called with, rather than silently falling back to the legacy default.
const TEST_DOC_ID = 42;

// Builds a real EditorState/EditorView pair whose extensions include
// createSyncExtensions(TEST_DOC_ID) (the module under test) plus a small
// local capturing updateListener, so tests can read back the annotations
// actually attached to the most recent dispatch's transactions -- mirrors
// cm-dispatch.test.js's own mountCapturingView() helper exactly.
function mountView(doc = '') {
  let lastTransactions = [];
  const state = EditorState.create({
    doc,
    extensions: [
      ...createSyncExtensions(TEST_DOC_ID),
      EditorView.updateListener.of((update) => {
        if (update.transactions.length > 0) lastTransactions = update.transactions;
      }),
    ],
  });
  const view = new EditorView({ state, parent: document.createElement('div') });
  return { view, getLastTransactions: () => lastTransactions };
}

describe('createSyncExtensions -- echo suppression (the annotation is the SOLE gate)', () => {
  it('does not call scheduleFlush/markDocumentDirty for a dispatchAppWrite-tagged transaction', () => {
    const { view } = mountView('hello');
    vi.clearAllMocks();

    dispatchAppWrite(view, { from: 0, to: 0, insert: 'x' }, 'user-right', TEST_DOC_ID);

    expect(scheduleFlush).not.toHaveBeenCalled();
    expect(markDocumentDirty).not.toHaveBeenCalled();

    view.destroy();
  });

  it('calls scheduleFlush(preview, fn, 60, docId) and markDocumentDirty(docId) for a plain, un-annotated dispatch (genuine user edit)', () => {
    const { view } = mountView('hello');
    vi.clearAllMocks();

    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });

    expect(scheduleFlush).toHaveBeenCalledTimes(1);
    expect(scheduleFlush).toHaveBeenCalledWith('preview', expect.any(Function), 60, TEST_DOC_ID);
    expect(markDocumentDirty).toHaveBeenCalledWith(TEST_DOC_ID);

    view.destroy();
  });

  it('does not call scheduleFlush/markDocumentDirty for a selection-only update (no doc change) -- proves the docChanged guard', () => {
    const { view } = mountView('hello');
    vi.clearAllMocks();

    view.dispatch({ selection: { anchor: 0 } });

    expect(scheduleFlush).not.toHaveBeenCalled();
    expect(markDocumentDirty).not.toHaveBeenCalled();

    view.destroy();
  });

  it('checks EVERY transaction in a batched update, not just the first -- a mixed tagged/untagged batch still syncs (T-12-06)', () => {
    const { view, getLastTransactions } = mountView('hello');
    vi.clearAllMocks();

    // Build two chained Transactions by hand (state.update() returns a
    // Transaction without dispatching it) so both land inside ONE
    // ViewUpdate when dispatched together -- the exact shape PITFALLS.md
    // Pitfall 1's second leak warns about: a batch with one tagged
    // (app-write) transaction and one untagged (genuine user edit) must not
    // be silently treated as fully app-originated.
    const tr1 = view.state.update({
      changes: { from: 0, to: 0, insert: 'A' },
      annotations: [appWriteOrigin.of('user-right')],
    });
    const tr2 = tr1.state.update({ changes: { from: 0, to: 0, insert: 'B' } });

    view.dispatch([tr1, tr2]);

    expect(getLastTransactions().length).toBe(2);
    expect(scheduleFlush).toHaveBeenCalledTimes(1);
    expect(markDocumentDirty).toHaveBeenCalledWith(TEST_DOC_ID);

    view.destroy();
  });
});

describe('createSyncExtensions -- composition gating (same factory, retargeted to CM6 contentDOM events)', () => {
  it('does not sync while composing (compositionstart on contentDOM followed by a real doc change)', () => {
    const { view } = mountView('hello');
    vi.clearAllMocks();

    view.contentDOM.dispatchEvent(new Event('compositionstart'));
    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });

    expect(scheduleFlush).not.toHaveBeenCalled();
    expect(markDocumentDirty).not.toHaveBeenCalled();

    view.contentDOM.dispatchEvent(new Event('compositionend'));
    view.destroy();
  });

  it('resumes scheduling on the doc change following compositionend', () => {
    const { view } = mountView('hello');
    vi.clearAllMocks();

    view.contentDOM.dispatchEvent(new Event('compositionstart'));
    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });
    expect(scheduleFlush).not.toHaveBeenCalled();

    view.contentDOM.dispatchEvent(new Event('compositionend'));
    view.dispatch({ changes: { from: 0, to: 0, insert: 'y' } });

    expect(scheduleFlush).toHaveBeenCalledTimes(1);
    expect(markDocumentDirty).toHaveBeenCalledTimes(1);

    view.destroy();
  });

  it('gives each createSyncExtensions(docId) call its own composition gate -- composing on one document does not gate another', () => {
    const a = mountView('hello');
    const b = (() => {
      let lastTransactions = [];
      const state = EditorState.create({
        doc: 'world',
        extensions: [
          ...createSyncExtensions(200),
          EditorView.updateListener.of((update) => {
            if (update.transactions.length > 0) lastTransactions = update.transactions;
          }),
        ],
      });
      const view = new EditorView({ state, parent: document.createElement('div') });
      return { view, getLastTransactions: () => lastTransactions };
    })();
    vi.clearAllMocks();

    a.view.contentDOM.dispatchEvent(new Event('compositionstart'));
    b.view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });

    expect(scheduleFlush).toHaveBeenCalledTimes(1);
    expect(scheduleFlush).toHaveBeenCalledWith('preview', expect.any(Function), 60, 200);

    a.view.contentDOM.dispatchEvent(new Event('compositionend'));
    a.view.destroy();
    b.view.destroy();
  });
});

describe('createSyncExtensions -- Tab key (genuine user input, never app-write-annotated)', () => {
  // A real 'keydown' DOM event dispatched on view.contentDOM -- not
  // runScopeHandlers() (a lower-level test utility that runs the keymap's
  // command directly without going through CM6's own domEventHandlers
  // dispatch pipeline, and therefore never calls event.preventDefault()
  // itself). Dispatching the real event exercises the exact same path a
  // genuine keystroke takes in the running app, including the
  // preventDefault-on-handled-true behaviour the keymap facet's own
  // domEventHandlers wrapper provides (@codemirror/view source, confirmed
  // this session: `handleKeyEvents`'s keydown handler runs the keymap via
  // `runHandlers`, and the class-level `runHandlers(type, event)` dispatch
  // loop calls `event.preventDefault()` whenever a handler returns true).
  it("Tab inserts two spaces via the keymap, syncs like any other keystroke, and carries NO appWriteOrigin annotation", () => {
    const { view, getLastTransactions } = mountView('');
    vi.clearAllMocks();

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe('  ');
    expect(event.defaultPrevented).toBe(true);

    const [tr] = getLastTransactions();
    expect(tr).toBeTruthy();
    // Mirrors the production updateListener's own `!= null` check -- the
    // SYNC-14/undo-table distinction this test exists to prove: a Tab
    // keystroke is genuine user input and must never carry the app-write
    // annotation, or it would be silently filtered out of the sync loop
    // exactly like an app-originated echo.
    expect(tr.annotation(appWriteOrigin) == null).toBe(true);

    // Genuine user input syncs like any other keystroke -- Tab is
    // deliberately NOT routed through dispatchAppWrite(), so it must not be
    // suppressed by the echo-suppression check above.
    expect(scheduleFlush).toHaveBeenCalledWith('preview', expect.any(Function), 60, TEST_DOC_ID);
    expect(markDocumentDirty).toHaveBeenCalledWith(TEST_DOC_ID);

    view.destroy();
  });
});
