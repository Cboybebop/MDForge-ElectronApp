// @vitest-environment jsdom
//
// session-writer.js self-wires a #tab-bar MutationObserver, a single direct
// 'scroll' listener on the shared CM6 view's scrollDOM (12-12 CM6 retarget --
// see session-writer.js's own header comment for why the former per-node
// MutationObserver on #left-pane is gone), and a window `blur` listener, all
// at module load time (documents.js's own established convention) -- every
// test builds the #tab-bar DOM fixture and stubs getActiveEditor() BEFORE
// importing the module fresh via vi.resetModules() + await import(...),
// following recovery-banner.test.js's own idiom for a self-wiring module:
// module-load-time DOM lookups and getActiveEditor() calls mean the fixture
// and mock must exist before the module is first imported in each test.
// ../documents.js and ../drafts/draft-journal.js are mocked so this suite
// controls exactly what "the current tab set" and "the shared view" look
// like per test, without a full documents.js DOM fixture. `vi.useFakeTimers()`
// is mandatory: a real 500ms setTimeout must never be armed and left
// pending past this test file's own lifetime.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../documents.js', () => ({
  getDocumentIds: vi.fn(),
  getDocument: vi.fn(),
  getActiveDocId: vi.fn(),
  getActiveEditor: vi.fn(),
}));

vi.mock('../drafts/draft-journal.js', () => ({
  getKnownDraftUuid: vi.fn(),
}));

import { getDocumentIds, getDocument, getActiveDocId, getActiveEditor } from '../documents.js';
import { getKnownDraftUuid } from '../drafts/draft-journal.js';

function buildFixture() {
  document.body.innerHTML = `
    <div id="tab-bar"></div>
  `;
}

function stubDocs(docs, activeDocId) {
  getDocumentIds.mockReturnValue(docs.map((d) => d.docId));
  getDocument.mockImplementation((docId) => docs.find((d) => d.docId === docId));
  getActiveDocId.mockReturnValue(activeDocId);
}

describe('session-writer.js', () => {
  let writeSessionState, flushSessionStateNow, buildSessionState;
  // The SAME object getActiveEditor() returns at module-import time -- the
  // module captures it once, at module load, to attach its single direct
  // 'scroll' listener (session-writer.js's own module-load-time wiring).
  // Tests read/write `activeScrollDom.scrollTop` to control what
  // buildSessionState()'s active-tab branch reads live, and dispatch real
  // 'scroll' events on it to prove the listener genuinely fires.
  let activeScrollDom;
  // `window` itself (unlike the DOM fixture rebuilt per test) persists
  // across tests within this file -- each fresh `vi.resetModules()` +
  // `await import(...)` re-runs the module's self-wiring `window.addEventListener('blur', ...)`
  // call again, which would otherwise accumulate one extra listener per
  // test. Captured via a spy and removed in afterEach so each test starts
  // with exactly the one blur listener its own fresh import just added.
  let capturedBlurListeners = [];

  // Every fresh import (whether the outer beforeEach's own, or a SECOND one
  // a test triggers deliberately to re-exercise module-load-time wiring
  // under different mock conditions) must have its window 'blur' listener
  // captured and later removed -- otherwise a second import's listener
  // silently survives into a LATER test's own window and double-fires it
  // (each fresh import's closure calls window.mdforge.saveSessionState via
  // whichever module instance registered it).
  async function importFresh() {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const mod = await import('./session-writer.js');
    for (const call of addEventListenerSpy.mock.calls) {
      if (call[0] === 'blur') capturedBlurListeners.push(call[1]);
    }
    addEventListenerSpy.mockRestore();
    return mod;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    getDocumentIds.mockReset();
    getDocument.mockReset();
    getActiveDocId.mockReset();
    getKnownDraftUuid.mockReset();
    getActiveEditor.mockReset();
    window.mdforge = { saveSessionState: vi.fn() };
    buildFixture();

    activeScrollDom = document.createElement('div');
    activeScrollDom.scrollTop = 0;
    // [15-01] `.state` is a minimal hand-built stand-in (this file's own
    // existing style, since this suite mocks documents.js wholesale rather
    // than constructing real CM6 state) exposing only the `toJSON` method
    // serializeHistoryForTab() actually calls -- not a real EditorState.
    getActiveEditor.mockReturnValue({
      scrollDOM: activeScrollDom,
      state: { toJSON: () => ({ doc: 'active doc', selection: {}, history: {} }) },
    });

    vi.resetModules();
    ({ writeSessionState, flushSessionStateNow, buildSessionState } = await importFresh());
  });

  afterEach(() => {
    for (const listener of capturedBlurListeners) {
      window.removeEventListener('blur', listener);
    }
    capturedBlurListeners = [];
    vi.useRealTimers();
    delete window.mdforge;
  });

  describe('buildSessionState', () => {
    it("activeIndex matches getDocumentIds().indexOf(getActiveDocId()), tabs keyed by path or draft uuid", () => {
      // [CR-03, 06-REVIEW.md; 12-12 CM6 retarget] docId 1 is INACTIVE here --
      // its scrollTop must come from documents.js's own `doc.scrollTop`
      // cache field (mirroring the live value FROM THE LAST TIME it was
      // visible), never from the shared view's live scrollDOM, since that
      // scrollDOM only ever reflects whichever document is CURRENTLY active.
      // docId 2 IS active, so its scrollTop is read live off
      // getActiveEditor().scrollDOM.scrollTop.
      stubDocs(
        [
          { docId: 1, filePath: 'C:\\docs\\a.md', scrollTop: 10 },
          { docId: 2, filePath: null, scrollTop: 0 },
        ],
        2
      );
      activeScrollDom.scrollTop = 20;
      getKnownDraftUuid.mockImplementation((docId) => (docId === 2 ? 'uuid-2' : undefined));

      const state = buildSessionState();

      expect(state.activeIndex).toBe(1);
      expect(state.tabs).toEqual([
        // docId 1 is background and its fixture has no `.state`, so
        // serializeHistoryForTab's defensive null-on-missing-state path
        // holds (Task 2's own contract).
        { filePath: 'C:\\docs\\a.md', draftUuid: null, scrollTop: 10, history: null },
        // docId 2 is active -- its history is read from getActiveEditor().state
        // (this file's stubbed `.toJSON()`), via serializeHistoryForTab.
        { filePath: null, draftUuid: 'uuid-2', scrollTop: 20, history: JSON.stringify({ doc: 'active doc', selection: {}, history: {} }) },
      ]);
    });

    it('reports draftUuid: null for an untitled document with no known draft yet', () => {
      stubDocs([{ docId: 1, filePath: null, scrollTop: 0 }], 1);
      getKnownDraftUuid.mockReturnValue(undefined);

      const state = buildSessionState();

      expect(state.tabs[0].draftUuid).toBeNull();
    });

    it('CR-03: a BACKGROUND (inactive) tab reports its cached doc.scrollTop, not the shared view scrollDOM (which reflects a different, active document)', () => {
      stubDocs(
        [
          { docId: 1, filePath: null, scrollTop: 0 },
          // docId 2 is inactive; its cache field holds the real
          // last-known-visible value (250). The shared scrollDOM's live
          // scrollTop belongs to docId 1 (the active tab) and must never
          // leak into docId 2's reported value.
          { docId: 2, filePath: null, scrollTop: 250 },
        ],
        1
      );
      activeScrollDom.scrollTop = 0;

      const state = buildSessionState();

      expect(state.tabs[1].scrollTop).toBe(250);
    });

    // [15-01, PERS-11] buildSessionState() must emit a `history` field per
    // tab, sourced via serializeHistoryForTab -- the same active/background
    // split scrollTop already uses.
    it('emits a history field per tab, sourced via serializeHistoryForTab (active tab), and null when a background tab\'s .state is absent/undefined', () => {
      stubDocs(
        [
          // No `.state` field at all -- serializeHistoryForTab's own
          // defensive null-on-missing-state path (Task 2) must hold here.
          { docId: 1, filePath: 'C:\\docs\\a.md', scrollTop: 0 },
          { docId: 2, filePath: null, scrollTop: 0 },
        ],
        2
      );

      const state = buildSessionState();

      expect(state.tabs[0].history).toBeNull();
      expect(state.tabs[1].history).toBe(JSON.stringify({ doc: 'active doc', selection: {}, history: {} }));
    });
  });

  describe('debounced #tab-bar mutation writes', () => {
    it('coalesces three rapid mutations into exactly one saveSessionState call, carrying the LATEST state', async () => {
      stubDocs([{ docId: 1, filePath: null, scrollTop: 0 }], 1);
      const tabBar = document.getElementById('tab-bar');

      tabBar.appendChild(document.createElement('div'));
      await Promise.resolve();

      tabBar.appendChild(document.createElement('div'));
      await Promise.resolve();

      // Change the stubbed state before the THIRD mutation, so "the latest
      // state" is actually distinguishable from the state at the first two.
      stubDocs(
        [
          { docId: 1, filePath: null, scrollTop: 0 },
          { docId: 2, filePath: null, scrollTop: 0 },
        ],
        2
      );
      tabBar.appendChild(document.createElement('div'));
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(500);

      expect(window.mdforge.saveSessionState).toHaveBeenCalledTimes(1);
      expect(window.mdforge.saveSessionState).toHaveBeenCalledWith(
        expect.objectContaining({ activeIndex: 1, tabs: expect.arrayContaining([expect.anything()]) })
      );
      expect(window.mdforge.saveSessionState.mock.calls[0][0].tabs).toHaveLength(2);
    });
  });

  describe('scroll on the shared view scrollDOM', () => {
    // [12-12] This is the NEW mechanism replacing the former per-`.doc-
    // surface` MutationObserver -- session-writer.js attaches exactly ONE
    // direct 'scroll' listener, at module load, to the exact object
    // getActiveEditor() returns at that moment (`activeScrollDom` here).
    // Dispatching a real 'scroll' event on that SAME object is what proves
    // the listener genuinely fires, not merely that buildSessionState()'s
    // field read was renamed.
    it('triggers a debounced write when the shared view scrollDOM fires a scroll event', async () => {
      stubDocs([{ docId: 1, filePath: null, scrollTop: 0 }], 1);

      activeScrollDom.dispatchEvent(new Event('scroll'));

      await vi.advanceTimersByTimeAsync(500);

      expect(window.mdforge.saveSessionState).toHaveBeenCalledTimes(1);
    });

    it('does not throw at module load when getActiveEditor() returns null (no shared view mounted yet)', async () => {
      getActiveEditor.mockReturnValue(null);
      vi.resetModules();

      await expect(importFresh()).resolves.toBeDefined();
    });
  });

  describe('window blur', () => {
    it('triggers an immediate write with no fake-timer advance needed', () => {
      stubDocs([{ docId: 1, filePath: null, scrollTop: 5 }], 1);

      window.dispatchEvent(new Event('blur'));

      expect(window.mdforge.saveSessionState).toHaveBeenCalledTimes(1);
    });

    it('clears a pending debounced write so it does not ALSO fire after the flush', async () => {
      stubDocs([{ docId: 1, filePath: null, scrollTop: 0 }], 1);
      writeSessionState();

      window.dispatchEvent(new Event('blur'));
      await vi.advanceTimersByTimeAsync(500);

      expect(window.mdforge.saveSessionState).toHaveBeenCalledTimes(1);
    });
  });

  describe('no window.mdforge bridge', () => {
    it('never arms a real timer when writeSessionState() is called', () => {
      delete window.mdforge;
      stubDocs([{ docId: 1, filePath: null, scrollTop: 0 }], 1);
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      writeSessionState();

      expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it('flushSessionStateNow() is a safe no-op with no bridge', () => {
      delete window.mdforge;
      stubDocs([{ docId: 1, filePath: null, scrollTop: 0 }], 1);

      expect(() => flushSessionStateNow()).not.toThrow();
    });
  });

  describe('module load without a DOM fixture', () => {
    it('does not throw when #tab-bar is absent', async () => {
      document.body.innerHTML = '';
      vi.resetModules();

      await expect(importFresh()).resolves.toBeDefined();
    });
  });
});
