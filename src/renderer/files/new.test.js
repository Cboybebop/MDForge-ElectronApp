// @vitest-environment jsdom
//
// [12-REVIEW.md CR-02] newFile() was one of the three call sites that used
// to call setActiveDocId() WITHOUT flushing the outgoing document's pending
// sync-controller debounce first -- reachable by chaining a keystroke into
// Ctrl+N. Uses documents.js's REAL Map (same "build the DOM fixture BEFORE
// importing" pattern documents.test.js/open.test.js already establish) so
// this test exercises the real setActiveDocId()/flush() interaction, not a
// stub of it.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../command-dispatch.js', () => ({
  registerCommand: vi.fn(),
}));

vi.mock('../markdown/render.js', () => ({
  renderMarkdown: vi.fn(),
}));

vi.mock('../tabs/tab-bar.js', () => ({
  renderTabBar: vi.fn(),
}));

let documents;
let scheduleFlush;
let newFile;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <div id="md-input"></div>
    </div>
    <div id="preview" contenteditable="true"></div>
    <div id="empty-state"></div>
    <input type="checkbox" id="toggle-sync-scroll" checked />
    <button id="btn-new"></button>
    <button id="btn-save" disabled></button>
  `;

  window.mdforge = {
    setWindowTitleInfo: vi.fn(),
  };

  documents = await import('../documents.js');
  ({ scheduleFlush } = await import('../markdown/sync-controller.js'));
  ({ newFile } = await import('./new.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('newFile() -- CR-02 regression', () => {
  it("flushes the outgoing document's pending sync-controller debounce before switching to the new blank tab, so a stale timer can never resolve against the new document", () => {
    vi.useFakeTimers();

    const outgoingId = documents.getActiveDocId();
    const resolvedDocIds = [];
    // Mirrors editor-events.js's own scheduleFlush('preview', () =>
    // renderMarkdown(...), 60, docId) call shape -- the scheduled function
    // reads getActiveDocId() itself, at fire time, exactly like production.
    scheduleFlush(
      'preview',
      () => resolvedDocIds.push(documents.getActiveDocId()),
      60,
      outgoingId
    );

    newFile(); // no explicit flush() call from this test -- exactly the real Ctrl+N call site

    const newId = documents.getActiveDocId();
    expect(newId).not.toBe(outgoingId);

    // The outgoing document's pending callback must have already run,
    // synchronously, during newFile()'s own setActiveDocId() call --
    // resolving getActiveDocId() as the OUTGOING document, never the new one.
    expect(resolvedDocIds).toEqual([outgoingId]);

    vi.advanceTimersByTime(1000);
    expect(resolvedDocIds).toEqual([outgoingId]); // never fires a second time later, against the new doc

    documents.closeDocument(newId);
    documents.markDocumentClean(outgoingId);
    vi.useRealTimers();
  });
});
