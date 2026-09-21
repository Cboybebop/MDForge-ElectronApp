// @codemirror/search contract module (14-01-PLAN.md Task 2). Everything in
// Plan 14-02's find-bar.js rewire is built on top of these seven exports --
// this file owns NO write path of its own (T-14-04: dispatchAppWrite in
// ../markdown/cm-dispatch.js remains the sole place a document mutation is
// ever dispatched) and never imports `replaceNext`/`replaceAll`, whose own
// dispatches carry no appWriteOrigin/isolateHistory annotations.
//
// Two real, source-confirmed CM6 behaviours this module exists to work
// around/harness (see 14-01-PLAN.md Task 2's own read_first for the exact
// line numbers this was verified against):
//
// 1. `EditorView.setState()` destroys and reinitialises every VIEW plugin on
//    every tab switch (editor-events.js's own header comment, citing
//    12-RESEARCH.md). Search panel/query state is stored in a STATE field
//    (searchState), which normally means it travels with the state -- but a
//    freshly-created document's own EditorState was never opened, so its
//    own search field defaults closed regardless of some OTHER tab's current
//    panel-open status. reconcilePanelForActiveState() below is the fix:
//    called once, immediately after every setState() tab switch, forcing the
//    newly-active state into agreement with the window-level
//    isOpen/query truth find-bar.js owns.
//
// 2. `createPanel`, on its own, has CM6 mount the panel DOM as the LAST CHILD
//    of `.cm-editor` itself (PanelGroup.syncDOM()'s own `parent = this.container
//    || this.view.dom` fallback) inside a `div.cm-panels.cm-panels-bottom`
//    wrapper that CM6's own baseTheme styles `position: sticky` -- a floating
//    overlay, not a space-reserving flex sibling. That directly contradicts
//    the locked "the existing #find-bar UI is retained... exactly"
//    decision (14-CONTEXT.md Area 1). createFindSearchExtension() below
//    therefore ALWAYS pairs `search({createPanel})` with an explicit
//    `panels({bottomContainer: #left-pane})`, keeping `#find-bar` (now
//    wrapped one level deeper by CM6's own required wrapper div, but that
//    wrapper itself appended as #left-pane's own last child -- the exact
//    position #find-bar occupies today) inside #left-pane's own flex-column
//    layout, never inside .cm-editor.
//
// Deliberately NO default search keymap import anywhere in this file (14-CONTEXT.md
// "check for collisions... resolve deliberately and record the decision"):
// `Mod-f` would otherwise race find-bar.js's own existing window-level
// Ctrl+F listener; `Mod-d`/`Mod-Shift-l` (multi-cursor/select-all-matches)
// and `Mod-Alt-g` (goto-line) are both explicitly out of this app's
// REQUIREMENTS.md scope; `F3`/`Mod-g` (find-next/prev while the EDITOR, not
// the bar, has focus) is new capability outside EDIT-01/EDIT-15/EDIT-16's
// contract. Every interaction stays routed through find-bar.js's existing
// explicit listeners, unchanged.
import {
  search,
  SearchQuery,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import { panels } from '@codemirror/view';

// [14-03, Rule 1 - Bug, found via real packaged-app e2e reproduction, not
// merely theorized] `PanelGroup` (@codemirror/view) is a VIEW plugin, so
// `EditorView.setState()`'s own destroy-and-reinitialise-every-plugin
// behaviour (this file's header comment, point 1) also tears down the
// OUTGOING state's PanelGroup instance. Its `destroy()` calls
// `this.bottom.sync([])`, whose `syncDOM()` (@codemirror/view source) does
// `this.dom.remove()` on the WRAPPER div `#find-bar` was mounted inside --
// which detaches `#find-bar` (a child of that wrapper) from the document
// ENTIRELY, not merely from the wrapper. Since `#find-bar` is the one real,
// shared, never-recreated element (never a fresh DOM node per state), the
// very next call to `document.getElementById('find-bar')` -- exactly what
// `buildFindPanel` used to do on every invocation -- returns `null`, and the
// following `PanelGroup.syncDOM()` call (building the NEW panel for the
// newly-active state) crashes reading `panel.dom.parentNode` against that
// `null`, permanently breaking the find bar for the rest of the session.
// Reproduced directly: open find on tab A, switch to tab B (which has never
// had find opened) -- confirmed via a real Electron window, not a jsdom
// mock (14-03-SUMMARY.md has the full repro trace).
//
// Fix: prefer a FRESH `document.getElementById('find-bar')` lookup on every
// call (a live, connected element always wins and refreshes the cache --
// this is what keeps per-test jsdom fixtures in search-panel.test.js's own
// beforeEach/afterEach pairs correctly isolated from each other, each
// producing a genuinely new `#find-bar` node with the same id). Only when
// that fresh lookup comes back `null` -- which happens ONLY in the exact
// detached-by-a-prior-teardown scenario above, since a normal, currently-
// attached `#find-bar` is always found by a fresh query -- fall back to the
// last-known cached reference and re-parent it back under `#left-pane`
// before handing it to CM6, so the crash this fixes can never recur
// regardless of which state's teardown detached it.
let cachedFindBarEl = null;

/**
 * `createPanel` callback for `search({createPanel})`. Adopts the real,
 * already-existing `#find-bar` element verbatim -- never constructs a
 * parallel DOM tree -- which is what satisfies "the existing #find-bar DOM
 * is retained via createPanel" (14-CONTEXT.md Area 1, locked).
 *
 * `mount`/`update` are deliberate no-ops: find-bar.js's own show/hide
 * functions (Plan 14-02) remain the single place focus/seeding happens, so
 * this panel object does not duplicate that work and race it.
 *
 * @param {import('@codemirror/view').EditorView} view
 */
export function buildFindPanel(view) {
  const fresh = document.getElementById('find-bar');
  if (fresh) cachedFindBarEl = fresh;
  const dom = cachedFindBarEl;
  if (dom && !dom.isConnected) {
    const leftPane = document.getElementById('left-pane');
    if (leftPane) leftPane.appendChild(dom);
  }
  return {
    dom,
    top: false,
    mount() {},
    update() {},
  };
}

/**
 * Returns the extensions every document's EditorState must bake in from
 * creation (via editor-events.js's createSyncExtensions(docId)) so the
 * search panel/query field exists on every state from the start -- avoiding
 * `openSearchPanel`'s own config-less fallback
 * (`StateEffect.appendConfig.of(searchExtensions)`), which would silently
 * install CM6's own default, un-customised panel (no bottomContainer, i.e.
 * reparented into `.cm-editor`) the first time find is opened on a state
 * that never had this extension baked in (T-14-05).
 *
 * `document.getElementById('left-pane')` is resolved INSIDE this function
 * body, at call time -- NOT cached at module scope (unlike find-bar.js's own
 * top-level DOM consts): this function may be imported before #left-pane
 * exists in some test harnesses, and a module-scope cache would silently
 * freeze in a stale `null`, defeating the whole fix.
 *
 * @returns {import('@codemirror/state').Extension[]}
 */
export function createFindSearchExtension() {
  return [
    search({ createPanel: buildFindPanel, top: false }),
    panels({ bottomContainer: document.getElementById('left-pane') }),
  ];
}

/**
 * Builds a `SearchQuery` from the find bar's current input/checkbox state.
 *
 * `literal: true` is load-bearing, not a default left alone: it disables
 * `SearchQuery`'s own backslash-unquoting (`\n`/`\r`/`\t`) on BOTH the search
 * text and the replacement text, in BOTH plain and regex modes, exactly
 * matching the old hand-rolled engine's zero-escape-processing behaviour --
 * without it, a user typing a literal `\n` two-character sequence into
 * either field would see new, un-asked-for escape interpretation.
 *
 * @param {{search: string, replace?: string, matchCase?: boolean, regexp?: boolean, wholeWord?: boolean}} params
 * @returns {SearchQuery}
 */
export function buildSearchQuery({ search: searchText, replace = '', matchCase = false, regexp = false, wholeWord = false }) {
  return new SearchQuery({
    search: searchText,
    replace,
    caseSensitive: matchCase,
    regexp,
    wholeWord,
    literal: true,
  });
}

/**
 * True if `query` is well-formed (a malformed regex, e.g. an unbalanced
 * paren, never throws when constructed by buildSearchQuery -- `SearchQuery`
 * computes `valid` internally via its own `validRegExp` check). Callers
 * never construct a raw `new RegExp()` themselves.
 *
 * @param {SearchQuery} query
 * @returns {boolean}
 */
export function queryValidity(query) {
  return query.valid;
}

/**
 * Enumerates every match of `query` against `state`, as an array of
 * `{from, to}`-shaped ranges, or `null` if `limit` is exceeded. Direct
 * replacement for the deleted `computeMatches()`: regex, whole-word, and
 * case-sensitivity handling are delegated entirely to `@codemirror/search`'s
 * own `RegExpQuery`/`StringQuery`, whose cursors advance the match position
 * by at least one character on a zero-width match, structurally preventing
 * an infinite loop on an empty-matching pattern such as `a*`.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {SearchQuery} query
 * @param {number} [limit=5000]
 * @returns {Array<{from: number, to: number}> | null}
 */
export function enumerateMatches(state, query, limit = 5000) {
  return query.create().matchAll(state, limit);
}

/**
 * Returns the replacement text for a single `match` (as returned by
 * `enumerateMatches`), sourced from the SAME query object used for
 * matching -- so regex capture-group substitution (`$1`/`$&`) stays
 * consistent with whatever produced `match` in the first place.
 *
 * @param {SearchQuery} query
 * @param {{from: number, to: number}} match
 * @returns {string}
 */
export function getReplacementText(query, match) {
  return query.create().getReplacement(match);
}

/**
 * Called once, immediately after every `view.setState()` tab switch (from
 * find-bar.js's existing `#tab-bar` MutationObserver), to force the
 * newly-active state's own CM6 panel/query fields into agreement with the
 * window-level `isOpen`/`query` truth find-bar.js owns (mirrors
 * `currentMatchIndex`'s existing module-scope, per-window pattern in that
 * file) -- working around `setState()`'s own view-plugin-reinit behaviour
 * (see this file's header comment, point 1).
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {{isOpen: boolean, query: SearchQuery}} params
 */
export function reconcilePanelForActiveState(view, { isOpen, query }) {
  const currentlyOpen = searchPanelOpen(view.state);

  if (isOpen && !currentlyOpen) {
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(query) });
  } else if (isOpen && currentlyOpen) {
    view.dispatch({ effects: setSearchQuery.of(query) });
  } else if (!isOpen && currentlyOpen) {
    closeSearchPanel(view);
  }
}
