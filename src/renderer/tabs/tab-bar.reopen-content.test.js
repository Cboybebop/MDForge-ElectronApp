// @vitest-environment jsdom
//
// [12-REVIEW.md CR-01] Regression proof for closeTab()'s stale-content bug.
// tab-bar.test.js mocks documents.js WHOLESALE (a hand-built `mockState.docs`
// Map with a fixed `state.doc.toString()` per docId), which per that file's
// own header comment cannot exercise the real active/background split
// documents.js's getDocumentContent() exists to resolve -- CR-01 lived
// exactly in that gap. This file uses the REAL documents.js and REAL
// command-dispatch.js/closed-stack.js instead (only render.js, files/save.js,
// and workspace/reconcile.js are mocked, mirroring documents.test.js's own
// "build the DOM fixture BEFORE importing" pattern), so the exact reported
// reproduction -- type into the active, never-switched-away-from tab, close
// it, reopen it -- runs against the real Map/EditorState split the bug lived
// in.
//
// This test was run BEFORE the fix (temporarily reverting tab-bar.js's
// `getDocumentContent(docId)` read back to `finalDoc.state.doc.toString()`)
// and confirmed red (`expect(content).toBe('hello')` received `''`) --
// exactly CR-01's reported reproduction, no timing race required.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../markdown/render.js', () => ({
  renderMarkdown: vi.fn(),
}));

vi.mock('../files/save.js', () => ({
  saveFile: vi.fn(),
  saveFileAs: vi.fn(),
}));

vi.mock('../workspace/reconcile.js', () => ({
  checkPendingBannerForActiveDoc: vi.fn(),
}));

let documents;
let dispatch;
let COMMAND_IDS;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  document.body.innerHTML = `
    <div id="left-pane">
      <div id="md-input"></div>
    </div>
    <div id="preview" contenteditable="true"></div>
    <div id="empty-state"></div>
    <input type="checkbox" id="toggle-sync-scroll" checked />
    <div id="tab-bar" role="tablist" aria-label="Open documents"></div>
    <div id="editor-area"></div>
  `;

  // jsdom does not implement Element.scrollIntoView -- same stub
  // tab-bar.test.js already establishes for this module's own real calls.
  Element.prototype.scrollIntoView = vi.fn();

  window.mdforge = {
    onMenuCommand: vi.fn(),
    setWindowTitleInfo: vi.fn(),
    // Resolves 'dont-save' -- this test's dirty document should close
    // immediately without a real Save round trip, exactly like closing an
    // unsaved scratch document and choosing "Don't Save".
    confirmCloseTab: vi.fn(() => Promise.resolve('dont-save')),
  };

  documents = await import('../documents.js');
  await import('./tab-bar.js'); // self-wires: registers TAB_CLOSE/TAB_REOPEN
  ({ dispatch } = await import('../command-dispatch.js'));
  ({ COMMAND_IDS } = await import('../../shared/command-ids.js'));
});

describe('CR-01 regression: reopen-tab restores the LIVE content of a never-switched-away-from active tab', () => {
  it('typing into the bootstrap tab (active from launch, never switched away from), closing it, and reopening it via Ctrl+Shift+T restores exactly what was typed', async () => {
    const originalId = documents.getActiveDocId();

    // Real keystroke: dispatch directly against the shared view, exactly as
    // CM6's own default keymap would for a genuine typed character -- no
    // annotation, so createSyncExtensions(docId)'s updateListener treats it
    // as ordinary user input and marks the document dirty for real.
    documents.getActiveEditor().dispatch({
      changes: { from: 0, to: 0, insert: 'hello' },
    });
    expect(documents.isDocumentDirty(originalId)).toBe(true);

    // X-click / Ctrl+W / middle-click all route through the same closeTab()
    // -- COMMAND_IDS.TAB_CLOSE (registered by menu.js's real accelerator in
    // production) is this suite's existing idiom (tab-bar.test.js) for
    // driving it without a synthetic DOM click.
    dispatch(COMMAND_IDS.TAB_CLOSE);
    // closeTab() is async (awaits confirmCloseTab()) -- flush past that
    // microtask before asserting, exactly like tab-bar.test.js's own
    // TAB_CLOSE tests.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(documents.getDocument(originalId)).toBeUndefined(); // genuinely closed

    // Ctrl+Shift+T: pop the just-closed entry back off closed-stack.js's
    // stack.
    dispatch(COMMAND_IDS.TAB_REOPEN);

    const reopenedId = documents.getActiveDocId();
    expect(reopenedId).not.toBe(originalId); // a brand-new document, not the closed one

    // The bug (CR-01): closeTab() used to read `finalDoc.state.doc.toString()`
    // directly off documents.js's Map entry, which for the ACTIVE document is
    // only refreshed by setActiveDocId() on a switch -- never by typing. That
    // stale, pre-edit ('') content is what the reopen stack captured, and
    // what this reopened tab would show. The fix reads getDocumentContent(),
    // which resolves the live shared-view content for the active document.
    expect(documents.getDocumentContent(reopenedId)).toBe('hello');
    expect(documents.getActiveEditor().state.doc.toString()).toBe('hello');
  });

  it("the same fix also protects the Save path: a save does not refresh the Map's cached state, so closing (and reopening) right after a save must still read the live content, not the pre-save cache", async () => {
    const originalId = documents.getActiveDocId();

    documents.getActiveEditor().dispatch({
      changes: { from: 0, to: 0, insert: 'saved content' },
    });
    // Simulates a completed save without going through files/save.js (mocked
    // in this file) -- markDocumentClean() alone is what a real save calls on
    // success; it does not touch `doc.state` (documents.js never refreshes
    // the ACTIVE document's Map-cached state except on a tab switch).
    documents.markDocumentClean(originalId);
    documents.setDocumentFilePath(originalId, 'C:\\scratch\\saved.md');

    dispatch(COMMAND_IDS.TAB_CLOSE); // clean document -- closeTab() skips the confirm prompt entirely
    await new Promise((resolve) => setTimeout(resolve, 0));

    dispatch(COMMAND_IDS.TAB_REOPEN);

    const reopenedId = documents.getActiveDocId();
    expect(documents.getDocumentContent(reopenedId)).toBe('saved content');
    expect(documents.getDocument(reopenedId).filePath).toBe('C:\\scratch\\saved.md');
  });
});
