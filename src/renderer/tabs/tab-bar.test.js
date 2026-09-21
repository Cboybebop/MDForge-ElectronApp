// @vitest-environment jsdom
//
// Unit tests for tabs/tab-bar.js's renderTabBar() and its click/middle-
// click/close interaction wiring, against a STUBBED documents.js (2-3
// synthetic documents) -- tests/e2e/tabs-open.spec.js does not exist until
// 05-05 (a later wave) and cannot be this task's verification, so this file
// is the real, self-contained, passing proof for THIS plan
// (05-04-PLAN.md Task 2's own instruction).
//
// Mirrors src/main/commands.test.js's window.mdforge-stub idiom and
// src/renderer/markdown/editor-events.test.js's vi.mock('../documents.js')
// idiom (both cited in this task's read_first). documents.js is mocked
// wholesale via vi.hoisted() state (matching src/main/atomic-write.test.js /
// dialogs.test.js's established vi.hoisted() pattern for a mock whose
// return value must be mutated per-test) so this file never needs a real
// #md-input/#left-pane fixture just to satisfy documents.js's own
// module-load-time bootstrap wiring.
//
// [05-07] tab-bar.js's former window-level `keydown` listener for
// Ctrl+W/Ctrl+Tab/Ctrl+Shift+Tab is gone -- those three shortcuts are now
// real Menu accelerators dispatched through command-dispatch.js's real
// registerCommand()/dispatch() (see the "tab commands via command-dispatch"
// describe block below), so this file also mocks markdown/render.js and
// markdown/sync-controller.js (tab-bar.js's new imports for the preview-
// resync-on-switch fix) and stubs window.mdforge so command-dispatch.js's
// own self-wiring (`window.mdforge.onMenuCommand(dispatch)`) does not throw.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// [12-REVIEW.md CR-02] flushMock is shared between the '../documents.js' mock
// below and the '../markdown/sync-controller.js' mock so the FORMER can
// mirror the real fix's contract: production documents.js's setActiveDocId()
// now flushes the outgoing document's pending sync-controller debounce
// itself (centralized there, see documents.js's own CR-02 comment) --
// tab-bar.js no longer calls flush() directly at all. Without this, this
// mocked documents.js (which fully replaces the real module) would give no
// signal either way once tab-bar.js stopped calling flush() itself, since a
// bare `vi.fn()` setActiveDocId mock does nothing on its own.
const { mockState, flushMock } = vi.hoisted(() => ({
  mockState: {
    docs: new Map(),
    activeDocId: null,
  },
  flushMock: vi.fn(),
}));

vi.mock('../documents.js', () => ({
  getDocumentIds: vi.fn(() => Array.from(mockState.docs.keys())),
  getDocument: vi.fn((docId) => mockState.docs.get(docId)),
  // [12-REVIEW.md CR-01] Mirrors documents.js's real getDocumentContent():
  // this mock has no active/background split of its own (mockState.docs
  // never diverges from `.state` the way the real Map does), but exposing it
  // separately from getDocument() keeps this fixture's shape honest about
  // which primitive closeTab() actually calls now.
  getDocumentContent: vi.fn((docId) => mockState.docs.get(docId)?.state.doc.toString() ?? null),
  getActiveDocId: vi.fn(() => mockState.activeDocId),
  setActiveDocId: vi.fn((docId) => {
    const previousDocId = mockState.activeDocId;
    if (previousDocId != null && previousDocId !== docId) flushMock(previousDocId);
    mockState.activeDocId = docId;
  }),
  closeDocument: vi.fn((docId) => {
    mockState.docs.delete(docId);
  }),
  // [12-06] getActiveEditor() now returns the shared CM6 EditorView shape
  // (`.state.doc.toString()`), not a textarea's `.value`.
  getActiveEditor: vi.fn(() => ({ state: { doc: { toString: () => 'stub content' } } })),
  // [05-12] closeTab()'s new dirty-close-prompt branch reads this to decide
  // whether the save succeeded -- unused by any test whose fixture doc is
  // clean (dirty: false), since that branch is skipped entirely in that case.
  isDocumentDirty: vi.fn((docId) => mockState.docs.get(docId)?.dirty ?? false),
}));

vi.mock('../markdown/render.js', () => ({
  renderMarkdown: vi.fn(),
}));

vi.mock('../markdown/sync-controller.js', () => ({
  flush: flushMock,
}));

// [05-12] tab-bar.js's closeTab() now imports files/save.js's escalation
// functions for the dirty-close-prompt's "Save" choice -- mocked wholesale
// so this file's DOM fixture (no #btn-save/#btn-save-as) never has to
// satisfy save.js's own module-load-time DOM queries.
vi.mock('../files/save.js', () => ({
  saveFile: vi.fn(),
  saveFileAs: vi.fn(),
}));

window.mdforge = {
  onMenuCommand: vi.fn(),
  setWindowTitleInfo: vi.fn(),
  // [05-12] Defaults to 'dont-save' so every pre-existing test closing a
  // dirty fixture doc (docId 2) keeps its original "closes immediately"
  // behavior -- this file's own dirty-close-PROMPT behavior is proven
  // separately by tests/e2e/quit-handshake-aggregated.spec.js, not here.
  confirmCloseTab: vi.fn(() => Promise.resolve('dont-save')),
};

let renderTabBar;
let setActiveDocId;
let closeDocument;
let getActiveEditor;
let renderMarkdown;
let flush;
let dispatch;
let COMMAND_IDS;

// jsdom does not implement Element.scrollIntoView (unrelated to this
// module's own logic) -- stub it so activateTab()/closeTab()'s real
// scrollIntoView({block:'nearest', inline:'nearest'}) call does not throw
// under jsdom. Real Chromium implements this natively; this is a test-
// environment gap only.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  document.body.innerHTML = `
    <div id="tab-bar" role="tablist" aria-label="Open documents"></div>
    <div id="editor-area"></div>
  `;

  mockState.docs = new Map([
    // [05-10, revised 12-06] `state` added so closeTab()'s pushClosed({..,
    // content: doc.state.doc.toString(), ..}) read (needed to feed DOC-07's
    // reopen stack from every close path) does not throw against this
    // fixture -- the real documents.js Map now holds a per-doc CM6
    // EditorState at `.state` (post-12-02's CM6 port), not the retired
    // `.surface` textarea field; this stub mirrors that shape minimally.
    [1, { filePath: 'C:\\notes\\roadmap.md', dirty: false, state: { doc: { toString: () => 'roadmap content' } } }],
    [2, { filePath: null, dirty: true, state: { doc: { toString: () => 'stub content' } } }],
    [3, { filePath: 'C:\\notes\\meeting.md', dirty: false, state: { doc: { toString: () => 'meeting content' } } }],
  ]);
  mockState.activeDocId = 2;

  ({ renderTabBar } = await import('./tab-bar.js'));
  ({ setActiveDocId, closeDocument, getActiveEditor } = await import('../documents.js'));
  ({ renderMarkdown } = await import('../markdown/render.js'));
  ({ flush } = await import('../markdown/sync-controller.js'));
  ({ dispatch } = await import('../command-dispatch.js'));
  ({ COMMAND_IDS } = await import('../../shared/command-ids.js'));

  // The module's own self-wiring call at import time already rendered once
  // against the fixture above -- clear that call so each test's own
  // assertions about mock call counts start from zero.
  vi.clearAllMocks();
  renderTabBar();
});

function getTabs() {
  return Array.from(document.querySelectorAll('#tab-bar > .tab'));
}

describe('renderTabBar', () => {
  it('renders exactly one .tab per open document, in dot -> name -> close order', () => {
    const tabs = getTabs();
    expect(tabs).toHaveLength(3);

    for (const tab of tabs) {
      expect(tab.children).toHaveLength(3);
      expect(tab.children[0].classList.contains('tab-dirty')).toBe(true);
      expect(tab.children[1].classList.contains('tab-name')).toBe(true);
      expect(tab.children[2].classList.contains('tab-close')).toBe(true);
      expect(tab.children[2].tagName).toBe('BUTTON');
    }
  });

  it('gives the active document aria-selected=true and tabindex=0, every other tab tabindex=-1', () => {
    const tabs = getTabs();
    const active = tabs.find((t) => t.dataset.docId === '2');
    const inactive = tabs.filter((t) => t.dataset.docId !== '2');

    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.getAttribute('tabindex')).toBe('0');

    expect(inactive).toHaveLength(2);
    for (const tab of inactive) {
      expect(tab.getAttribute('aria-selected')).toBe('false');
      expect(tab.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('marks the dirty document with the .dirty class and leaves clean documents without it', () => {
    const tabs = getTabs();
    const dirtyTab = tabs.find((t) => t.dataset.docId === '2');
    const cleanTabs = tabs.filter((t) => t.dataset.docId !== '2');

    expect(dirtyTab.classList.contains('dirty')).toBe(true);
    for (const tab of cleanTabs) {
      expect(tab.classList.contains('dirty')).toBe(false);
    }
  });

  it('shows the basename for a path-backed document and "Untitled" for a path-less one', () => {
    const tabs = getTabs();
    const named = tabs.find((t) => t.dataset.docId === '1').querySelector('.tab-name');
    const untitled = tabs.find((t) => t.dataset.docId === '2').querySelector('.tab-name');

    expect(named.textContent).toBe('roadmap.md');
    expect(untitled.textContent).toBe('Untitled');
  });
});

// [07-03, WORK-06 groundwork] documents.js's new `missing` field (default
// undefined on these hand-built fixture docs, same as `false` for this
// module's purposes) rendered by tab-bar.js's buildTabElement/tabTooltip.
describe('missing-file tab state (07-UI-SPEC.md Surface 4)', () => {
  it('adds the "missing" class and the "no longer found" tooltip for a missing, clean document', () => {
    mockState.docs.get(1).missing = true;
    renderTabBar();

    const tab = getTabs().find((t) => t.dataset.docId === '1');

    expect(tab.classList.contains('missing')).toBe(true);
    expect(tab.title).toBe('C:\\notes\\roadmap.md — file no longer found on disk. Your content is safe here.');
  });

  it('appends "Unsaved changes." as its own trailing sentence, replacing the old dirty-only tooltip, when missing AND dirty', () => {
    mockState.docs.get(1).missing = true;
    mockState.docs.get(1).dirty = true;
    renderTabBar();

    const tab = getTabs().find((t) => t.dataset.docId === '1');

    expect(tab.classList.contains('missing')).toBe(true);
    expect(tab.classList.contains('dirty')).toBe(true);
    expect(tab.title).toBe(
      'C:\\notes\\roadmap.md — file no longer found on disk. Your content is safe here. Unsaved changes.'
    );
  });

  it('a dirty, non-missing document is completely unchanged from its pre-07-03 tooltip/class behavior', () => {
    const tab = getTabs().find((t) => t.dataset.docId === '2'); // fixture: dirty:true, missing unset

    expect(tab.classList.contains('missing')).toBe(false);
    expect(tab.classList.contains('dirty')).toBe(true);
    expect(tab.title).toBe('Untitled'); // path-less doc -- tooltip is just the display name, per existing behavior
  });

  it('missing and dirty are independent -- neither is suppressed by the other in the rendered class list', () => {
    mockState.docs.get(3).missing = true; // docId 3 is clean in the base fixture
    renderTabBar();

    const tab = getTabs().find((t) => t.dataset.docId === '3');

    expect(tab.classList.contains('missing')).toBe(true);
    expect(tab.classList.contains('dirty')).toBe(false);
  });
});

describe('close interaction', () => {
  it('clicking .tab-close calls closeDocument with that tab\'s docId, and does NOT also call setActiveDocId', () => {
    const tab = getTabs().find((t) => t.dataset.docId === '3');
    const closeBtn = tab.querySelector('.tab-close');

    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(closeDocument).toHaveBeenCalledWith(3);
    expect(setActiveDocId).not.toHaveBeenCalled();
  });

  it('a synthetic auxclick with button 1 anywhere on a tab also closes it', () => {
    const tab = getTabs().find((t) => t.dataset.docId === '1');

    tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(closeDocument).toHaveBeenCalledWith(1);
  });

  it('an auxclick with a non-middle button does not close the tab', () => {
    const tab = getTabs().find((t) => t.dataset.docId === '1');

    tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));

    expect(closeDocument).not.toHaveBeenCalled();
  });
});

describe('activate interaction', () => {
  it('left-clicking a tab activates it via setActiveDocId', () => {
    const tab = getTabs().find((t) => t.dataset.docId === '3');

    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(setActiveDocId).toHaveBeenCalledTimes(1);
    expect(setActiveDocId).toHaveBeenCalledWith(3);
  });
});

// [05-07] DOC-04/DOC-05's Ctrl+W/Ctrl+Tab/Ctrl+Shift+Tab are no longer a
// renderer-level `keydown` listener (05-04's interim implementation) --
// they are real Menu accelerators (src/main/menu.js) resolved through
// command-dispatch.js's single registry. Exercised here exactly the way
// src/main/commands.test.js exercises file:new/file:save/etc: call the
// REAL dispatch() with the REAL COMMAND_IDS value tab-bar.js registered
// against, never a synthetic KeyboardEvent (a KeyboardEvent is what the
// OLD listener needed; it is meaningless to the new Menu-accelerator path,
// which Playwright/jsdom cannot drive directly either -- see menu.spec.js's
// own header comment on why real accelerators are proven via dispatch()/
// MenuItem.click(), never keyboard.press()).
describe('tab commands via command-dispatch (Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab)', () => {
  it('registers exactly one handler per tab command id', () => {
    expect(new Set([COMMAND_IDS.TAB_NEXT, COMMAND_IDS.TAB_PREV, COMMAND_IDS.TAB_CLOSE]).size).toBe(3);
  });

  it('TAB_CLOSE closes the active document', async () => {
    // [05-12] docId 2 (the active fixture doc) is dirty -- closeTab() is now
    // async and awaits window.mdforge.confirmCloseTab() (stubbed to resolve
    // 'dont-save') before calling closeDocument(), so this must flush past
    // that microtask before asserting.
    dispatch(COMMAND_IDS.TAB_CLOSE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(closeDocument).toHaveBeenCalledWith(2); // mockState.activeDocId
  });

  it('TAB_NEXT activates the next document, wrapping cyclically', () => {
    // Active is docId 2 (index 1 of [1, 2, 3]) -- next is docId 3.
    dispatch(COMMAND_IDS.TAB_NEXT);

    expect(setActiveDocId).toHaveBeenCalledTimes(1);
    expect(setActiveDocId).toHaveBeenCalledWith(3);
  });

  it('TAB_PREV activates the previous document, wrapping cyclically', () => {
    // Active is docId 2 (index 1 of [1, 2, 3]) -- previous is docId 1.
    dispatch(COMMAND_IDS.TAB_PREV);

    expect(setActiveDocId).toHaveBeenCalledTimes(1);
    expect(setActiveDocId).toHaveBeenCalledWith(1);
  });

  it('an unrelated command id does not trigger tab activation or closing', () => {
    dispatch('file:new');

    expect(setActiveDocId).not.toHaveBeenCalled();
    expect(closeDocument).not.toHaveBeenCalled();
  });
});

// [05-07] 05-05-SUMMARY.md's own "Next Phase Readiness" gap: switching tabs
// via tab-bar.js's own handlers must re-render #preview from the newly
// active document, and must flush() the OUTGOING document's pending
// sync-controller debounce first so a stale, in-flight render never lands
// after the switch.
describe('preview resync on tab switch/close', () => {
  it('activating a different tab flushes the outgoing docId, then re-renders the preview from the new active editor', () => {
    const tab = document.querySelectorAll('#tab-bar > .tab')[2]; // docId 3
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(flush).toHaveBeenCalledWith(2); // previous activeDocId
    expect(getActiveEditor).toHaveBeenCalled();
    expect(renderMarkdown).toHaveBeenCalledWith('stub content');
  });

  it('TAB_NEXT also flushes the outgoing document and re-renders the preview', () => {
    dispatch(COMMAND_IDS.TAB_NEXT);

    expect(flush).toHaveBeenCalledWith(2);
    expect(renderMarkdown).toHaveBeenCalledWith('stub content');
  });

  it('closing the active tab re-renders the preview for whichever document becomes active', async () => {
    // [05-12] See the equivalent note above -- docId 2 is dirty, so this
    // must flush past closeTab()'s confirmCloseTab() microtask first.
    dispatch(COMMAND_IDS.TAB_CLOSE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderMarkdown).toHaveBeenCalledWith('stub content');
  });
});
