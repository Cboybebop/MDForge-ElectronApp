// @vitest-environment jsdom
//
// 14-01-PLAN.md Task 3: proves search-panel.js's regex-safety,
// cross-tab-switch panel-persistence, and DOM-ancestry-preservation
// contracts, each against real EditorState/EditorView/SearchQuery instances
// (this codebase's own "confirm, don't assume" convention -- mirrors
// cm-dispatch.test.js's own mount-a-real-view pattern, never a mocked CM6
// class).
//
// [gsd-plan-checker Blocker 2 fix] `buildFindPanel` resolves
// `document.getElementById('find-bar')`, and `createFindSearchExtension`
// resolves `document.getElementById('left-pane')` -- both must be real
// elements actually attached to `document`, or `PanelGroup.syncDOM()` throws
// a TypeError the moment `openSearchPanel` runs (never a jsdom mock, never a
// detached-only fixture). Every test below builds these two real, attached
// fixtures in `beforeEach`, torn down in `afterEach`, before touching any
// CM6 panel API.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { search, searchPanelOpen, getSearchQuery, openSearchPanel, setSearchQuery } from '@codemirror/search';
import {
  buildFindPanel,
  createFindSearchExtension,
  buildSearchQuery,
  queryValidity,
  enumerateMatches,
  reconcilePanelForActiveState,
} from './search-panel.js';

let leftPaneEl;
let findBarEl;
const mountedViews = [];

beforeEach(() => {
  leftPaneEl = document.createElement('div');
  leftPaneEl.id = 'left-pane';
  findBarEl = document.createElement('div');
  findBarEl.id = 'find-bar';
  leftPaneEl.appendChild(findBarEl);
  document.body.appendChild(leftPaneEl);
});

afterEach(() => {
  for (const view of mountedViews) view.destroy();
  mountedViews.length = 0;
  leftPaneEl.remove();
});

function mountView(state) {
  const view = new EditorView({ state, parent: document.createElement('div') });
  mountedViews.push(view);
  return view;
}

describe('buildSearchQuery / queryValidity', () => {
  it('a malformed regex never throws when constructed, and reports invalid', () => {
    let query;
    expect(() => {
      query = buildSearchQuery({ search: '(foo', regexp: true, matchCase: false, wholeWord: false });
    }).not.toThrow();
    expect(queryValidity(query)).toBe(false);
  });

  it('a well-formed regex reports valid', () => {
    const query = buildSearchQuery({ search: 'fo+', regexp: true, matchCase: false, wholeWord: false });
    expect(queryValidity(query)).toBe(true);
  });
});

describe('enumerateMatches', () => {
  it('an empty-match-capable pattern (a*) returns within a bounded time against a large document, respecting a small limit', () => {
    // 20,000-character fixture: a repeated short string with no 'a' in it,
    // so 'a*' zero-width-matches at every single character boundary --
    // exactly the empty-match hang risk 14-CONTEXT.md's security
    // requirements name.
    const fixture = 'lorem ipsum dolor sit '.repeat(1000).slice(0, 20000);
    const state = EditorState.create({ doc: fixture });
    const query = buildSearchQuery({ search: 'a*', regexp: true, matchCase: false, wholeWord: false });
    expect(queryValidity(query)).toBe(true);

    const smallLimit = 100;
    const start = Date.now();
    const bounded = enumerateMatches(state, query, smallLimit);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    // The 20,000-character fixture has far more than 100 zero-width/short
    // matches for 'a*', so the small limit must be exceeded -- proving the
    // limit argument genuinely bounds the enumeration (RegExpCursor's own
    // at-least-one-character advance on a zero-width match is what makes
    // this terminate at all, rather than hang).
    expect(bounded).toBeNull();

    const largeStart = Date.now();
    const full = enumerateMatches(state, query, 50000);
    const largeElapsed = Date.now() - largeStart;
    expect(largeElapsed).toBeLessThan(500);
    expect(Array.isArray(full)).toBe(true);
  });
});

describe('reconcilePanelForActiveState', () => {
  it('forces a freshly-setState() view back into the window-level open/query truth (setState canary)', () => {
    const extensions = createFindSearchExtension();
    const stateA = EditorState.create({ doc: 'alpha beta', extensions });
    const stateB = EditorState.create({ doc: 'gamma delta', extensions });

    const view = mountView(stateA);

    openSearchPanel(view);
    const query = buildSearchQuery({ search: 'foo', regexp: false, matchCase: false, wholeWord: false });
    view.dispatch({ effects: setSearchQuery.of(query) });

    expect(searchPanelOpen(view.state)).toBe(true);

    view.setState(stateB);

    // CANARY: this is the real, confirmed 12-RESEARCH.md finding this
    // function exists to work around -- a raw setState() alone, with no
    // reconciliation call, leaves the freshly-activated state's own search
    // field closed, regardless of the window-level truth. If this assertion
    // ever starts failing (i.e. panel state survives setState() on its own),
    // the regression this function fixes no longer exists and the function
    // itself would need re-examination -- but today it is real.
    expect(searchPanelOpen(view.state)).toBe(false);

    reconcilePanelForActiveState(view, { isOpen: true, query });

    expect(searchPanelOpen(view.state)).toBe(true);
    expect(getSearchQuery(view.state).search).toBe('foo');
  });

  // [14-03, Rule 1 - Bug regression] The test above only proves the STATE
  // field (searchPanelOpen) survives -- it never checked whether the real
  // `#find-bar` DOM element survives too. It does not, without this fix:
  // `EditorView.setState()` destroys the OUTGOING state's PanelGroup view
  // plugin, whose `destroy()` -> `syncDOM()` calls `.remove()` on the
  // wrapper `#find-bar` was mounted inside, detaching `#find-bar` (a CHILD
  // of that wrapper) from the document entirely -- confirmed via a real
  // packaged-app e2e reproduction (14-03-SUMMARY.md), not merely
  // theorized. The very next `buildFindPanel()` call used to re-query
  // `document.getElementById('find-bar')`, get `null`, and crash
  // `PanelGroup.syncDOM()` reading `panel.dom.parentNode`. This test proves
  // `#find-bar` stays connected to the document (or is rescued back into
  // it) across exactly that sequence.
  it('#find-bar survives (or is rescued back into) the document across a setState() teardown while its panel was open, then reopened on the new state', () => {
    const extensions = createFindSearchExtension();
    const stateA = EditorState.create({ doc: 'alpha beta', extensions });
    const stateB = EditorState.create({ doc: 'gamma delta', extensions });

    const view = mountView(stateA);

    openSearchPanel(view);
    const query = buildSearchQuery({ search: 'foo', regexp: false, matchCase: false, wholeWord: false });
    view.dispatch({ effects: setSearchQuery.of(query) });

    expect(findBarEl.isConnected).toBe(true);

    view.setState(stateB);
    reconcilePanelForActiveState(view, { isOpen: true, query });

    expect(findBarEl.isConnected).toBe(true);
    expect(findBarEl.closest('#left-pane')).toBe(leftPaneEl);
  });
});

describe('DOM-ancestry preservation (#find-bar is never reparented into .cm-editor)', () => {
  it('with the real createFindSearchExtension() (bottomContainer configured), #find-bar stays inside #left-pane', () => {
    const state = EditorState.create({ doc: '', extensions: createFindSearchExtension() });
    const view = mountView(state);

    openSearchPanel(view);

    expect(findBarEl.closest('.cm-editor')).toBeNull();
    expect(findBarEl.closest('#left-pane')).toBe(leftPaneEl);
  });

  it('CANARY: without an explicit bottomContainer, CM6 reparents #find-bar into .cm-editor (proves the assertion above is not vacuous)', () => {
    // Deliberately construct search() WITHOUT the panels({bottomContainer})
    // pairing createFindSearchExtension() always provides -- this is exactly
    // the default behaviour gsd-plan-checker's Blocker 1 found: absent an
    // explicit bottomContainer, PanelGroup.syncDOM()'s own
    // `parent = this.container || this.view.dom` falls through to
    // `.cm-editor` itself.
    const state = EditorState.create({
      doc: '',
      extensions: [search({ createPanel: buildFindPanel, top: false })],
    });
    const view = mountView(state);

    openSearchPanel(view);

    // The regression, reproduced: #find-bar is now a descendant of
    // .cm-editor, not merely still inside #left-pane.
    expect(findBarEl.closest('.cm-editor')).not.toBeNull();
  });
});
