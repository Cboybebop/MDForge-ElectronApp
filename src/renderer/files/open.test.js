// @vitest-environment jsdom
//
// WR-01 (07-REVIEW.md): 07-UI-SPEC.md Surface 4's locked Recovery contract
// documents a third recovery path -- "clicking the tree row for a
// recreated file whose tab is still open just focuses that tab" -- which
// openFileAtPath()'s existing-tab branch (applyOpenedFile) is the single
// entry point for (tree clicks, drag-drop, the .md file association, and
// second-instance argv all route through this exact function, per this
// file's own header comment). Same "build the DOM fixture BEFORE importing"
// pattern documents.test.js/save.test.js already established.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../command-dispatch.js', () => ({
  registerCommand: vi.fn(),
}));

vi.mock('../markdown/render.js', () => ({
  renderMarkdown: vi.fn(),
}));

vi.mock('../status.js', () => ({
  showStatus: vi.fn(),
}));

vi.mock('../tabs/tab-bar.js', () => ({
  renderTabBar: vi.fn(),
}));

let documents;
let scheduleFlush;
let openFileAtPath;
let mdforgeOpenAtPath;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <textarea id="md-input" spellcheck="false" placeholder="Start typing..."></textarea>
    </div>
    <div id="preview" contenteditable="true"></div>
    <input type="checkbox" id="toggle-sync-scroll" checked />
    <button id="btn-open"></button>
    <button id="btn-save" disabled></button>
  `;

  window.mdforge = {
    openAtPath: (...args) => mdforgeOpenAtPath(...args),
    openFile: vi.fn(),
    addRecentDocument: vi.fn(),
    reportOpenFailure: vi.fn(),
    setWindowTitleInfo: vi.fn(),
  };

  documents = await import('../documents.js');
  ({ scheduleFlush } = await import('../markdown/sync-controller.js'));
  ({ openFileAtPath } = await import('./open.js'));
});

beforeEach(() => {
  mdforgeOpenAtPath = vi.fn(async (path) => ({ path, text: `content:${path}`, name: path.split(/[\\/]/).pop() }));
});

describe('openFileAtPath -- existing-tab focus branch', () => {
  it('WR-01: focusing an already-open `.missing` tab clears the flag once the path is proven to exist again', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\recreated.md', initialContent: 'old' });
    documents.setDocumentMissing(docId, true);
    expect(documents.getDocument(docId).missing).toBe(true);

    await openFileAtPath('C:\\notes\\recreated.md');

    expect(documents.getDocumentIds()).toContain(docId); // focused the SAME tab, not a duplicate
    expect(documents.getDocument(docId).missing).toBe(false);

    documents.closeDocument(docId);
  });

  it('does not affect `.missing` for a document that was never missing', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\ordinary.md', initialContent: 'old' });

    await openFileAtPath('C:\\notes\\ordinary.md');

    expect(documents.getDocument(docId).missing).toBe(false);

    documents.closeDocument(docId);
  });
});

// [12-REVIEW.md CR-02] applyOpenedFile() has TWO setActiveDocId() call sites
// -- the existing-tab focus branch above, and the brand-new-tab branch below
// -- both of which used to switch the active document WITHOUT flushing the
// outgoing document's pending sync-controller debounce first. Reachable by
// chaining a keystroke into Ctrl+O / opening a file via drag-drop/Open
// Recent while a debounced preview render was still pending on the
// previously active tab.
describe('openFileAtPath -- CR-02 regression: flushes the outgoing document before switching', () => {
  it('existing-tab focus branch flushes the outgoing document before re-activating the already-open tab', async () => {
    vi.useFakeTimers();

    const existingId = documents.createDocument({ filePath: 'C:\\notes\\already-open.md', initialContent: 'old' });
    const outgoingId = documents.getActiveDocId();
    expect(outgoingId).not.toBe(existingId);

    const resolvedDocIds = [];
    scheduleFlush(
      'preview',
      () => resolvedDocIds.push(documents.getActiveDocId()),
      60,
      outgoingId
    );

    await openFileAtPath('C:\\notes\\already-open.md'); // no explicit flush() call from this test

    expect(documents.getActiveDocId()).toBe(existingId);
    // The outgoing document's pending callback must have already run,
    // synchronously, during the switch -- resolving getActiveDocId() as the
    // OUTGOING document, never the one just focused.
    expect(resolvedDocIds).toEqual([outgoingId]);

    vi.advanceTimersByTime(1000);
    expect(resolvedDocIds).toEqual([outgoingId]); // never fires again later, against the focused doc

    documents.closeDocument(existingId);
    vi.useRealTimers();
  });

  it('brand-new-tab branch flushes the outgoing document before activating the newly created tab', async () => {
    vi.useFakeTimers();

    const outgoingId = documents.getActiveDocId();
    const resolvedDocIds = [];
    scheduleFlush(
      'preview',
      () => resolvedDocIds.push(documents.getActiveDocId()),
      60,
      outgoingId
    );

    await openFileAtPath('C:\\notes\\brand-new.md'); // creates and activates a new tab

    const newId = documents.getActiveDocId();
    expect(newId).not.toBe(outgoingId);
    expect(resolvedDocIds).toEqual([outgoingId]);

    vi.advanceTimersByTime(1000);
    expect(resolvedDocIds).toEqual([outgoingId]);

    documents.closeDocument(newId);
    vi.useRealTimers();
  });
});
