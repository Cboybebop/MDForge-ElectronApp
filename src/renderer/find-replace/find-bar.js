// Find & replace bar (EDIT-01, Surface 2 of 05-UI-SPEC.md) -- a docked bar
// at the bottom of the left (Markdown) pane, opened with Ctrl+F/Ctrl+H,
// scoped to the ACTIVE document only.
//
// D1 (05-01) resolved on `<textarea>`-per-tab, so this file originally
// implemented the textarea-branch match-navigation mechanism 05-UI-SPEC.md/
// 05-RESEARCH.md scope precisely: a plain string scan over the old
// whole-document-string read, native selection-range calls to move/highlight
// the current match, and every replace wrapped in a beginWrite('find-replace',
// docId) / endWrite(docId) pair around a native insert-text browser command.
//
// 12-07-PLAN.md (Phase 12, Plan 07): THIN, TRANSITIONAL CM6 adapter. Every
// call site that used to read/write the textarea API was retargeted onto
// `editor.state.doc`/`editor.state.selection`, writing via
// `../markdown/cm-dispatch.js`'s app-write dispatch helper with origin
// `'find-replace'`. The hand-rolled match-scan algorithm (`computeMatches`)
// was left UNCHANGED at that point -- only its callers' data source changed.
//
// 14-01/14-02-PLAN.md (Phase 14): THE REAL `@codemirror/search` MIGRATION.
// `computeMatches`, `getMatches`, `selectMatchWithoutStealingFocus`, and
// `focusEditorAndSelect` (the hand-rolled scan engine and Phase 12's
// transitional adapter surface) are DELETED outright (14-CONTEXT.md Area 1,
// criterion 4 -- grep-gated by scripts/check-no-legacy-find-engine.mjs).
// Every match/replacement now flows through `../find-replace/search-panel.js`'s
// `@codemirror/search`-backed engine (`buildSearchQuery`/`queryValidity`/
// `enumerateMatches`/`getReplacementText`), and CM6's own panel-open state is
// driven through `openSearchPanel`/`closeSearchPanel`/`setSearchQuery` --
// `#find-bar`'s own DOM/CSS/keyboard contract, and the `dispatchAppWrite`
// write path, are otherwise UNCHANGED.
//
// Self-wiring module (this codebase's established convention -- every
// module attaches its own DOM listeners at import time, no central init()).
//
// Bar state (query/replacement/match-case/regex/whole-word) is per-WINDOW,
// not per-document (05-UI-SPEC.md Surface 2 Interaction contract): it
// survives a tab switch, and the search re-runs against whichever document
// just became active. Since documents.js/tab-bar.js deliberately do not
// expose a reactive subscribe hook (05-PATTERNS.md Shared Pattern 2's
// one-directional tab-bar.js -> documents.js dependency), this file detects
// a tab switch or close the same "reach across via DOM observation, don't
// import" way documents.js's own markDocumentDirty() reaches into a tab's
// DOM element: a MutationObserver on #tab-bar's childList, which
// renderTabBar() mutates on every documents.js-triggered create/close/
// activate. On every such active-document change while the bar is open,
// search-panel.js's reconcilePanelForActiveState() is called FIRST, working
// around `EditorView.setState()`'s own view-plugin-reinit destroying the
// freshly-activated state's CM6 panel/query fields (12-RESEARCH.md,
// search-panel.js's own header comment) -- otherwise the window-level
// isOpen/query truth this file owns would silently desync from CM6's own
// per-state panel-open field.
import { getActiveEditor, getActiveDocId, getDocumentIds } from '../documents.js';
import { applyPaneMode } from '../panes/pane-mode.js';
import { dispatchAppWrite } from '../markdown/cm-dispatch.js';
import { EditorSelection } from '@codemirror/state';
import { openSearchPanel, closeSearchPanel, setSearchQuery } from '@codemirror/search';
import {
  buildSearchQuery,
  queryValidity,
  enumerateMatches,
  getReplacementText,
  reconcilePanelForActiveState,
} from './search-panel.js';

const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findCount = document.getElementById('find-count');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const findCloseBtn = document.getElementById('find-close');
const matchCaseCheckbox = document.getElementById('find-match-case');
const regexCheckbox = document.getElementById('find-regex');
const wholeWordCheckbox = document.getElementById('find-whole-word');
const replaceOneBtn = document.getElementById('replace-one');
const replaceAllBtn = document.getElementById('replace-all');
const paneModeSelect = document.getElementById('pane-mode-select');
const tabBarEl = document.getElementById('tab-bar');

// Index into the CURRENT search's match array; -1 means "no current match"
// (query empty, invalid, or zero matches found). Per-window state, per the
// file header above -- never reset just because the active document
// changed.
let currentMatchIndex = -1;

// Builds a SearchQuery from the bar's current input/checkbox state --
// search-panel.js's buildSearchQuery() with `literal: true` baked in, so
// this app's zero-escape-processing behaviour is preserved regardless of
// mode.
function currentQuery() {
  return buildSearchQuery({
    search: findInput.value,
    replace: replaceInput.value,
    matchCase: matchCaseCheckbox.checked,
    regexp: regexCheckbox.checked,
    wholeWord: wholeWordCheckbox.checked,
  });
}

// Direct replacement for the deleted `getMatches()`: an invalid query (e.g.
// a malformed regex) is treated exactly like a zero-length matches array --
// never calls enumerateMatches against an invalid query at all, and never
// throws. `enumerateMatches`'s own `limit` default (5000) is a generous
// performance ceiling for this app's realistic document sizes, not a
// correctness gap -- see search-panel.js's own documentation.
function currentMatches(query) {
  const editor = getActiveEditor();
  if (!editor || !queryValidity(query)) return [];
  return enumerateMatches(editor.state, query) || [];
}

// Counter copy (05-UI-SPEC.md Surface 2 "Counter copy" table): empty when
// the query is empty, `{i} of {n}` when matches exist, `No matches` in
// `.no-matches` (--red) when the query is non-empty but nothing matched --
// including an invalid regex query, which is deliberately NOT a third,
// new visual state (14-CONTEXT.md).
function renderCount(matches) {
  const query = findInput.value;
  if (!query) {
    findCount.textContent = '';
    findCount.classList.remove('no-matches');
    return;
  }
  if (matches.length === 0) {
    findCount.textContent = 'No matches';
    findCount.classList.add('no-matches');
    return;
  }
  findCount.classList.remove('no-matches');
  findCount.textContent = `${currentMatchIndex + 1} of ${matches.length}`;
}

// Dispatches a selection-only CM6 transaction (no `changes` field) for
// `match`, carrying `scrollIntoView: true` -- the SINGLE place in this file
// that owns that field, so a future call site cannot add a fourth selection
// dispatch that forgets it. Standard CM6 API call, not "hand-rolled scan
// logic" under criterion 4's deletion target -- kept as a small named
// helper (deliberately not the deleted `selectMatchWithoutStealingFocus` or
// `focusEditorAndSelect` identifiers) purely to avoid repeating this pair of
// fields at every call site.
//
// Focus is deliberately NOT this helper's concern: a selection-only
// transaction never focuses the view on its own, and this helper's three
// call sites (selectMatch(), doReplaceOne(), hideFindBar()) genuinely
// differ on whether the editor should already be focused before the
// dispatch -- folding focus in here would either break selectMatch()'s
// no-focus contract below or make this helper lie about what it does.
//
// [Rule 1 - Bug, found live during the v1.1 human validation workbook] A
// transaction carrying only `selection` moves the cursor but does NOT
// scroll the viewport -- `scrollIntoView: true` is the dedicated
// `TransactionSpec` field for that, and it is independent of focus, so
// adding it does not reintroduce any focus-stealing. This regressed in the
// Phase 14 `@codemirror/search` migration: the deleted hand-rolled engine's
// own `selectMatchWithoutStealingFocus` helper handled the scroll itself;
// its replacement kept the focus behaviour but dropped the scroll. Routing
// every selection dispatch through this one helper is what makes that class
// of regression structurally impossible to reintroduce.
function dispatchMatchSelection(editor, match) {
  editor.dispatch({ selection: EditorSelection.range(match.from, match.to), scrollIntoView: true });
}

// Moves the current-match SELECTION without stealing focus away from
// find-input/replace-input -- dispatchMatchSelection() above issues a
// selection-only transaction, which never focuses the view on its own, and
// panes.css's ::selection rule makes it visible regardless, which is
// exactly what lets the user keep typing/pressing Enter in the find bar
// while the match highlight moves in the editor underneath.
function selectMatch(matches, index) {
  const editor = getActiveEditor();
  const match = matches[index];
  if (!editor || !match) return;
  dispatchMatchSelection(editor, match);
}

// Recomputes matches against whichever document is currently active and
// updates the counter + current-match selection. `preserveIndex: true` is
// used by the match-case/regex/whole-word toggles ("re-runs the search
// immediately, preserving the current match index where still valid" --
// Surface 2 Interaction contract); every other caller wants the freshly-
// typed query to jump to the first match.
function runSearch({ preserveIndex = false } = {}) {
  if (!findInput.value) {
    currentMatchIndex = -1;
    renderCount([]);
    return;
  }
  const matches = currentMatches(currentQuery());
  if (matches.length === 0) {
    currentMatchIndex = -1;
    renderCount(matches);
    return;
  }
  if (!preserveIndex || currentMatchIndex < 0 || currentMatchIndex >= matches.length) {
    currentMatchIndex = 0;
  }
  selectMatch(matches, currentMatchIndex);
  renderCount(matches);
}

// Enter/Shift+Enter/Prev/Next button (all four routes share this): wraps
// past the last/first match, communicated ONLY by the counter rolling over
// (05-UI-SPEC.md: "no extra banner, toast or 'wrapped' text").
function goToMatch(delta) {
  const matches = currentMatches(currentQuery());
  if (matches.length === 0) {
    currentMatchIndex = -1;
    renderCount(matches);
    return;
  }
  if (currentMatchIndex < 0) {
    currentMatchIndex = delta > 0 ? 0 : matches.length - 1;
  } else {
    currentMatchIndex = (currentMatchIndex + delta + matches.length) % matches.length;
  }
  selectMatch(matches, currentMatchIndex);
  renderCount(matches);
}

// `Enter` in #replace-input: "Replace current match, then advance to next"
// (Surface 2 Interaction contract). Replacing at `currentMatchIndex` and
// then recomputing matches against the new content already yields exactly
// this: whatever occupied `currentMatchIndex + 1` before the replace now
// occupies `currentMatchIndex`, since one match was removed ahead of it --
// "advance to next" without any extra index bookkeeping.
function doReplaceOne() {
  const query = currentQuery();
  const matches = currentMatches(query);
  if (matches.length === 0) return;
  if (currentMatchIndex < 0 || currentMatchIndex >= matches.length) currentMatchIndex = 0;
  const match = matches[currentMatchIndex];

  const editor = getActiveEditor();
  if (!editor) return;
  const docId = getActiveDocId();

  // Replace/Replace All are triggered from find-input/replace-input, so the
  // active editor must be explicitly focused first -- `view.focus()` is a
  // real CM6 method, unchanged from the textarea era. This dispatch already
  // focuses the editor, so dispatchMatchSelection()'s scrollIntoView carries
  // no additional focus-stealing risk.
  editor.focus();
  dispatchMatchSelection(editor, match);

  // Sourced from the SAME query object used for matching, so regex
  // capture-group substitution ($1/$&) stays consistent with whatever
  // produced this match.
  const replacement = getReplacementText(query, match);

  // A single match replacement is its own atomic undo step (`'full'`
  // isolation) -- mirrors Replace All's existing guarantee.
  dispatchAppWrite(editor, { from: match.from, to: match.to, insert: replacement }, 'find-replace', docId, 'full');

  // Keep the replace-input flow going -- refocus it so repeated Enter
  // presses keep replacing without the user having to re-click into it.
  replaceInput.focus();
  runSearch({ preserveIndex: true });
}

// `Replace All` acts on the whole active document in ONE edit operation (a
// single whole-document `dispatchAppWrite` change, `isolateHistory: 'full'`)
// so a single Ctrl+Z undoes the whole replacement, not one match at a time
// (05-UI-SPEC.md Surface 2's explicit guarantee; 05-RESEARCH.md's "Don't
// Hand-Roll" table) -- the same user-facing guarantee the old native
// insert-text browser command's own atomicity used to provide, now
// delivered by CM6's own isolateHistory mechanism instead. Each match's own
// replacement text is sourced from `getReplacementText`, supporting regex
// capture groups in Replace All too, not just single Replace.
function doReplaceAll() {
  const editor = getActiveEditor();
  if (!editor) return;
  const query = currentQuery();
  const matches = currentMatches(query);
  if (matches.length === 0) return;

  const text = editor.state.doc.toString();
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.from) + getReplacementText(query, match);
    cursor = match.to;
  }
  result += text.slice(cursor);

  const docId = getActiveDocId();
  // [16-06, Rule 1 - Bug] The pre-CM6 implementation called `editor.focus()`
  // here (required by the native `execCommand('insertText', ...)` write it
  // used at the time). The 12-07 CM6 port dropped it -- `dispatchAppWrite()`
  // does not need focus to dispatch a transaction -- but that silently broke
  // the "Replace All also focuses the editor, so a single Ctrl+Z undoes the
  // whole replacement" contract this file's own header/doReplaceAll comments
  // still describe: without focus, a user's subsequent Ctrl+Z lands wherever
  // focus already was (typically #replace-input), never reaching CM6's undo
  // keymap at all. Restored to match the documented, pre-existing guarantee
  // -- and preserved again through this plan's 14-02 rewrite (do not lose it
  // a second time).
  editor.focus();
  dispatchAppWrite(editor, { from: 0, to: text.length, insert: result }, 'find-replace', docId, 'full');

  currentMatchIndex = -1;
  runSearch();
}

// Surface 2's "if pane mode is right when Ctrl+F/Ctrl+H fires, switch pane
// mode to both first" rule -- otherwise the bar would be opened inside a
// hidden #left-pane. Pane mode 'left' needs no adjustment.
function ensurePaneModeAllowsFindBar() {
  if (paneModeSelect && paneModeSelect.value === 'right') {
    paneModeSelect.value = 'both';
    applyPaneMode('both');
  }
}

// "Seed the query from a non-empty single-line selection" (Ctrl+F/Ctrl+H).
// Captured into a local BEFORE any focus-stealing call (`findInput.focus()`
// below steals focus away from the editor) -- the same discipline
// preview/selection.js's own restorePreviewSelection() bug-fix comment
// documents, applied here to the editor -> find-input direction instead of
// the preview's own focus/blur round trip.
function seedQueryFromSelection() {
  const editor = getActiveEditor();
  if (!editor) return null;
  const { from, to } = editor.state.selection.main;
  if (from === to) return null;
  const selected = editor.state.doc.sliceString(from, to);
  if (!selected || selected.includes('\n')) return null;
  return selected;
}

function showFindBar(withReplace) {
  const seeded = seedQueryFromSelection();

  ensurePaneModeAllowsFindBar();

  if (seeded != null) findInput.value = seeded;

  // Mount #find-bar into #left-pane's own panel container (14-01's
  // `panels({bottomContainer})` wiring -- NEVER `.cm-editor`'s) BEFORE
  // removing `.hidden`, avoiding a one-frame flash of an empty panel. The
  // immediate setSearchQuery dispatch overrides openSearchPanel's own
  // default-query seeding with this app's own seedQueryFromSelection()
  // result (including its "reject any multi-line selection" rule, which
  // openSearchPanel's own default seeding does not honour).
  const editor = getActiveEditor();
  if (editor) {
    openSearchPanel(editor);
    editor.dispatch({ effects: setSearchQuery.of(currentQuery()) });
  }

  findBar.classList.remove('hidden');
  findBar.classList.toggle('find-only', !withReplace);

  findInput.focus();
  findInput.select();

  runSearch();
}

// Escape (anywhere in the bar): "Hide the bar and return focus to the
// editor with the current match still selected" (Surface 2 Interaction
// contract). Also used by #find-close, which carries the same semantics
// per its own aria-label ("Close find bar"), and by the tab-close observer
// branch below (bar force-closed, no focus return).
function hideFindBar({ returnFocusToEditor = false } = {}) {
  findBar.classList.add('hidden');

  const editor = getActiveEditor();
  if (editor) closeSearchPanel(editor);

  if (!returnFocusToEditor || !editor) return;

  editor.focus();
  if (currentMatchIndex >= 0) {
    const matches = currentMatches(currentQuery());
    const match = matches[currentMatchIndex];
    // dispatchMatchSelection() scrolls the still-selected match back into
    // view when focus returns to the editor.
    if (match) dispatchMatchSelection(editor, match);
  }
}

// Ctrl+F / Ctrl+H -- deliberately plain window-level keydown listeners, NOT
// native Menu accelerators (mirrors tabs/tab-bar.js's own Ctrl+W/Ctrl+Tab
// precedent, 05-PATTERNS.md Assumption A5's "the planner may instead choose
// plain renderer keydown listeners, which sidesteps [the CDP-accelerator
// gap] entirely"). src/main/menu.js and src/shared/command-ids.js are
// outside this plan's own files_modified list; a plain listener also means
// this is directly Playwright-testable via keyboard.press(), unlike a real
// native accelerator (05-RESEARCH.md Pitfall 5).
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    showFindBar(false);
    return;
  }
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'h') {
    event.preventDefault();
    showFindBar(true);
  }
});

// Escape anywhere in the bar (bubbles up from find-input/replace-input/the
// buttons/the checkboxes alike).
findBar.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideFindBar({ returnFocusToEditor: true });
  }
});

// `Enter`/`Shift+Enter` in #find-input: next/previous match.
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToMatch(event.shiftKey ? -1 : 1);
  }
});

// Live re-search as the user types -- jumps to the first match on every
// keystroke (setting .value programmatically, e.g. the selection-seeding
// path, does NOT fire 'input', so showFindBar() calls runSearch() itself).
findInput.addEventListener('input', () => {
  currentMatchIndex = -1;
  runSearch();
});

// `Enter` in #replace-input: replace current match, then advance to next.
replaceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    doReplaceOne();
  }
});

// Match case / regex / whole word: "re-runs the search immediately,
// preserving the current match index where still valid" -- the same
// listener shape for all three toggles.
matchCaseCheckbox.addEventListener('change', () => {
  runSearch({ preserveIndex: true });
});
regexCheckbox.addEventListener('change', () => {
  runSearch({ preserveIndex: true });
});
wholeWordCheckbox.addEventListener('change', () => {
  runSearch({ preserveIndex: true });
});

// Buttons: mousedown preventDefault so clicking one never steals focus away
// from whichever input the user is actively typing in -- the same
// preventDefault-on-mousedown/act-on-click idiom preview/toolbar.js's
// format-button wiring already establishes for this exact reason.
[findPrevBtn, findNextBtn, findCloseBtn, replaceOneBtn, replaceAllBtn].forEach((btn) => {
  btn.addEventListener('mousedown', (event) => event.preventDefault());
});

findPrevBtn.addEventListener('click', () => goToMatch(-1));
findNextBtn.addEventListener('click', () => goToMatch(1));
findCloseBtn.addEventListener('click', () => hideFindBar({ returnFocusToEditor: true }));
replaceOneBtn.addEventListener('click', () => doReplaceOne());
replaceAllBtn.addEventListener('click', () => doReplaceAll());

// Tab-switch / tab-close detection (file header comment above): every
// documents.js-triggered renderTabBar() call rebuilds #tab-bar's children
// wholesale (innerHTML = '' then re-append), so a single childList
// MutationObserver on #tab-bar catches every create/close/activate. A drop
// in tab count means a document was closed -- close the find bar too
// (query/replacement/toggle state retained, per Surface 2's own rule),
// regardless of whether the CLOSED document was the active one. Otherwise,
// if the active docId changed while the bar is open, reconcile the newly-
// active state's own CM6 panel/query fields against this file's
// window-level truth FIRST (search-panel.js's reconcilePanelForActiveState
// -- working around EditorView.setState()'s view-plugin-reinit destroying
// them), THEN re-run the search against whichever document just became
// active.
if (tabBarEl) {
  let lastTabCount = getDocumentIds().length;
  let lastActiveDocId = getActiveDocId();

  const tabBarObserver = new MutationObserver(() => {
    const ids = getDocumentIds();
    const activeDocId = getActiveDocId();

    if (ids.length < lastTabCount) {
      hideFindBar();
    } else if (activeDocId !== lastActiveDocId && !findBar.classList.contains('hidden')) {
      const editor = getActiveEditor();
      if (editor) {
        reconcilePanelForActiveState(editor, { isOpen: true, query: currentQuery() });
      }
      runSearch({ preserveIndex: true });
    }

    lastTabCount = ids.length;
    lastActiveDocId = activeDocId;
  });
  tabBarObserver.observe(tabBarEl, { childList: true });
}
