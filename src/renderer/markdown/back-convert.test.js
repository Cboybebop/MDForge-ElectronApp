// @vitest-environment jsdom
//
// Unit tests for back-convert.js's rewritten right-to-left sync direction
// (03-04-PLAN.md Task 1; write mechanism cut over to CM6 by 12-05-PLAN.md
// Task 1). jsdom does not implement `document.execCommand` at all, which is
// exactly the class of stub this rewrite eliminates rather than works
// around: every test now constructs a REAL CM6 `EditorState`/`EditorView`
// pair and asserts against the real `EditorView.dispatch()` call it receives
// (via `vi.spyOn(view, 'dispatch')`, call-through -- a spy on a REAL object
// method, never a stub replacing missing jsdom functionality), mirroring
// cm-dispatch.test.js's/editor-events.test.js's own construct-a-real-view-
// under-jsdom precedent (12-RESEARCH.md section 9: construct+dispatch+
// inspect is jsdom-reliable).
//
// `../documents.js` is mocked wholesale (same precedent as
// editor-events.test.js's own `vi.mock('../documents.js', ...)`) so
// `getActiveEditor()`/`getActiveDocId()` resolve to THIS file's own
// fixture-controlled view/docId instead of triggering documents.js's real
// module-load-time bootstrap (shared-view mount, scroll-sync wiring,
// restore-plan branch) -- this file's own concern is back-convert.js's
// splice/anchor-search logic and its write mechanism, not documents.js's
// lifecycle (covered by documents.test.js).
//
// ONE shared multi-block fixture (FIXTURE) is used across every test below.
// It deliberately contains a setext-style heading (`Title\n=====`), a
// `*`-marker bulleted list, and a reference-style link (`[text][ref]` +
// its `[ref]: url` definition) -- the three "canary" blocks from
// accepted-normalisations.md entries #1-#3 -- so that if any test's
// assertion regressed to a whole-document re-normalisation, the diff would
// be immediately visible (setext->ATX, `*`->`-`, reference->inline) rather
// than silent. Most edit targets below are placed with an unedited PLAIN
// paragraph immediately on each side (Canary tail paragraph/Paragraph Alpha
// through Eta) precisely so an accidental whole-document-regression would
// surface as one of those unrelated canary rewrites, not because crossing a
// canary block is itself unsafe.
//
// ONE test below is the deliberate exception (03-REVIEW.md CR-01): it edits
// "Canary tail paragraph." specifically SO THAT the left-anchor search must
// cross the reference-link canary paragraph (the 'def' block between them
// contributes no DOM element, making the reflink paragraph the tail
// paragraph's nearest DOM-adjacent neighbour) to find its anchor. This is
// exactly the shape CR-01 identified as broken: normalisedForm() used to
// parse that neighbour's slice with no document context, so it could never
// resolve the reference and would always compare unequal to the live,
// fully-resolved DOM -- sweeping the reflink paragraph into the splice and
// silently rewriting it from reference-link to inline spelling even though
// it was never touched. The test asserts the affected region excludes the
// reflink paragraph and that its original reference-link spelling (and its
// definition line) survive byte-identically.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { turndownBlock } from './turndown-block.js';
import { renderWithSourceMap } from './source-map.js';
import {
  getDocumentBody,
  setDocumentBody,
  getDocumentBlocks,
  setDocumentBlocks,
  getFrontMatter,
  setFrontMatter,
} from './sync-controller.js';

// Matches sync-controller.js's own DEFAULT_DOC_ID (1) -- every
// getDocumentBody()/getDocumentBlocks()/getFrontMatter() call below omits an
// explicit docId (relying on that default), so this mock's getActiveDocId()
// must resolve to the exact same value back-convert.js itself resolves via
// getActiveDocId(), or the two would silently read/write different docId
// slots in sync-controller.js's per-doc Maps.
const TEST_DOC_ID = 1;

let mockView = null;

vi.mock('../documents.js', () => ({
  getActiveEditor: () => mockView,
  getActiveDocId: () => TEST_DOC_ID,
  markDocumentDirty: vi.fn(),
}));

// Builds a real EditorState/EditorView pair -- no sync extensions needed,
// since these tests call syncPreviewBlockToMarkdown()/syncPreviewToMarkdown()
// directly and assert against the resulting document/dispatch call, not
// against dirty/debounce side effects a real createSyncExtensions(docId)
// would add. `vi.spyOn(view, 'dispatch')` (call-through, so the real
// dispatch still runs) is what every assertion below reads instead of a
// stubbed `document.execCommand` spy -- this is inspecting the REAL
// CM6 EditorView's own method being called with the REAL TransactionSpec
// dispatchAppWrite() builds, not a stand-in for missing jsdom functionality.
function mountView(doc = '') {
  const state = EditorState.create({ doc });
  const parent = document.getElementById('md-input');
  parent.innerHTML = '';
  const view = new EditorView({ state, parent });
  vi.spyOn(view, 'dispatch');
  return view;
}

let syncPreviewBlockToMarkdown;
let syncPreviewToMarkdown;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <div id="md-input"></div>
    </div>
    <div id="preview" contenteditable="true"></div>
    <span id="file-label"></span>
    <button id="btn-save"></button>
    <input type="checkbox" id="toggle-sync-scroll" />
  `;
  ({ syncPreviewBlockToMarkdown, syncPreviewToMarkdown } = await import('./back-convert.js'));
});

// Mirrors back-convert.js's own isRenderableBlockType predicate (not
// exported -- recomputed here, matching splice-integration.test.js's own
// precedent of re-deriving rather than reaching into the module's
// internals).
function renderableOf(blocks) {
  return blocks.filter((b) => b.type !== 'space' && b.type !== 'def');
}

const FIXTURE =
  'Title\n' +
  '=====\n' +
  '\n' +
  'Canary lead paragraph.\n' +
  '\n' +
  '* canary item one\n' +
  '* canary item two\n' +
  '\n' +
  'Canary mid paragraph.\n' +
  '\n' +
  '[Example][ref] link paragraph.\n' +
  '\n' +
  '[ref]: https://example.com\n' +
  '\n' +
  'Canary tail paragraph.\n' +
  '\n' +
  'Paragraph Alpha.\n' +
  '\n' +
  'Paragraph Beta.\n' +
  '\n\n\n' + // 3 blank lines -- deliberately NOT the canonical single blank line,
  // so the "reused pairwise ORIGINAL separator" test can prove it preserves
  // this exact gap rather than collapsing it (accepted-normalisations.md #7
  // would collapse it on any whole-document pass).
  'Paragraph Gamma.\n' +
  '\n' +
  'Paragraph Delta.\n' +
  '\n' +
  'Paragraph Epsilon.\n' +
  '\n' +
  'Paragraph Zeta.\n' +
  '\n' +
  'Paragraph Eta.\n' +
  '\n' +
  'Paragraph Theta.\n';

// Renderable index map (verified against a real renderWithSourceMap(FIXTURE)
// call during authoring -- not hardcoded blindly): 0 heading, 1 canary lead,
// 2 canary list, 3 canary mid, 4 canary reflink paragraph, 5 canary tail,
// 6 Alpha, 7 Beta, 8 Gamma, 9 Delta, 10 Epsilon, 11 Zeta, 12 Eta, 13 Theta.
// DOM child count matches renderable count exactly (14) since 'space'/'def'
// produce no element -- indices correspond 1:1 before any edit. Theta exists
// solely so Eta is never the LAST top-level token in the file -- marked's
// lexer folds the file's own trailing "\n" into whichever block IS last,
// and turndownBlock() never reproduces that trailing newline, which would
// make even an untouched last-paragraph comparison spuriously mismatch.
// Keeping every edit target away from the true end of file sidesteps that
// unrelated EOF artifact.

// Resets CONTENT on a fresh `#preview` and a fresh CM6 view mounted into
// `#md-input` for each test -- `mockView` is reassigned so the mocked
// `../documents.js`'s `getActiveEditor()` resolves to THIS test's own view.
function setupFixture() {
  const preview = document.getElementById('preview');
  const { html, blocks } = renderWithSourceMap(FIXTURE);
  preview.innerHTML = html;

  mockView = mountView(FIXTURE);

  setFrontMatter('');
  setDocumentBody(FIXTURE);
  setDocumentBlocks(blocks);

  return { preview, view: mockView, blocksBefore: blocks };
}

function placeCollapsedCaret(element) {
  const range = document.createRange();
  range.setStart(element.firstChild, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeSpanningSelection(startElement, endElement) {
  const range = document.createRange();
  range.setStart(startElement.firstChild, 0);
  range.setEnd(endElement.firstChild, endElement.firstChild.textContent.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Every OTHER renderable block's source text (outside [affectedStart,
// affectedEnd)) must be byte-identical in getDocumentBody() before/after.
// The suffix start-offset in bodyAfter is shifted by exactly
// (bodyAfter.length - bodyBefore.length) -- the net length delta the
// splice/replacement introduced -- relative to affectedEnd in bodyBefore.
// Unaffected by the write-mechanism cutover: getDocumentBody()/
// getDocumentBlocks() are back-convert.js's own bookkeeping, written
// explicitly via setDocumentBody()/setDocumentBlocks() regardless of how the
// CM6 view itself is written to.
function assertUntouchedOutside(bodyBefore, bodyAfter, affectedStart, affectedEnd) {
  expect(bodyAfter.slice(0, affectedStart)).toBe(bodyBefore.slice(0, affectedStart));
  const delta = bodyAfter.length - bodyBefore.length;
  expect(bodyAfter.slice(affectedEnd + delta)).toBe(bodyBefore.slice(affectedEnd));
}

describe('syncPreviewBlockToMarkdown', () => {
  beforeEach(() => {
    window.getSelection().removeAllRanges();
  });

  it('editing one block produces a single dispatch call matching turndownBlock output, with the exact splice range, and is idempotent on unchanged content', () => {
    const { preview, view } = setupFixture();
    const bodyBefore = getDocumentBody();
    const renderableBefore = renderableOf(getDocumentBlocks());
    const alphaBlock = renderableBefore[6];
    expect(bodyBefore.slice(alphaBlock.srcStart, alphaBlock.srcEnd)).toBe('Paragraph Alpha.');

    const target = preview.children[6];
    target.textContent = 'Paragraph Alpha EDITED.';
    placeCollapsedCaret(target);

    syncPreviewBlockToMarkdown('user-right');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const expectedReplacement = turndownBlock(target);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.insert).toBe(expectedReplacement);
    expect(changes.from).toBe(getFrontMatter().length + alphaBlock.srcStart);
    expect(changes.to).toBe(getFrontMatter().length + alphaBlock.srcEnd);
    // Not the whole-document fallback signature.
    expect(changes.from === 0 && changes.to === FIXTURE.length).toBe(false);

    const bodyAfter = getDocumentBody();
    assertUntouchedOutside(bodyBefore, bodyAfter, alphaBlock.srcStart, alphaBlock.srcEnd);
    expect(bodyAfter).toContain('Paragraph Alpha EDITED.');
    expect(bodyAfter).not.toContain('Paragraph Alpha.\n\nParagraph Beta');

    // Canaries survive byte-identical.
    expect(bodyAfter).toContain('Title\n=====');
    expect(bodyAfter).toContain('* canary item one\n* canary item two');
    expect(bodyAfter).toContain('[Example][ref] link paragraph.');
    expect(bodyAfter).toContain('[ref]: https://example.com');

    // Later blocks' stored offsets (including 'space' entries) shifted by
    // the correct delta.
    const delta = expectedReplacement.length - (alphaBlock.srcEnd - alphaBlock.srcStart);
    const rawAfter = getDocumentBlocks();
    const rawBefore = renderWithSourceMap(FIXTURE).blocks;
    const betaOldRaw = rawBefore.find((b) => bodyBefore.slice(b.srcStart, b.srcEnd) === 'Paragraph Beta.');
    const betaNewRaw = rawAfter.find((b) => bodyAfter.slice(b.srcStart, b.srcEnd) === 'Paragraph Beta.');
    expect(betaNewRaw.srcStart).toBe(betaOldRaw.srcStart + delta);
    expect(betaNewRaw.srcEnd).toBe(betaOldRaw.srcEnd + delta);
  });

  it('produces NO dispatch call when the block content is unchanged (idempotence)', () => {
    const { preview, view } = setupFixture();
    placeCollapsedCaret(preview.children[6]); // Alpha, untouched
    syncPreviewBlockToMarkdown('user-right');
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('an edit whose left-anchor search must cross a reference-link block treats it as unedited and preserves its reference-link spelling byte-identically (CR-01)', () => {
    const { preview, view } = setupFixture();
    const bodyBefore = getDocumentBody();
    const renderableBefore = renderableOf(getDocumentBlocks());
    const reflinkBlock = renderableBefore[4];
    const tailBlock = renderableBefore[5];
    expect(bodyBefore.slice(reflinkBlock.srcStart, reflinkBlock.srcEnd)).toBe(
      '[Example][ref] link paragraph.'
    );
    expect(bodyBefore.slice(tailBlock.srcStart, tailBlock.srcEnd)).toBe(
      'Canary tail paragraph.'
    );

    // Edit ONLY the tail paragraph. Its nearest DOM-adjacent neighbour to
    // the left is the reference-link paragraph (preview.children[4]) -- the
    // 'def' block between them contributes no DOM element at all, so the
    // left-anchor search's very first candidate IS the reflink paragraph.
    // Before the CR-01 fix, normalisedForm() parsed that candidate's raw
    // slice with no document context, could never resolve the reference,
    // and always compared unequal to the live (fully-resolved) DOM --
    // sweeping the reflink paragraph into the "affected" range and
    // rewriting it to inline spelling even though it was never touched.
    const target = preview.children[5];
    target.textContent = 'Canary tail paragraph EDITED.';
    placeCollapsedCaret(target);

    syncPreviewBlockToMarkdown('user-right');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const expectedReplacement = turndownBlock(target);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.insert).toBe(expectedReplacement);
    // The affected range is EXACTLY the tail paragraph -- the search
    // correctly recognised the reflink paragraph as unedited and stopped
    // there, rather than sweeping it (and the canary blocks beyond it) in.
    expect(changes.from).toBe(getFrontMatter().length + tailBlock.srcStart);
    expect(changes.to).toBe(getFrontMatter().length + tailBlock.srcEnd);

    const bodyAfter = getDocumentBody();
    assertUntouchedOutside(bodyBefore, bodyAfter, tailBlock.srcStart, tailBlock.srcEnd);
    // The reference-link paragraph and its definition survive byte-
    // identically in their ORIGINAL reference-link spelling -- not silently
    // rewritten to the inline spelling the live DOM would otherwise produce.
    expect(bodyAfter).toContain('[Example][ref] link paragraph.');
    expect(bodyAfter).toContain('[ref]: https://example.com');
    expect(bodyAfter).not.toContain('[Example](https://example.com) link paragraph.');
  });

  it('a selection spanning two adjacent renderable blocks (unchanged count) preserves the exact original separator text between them', () => {
    const { preview, view } = setupFixture();
    const bodyBefore = getDocumentBody();
    const renderableBefore = renderableOf(getDocumentBlocks());
    const betaBlock = renderableBefore[7];
    const gammaBlock = renderableBefore[8];
    const originalSeparator = bodyBefore.slice(betaBlock.srcEnd, gammaBlock.srcStart);
    expect(originalSeparator).toBe('\n\n\n\n'); // the deliberate non-canonical gap

    const betaEl = preview.children[7];
    const gammaEl = preview.children[8];
    betaEl.textContent = 'Paragraph Beta EDITED.';
    gammaEl.textContent = 'Paragraph Gamma EDITED.';
    placeSpanningSelection(betaEl, gammaEl);

    syncPreviewBlockToMarkdown('toolbar');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const expectedReplacement =
      turndownBlock(betaEl) + originalSeparator + turndownBlock(gammaEl);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.insert).toBe(expectedReplacement);
    expect(changes.from).toBe(getFrontMatter().length + betaBlock.srcStart);
    expect(changes.to).toBe(getFrontMatter().length + gammaBlock.srcEnd);

    const bodyAfter = getDocumentBody();
    assertUntouchedOutside(bodyBefore, bodyAfter, betaBlock.srcStart, gammaBlock.srcEnd);
    expect(bodyAfter).toContain('Title\n=====');
    expect(bodyAfter).toContain('* canary item one\n* canary item two');
    expect(bodyAfter).toContain('[Example][ref] link paragraph.');
  });

  it('Enter-split (1->2): the dispatched range covers exactly the original single paragraph, joined with the canonical separator, and every other block is byte-identical', () => {
    const { preview, view } = setupFixture();
    const bodyBefore = getDocumentBody();
    const renderableBefore = renderableOf(getDocumentBlocks());
    const deltaBlock = renderableBefore[9]; // "Paragraph Delta."
    expect(bodyBefore.slice(deltaBlock.srcStart, deltaBlock.srcEnd)).toBe('Paragraph Delta.');

    // Neither half's text may equal the ORIGINAL full paragraph text --
    // otherwise the left-anchor search's content comparison would treat
    // the unchanged-looking half as a genuine anchor (a real risk this
    // fixture must not trip over; see back-convert.js's own anchor-search
    // comments). Splitting the original sentence in two, as Enter actually
    // would, naturally avoids this.
    const original = preview.children[9];
    const first = document.createElement('p');
    first.textContent = 'Paragraph Delta continues';
    const second = document.createElement('p');
    second.textContent = 'onto a new second line.';
    original.replaceWith(first, second);
    placeCollapsedCaret(second); // collapsed caret in the SECOND new element

    syncPreviewBlockToMarkdown('user-right');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const expectedReplacement = turndownBlock(first) + '\n\n' + turndownBlock(second);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.insert).toBe(expectedReplacement);
    expect(changes.from).toBe(getFrontMatter().length + deltaBlock.srcStart);
    expect(changes.to).toBe(getFrontMatter().length + deltaBlock.srcEnd);

    const bodyAfter = getDocumentBody();
    assertUntouchedOutside(bodyBefore, bodyAfter, deltaBlock.srcStart, deltaBlock.srcEnd);
    expect(bodyAfter).toContain('onto a new second line.');
    expect(bodyAfter).toContain('Title\n=====');
    expect(bodyAfter).toContain('[Example][ref] link paragraph.');

    // Later block offsets (including 'space' entries) shifted by the delta.
    const delta = expectedReplacement.length - (deltaBlock.srcEnd - deltaBlock.srcStart);
    const rawBefore = renderWithSourceMap(FIXTURE).blocks;
    const rawAfter = getDocumentBlocks();
    const etaOldRaw = rawBefore.find((b) => bodyBefore.slice(b.srcStart, b.srcEnd) === 'Paragraph Eta.');
    const etaNewRaw = rawAfter.find((b) => bodyAfter.slice(b.srcStart, b.srcEnd) === 'Paragraph Eta.');
    expect(etaNewRaw.srcStart).toBe(etaOldRaw.srcStart + delta);
  });

  it('Backspace-join (2->1): the dispatched range covers exactly the union of both original paragraphs, and every other block is byte-identical', () => {
    const { preview, view } = setupFixture();
    const bodyBefore = getDocumentBody();
    const renderableBefore = renderableOf(getDocumentBlocks());
    const epsilonBlock = renderableBefore[10];
    const zetaBlock = renderableBefore[11];

    const epsilonEl = preview.children[10];
    const zetaEl = preview.children[11];
    const merged = document.createElement('p');
    merged.textContent = 'Paragraph Epsilon.Paragraph Zeta.';
    epsilonEl.replaceWith(merged);
    zetaEl.remove();
    placeCollapsedCaret(merged);

    syncPreviewBlockToMarkdown('user-right');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const expectedReplacement = turndownBlock(merged);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.insert).toBe(expectedReplacement);
    expect(changes.from).toBe(getFrontMatter().length + epsilonBlock.srcStart);
    expect(changes.to).toBe(getFrontMatter().length + zetaBlock.srcEnd);

    const bodyAfter = getDocumentBody();
    assertUntouchedOutside(bodyBefore, bodyAfter, epsilonBlock.srcStart, zetaBlock.srcEnd);
    expect(bodyAfter).toContain('Title\n=====');
    expect(bodyAfter).toContain('* canary item one\n* canary item two');
  });

  it('Toolbar list conversion (N->M): the affected range spans exactly the original paragraphs the new list replaced, found via content-based anchors, and every other block is byte-identical', () => {
    const { preview, view } = setupFixture();
    const bodyBefore = getDocumentBody();
    const renderableBefore = renderableOf(getDocumentBlocks());
    const alphaBlock = renderableBefore[6];
    const gammaBlock = renderableBefore[8];

    const alphaEl = preview.children[6];
    const betaEl = preview.children[7];
    const gammaEl = preview.children[8];
    const list = document.createElement('ul');
    for (const el of [alphaEl, betaEl, gammaEl]) {
      const li = document.createElement('li');
      li.textContent = el.textContent;
      list.appendChild(li);
    }
    alphaEl.replaceWith(list);
    betaEl.remove();
    gammaEl.remove();
    // Both anchor and focus resolve to the SAME new top-level <ul> element.
    const range = document.createRange();
    range.selectNodeContents(list);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    syncPreviewBlockToMarkdown('toolbar');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const expectedReplacement = turndownBlock(list);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.insert).toBe(expectedReplacement);
    expect(changes.from).toBe(getFrontMatter().length + alphaBlock.srcStart);
    expect(changes.to).toBe(getFrontMatter().length + gammaBlock.srcEnd);

    const bodyAfter = getDocumentBody();
    assertUntouchedOutside(bodyBefore, bodyAfter, alphaBlock.srcStart, gammaBlock.srcEnd);
    expect(bodyAfter).toContain('Title\n=====');
    expect(bodyAfter).toContain('[Example][ref] link paragraph.');
  });

  it('a genuinely unresolvable selection (rangeCount === 0) falls back to the whole-document syncPreviewToMarkdown path -- distinct from the five cases above', () => {
    const { view } = setupFixture();
    window.getSelection().removeAllRanges(); // rangeCount === 0

    syncPreviewBlockToMarkdown('user-right');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const { changes } = view.dispatch.mock.calls[0][0];
    // The whole-document fallback signature: full-document change range.
    expect(changes.from).toBe(0);
    expect(changes.to).toBe(FIXTURE.length);
    expect(typeof changes.insert).toBe('string');
  });
});

// [13-01] `view.composing` is a getter-only accessor on the real
// `EditorView` class (verified against the installed
// `node_modules/@codemirror/view/dist/index.js` source: `get composing() {
// return !!this.inputState && this.inputState.composing > 0; }`, no
// setter) -- `mockView` above is a REAL EditorView (this file's own header
// comment), so `mockView.composing = true` throws `TypeError: Cannot set
// property composing of #<EditorView> which has only a getter` under this
// codebase's ESM strict mode. Every test below instead uses
// `vi.spyOn(mockView, 'composing', 'get').mockReturnValue(true)` (vitest's
// accessor-mocking form) to shadow the getter for one test at a time. This
// file has no existing file-wide `afterEach` (only two `beforeEach` blocks
// exist, neither restores mocks) and `vitest.config.js` sets neither
// `restoreMocks` nor `clearMocks` globally -- a dedicated `afterEach`
// scoped to THIS describe block restores the spy so it cannot leak into
// this file's other, unrelated `vi.spyOn(view, 'dispatch')` spies or later
// tests.
// Mirrors back-convert.js's own module-level COMPOSITION_RETRY_MS (13-01) --
// not exported (this file re-derives constants rather than reaching into
// the module's internals, matching splice-integration.test.js's own
// precedent -- see renderableOf() above).
const COMPOSITION_RETRY_MS = 50;

describe('composition deferral (view.composing gate)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncPreviewBlockToMarkdown: defers the entire call (zero dispatch) and keeps re-deferring on every retry while still composing', () => {
    const { view } = setupFixture();
    vi.spyOn(view, 'composing', 'get').mockReturnValue(true);

    vi.useFakeTimers();
    try {
      syncPreviewBlockToMarkdown('user-right');
      expect(view.dispatch).not.toHaveBeenCalled();

      // The retry fires after COMPOSITION_RETRY_MS, finds composing still
      // true, and re-defers itself again rather than proceeding -- proving
      // the retry re-checks composing on every attempt, not just once.
      vi.advanceTimersByTime(COMPOSITION_RETRY_MS);
      expect(view.dispatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(COMPOSITION_RETRY_MS);
      expect(view.dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncPreviewBlockToMarkdown: once composing turns false, the next scheduled retry proceeds with the real write', () => {
    const { preview, view } = setupFixture();
    const composingSpy = vi.spyOn(view, 'composing', 'get').mockReturnValue(true);
    const target = preview.children[6]; // Alpha
    target.textContent = 'Paragraph Alpha EDITED.';
    placeCollapsedCaret(target);

    vi.useFakeTimers();
    try {
      syncPreviewBlockToMarkdown('user-right');
      expect(view.dispatch).not.toHaveBeenCalled();

      composingSpy.mockReturnValue(false); // composition ends before the retry fires
      vi.advanceTimersByTime(COMPOSITION_RETRY_MS);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncPreviewBlockToMarkdown: proceeds exactly as before (no deferral) when the view is not composing', () => {
    const { preview, view } = setupFixture();
    vi.spyOn(view, 'composing', 'get').mockReturnValue(false);
    const target = preview.children[6]; // Alpha
    target.textContent = 'Paragraph Alpha EDITED.';
    placeCollapsedCaret(target);

    syncPreviewBlockToMarkdown('user-right');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it('syncPreviewToMarkdown: defers the entire call (zero dispatch) while composing', () => {
    const { view } = setupFixture();
    vi.spyOn(view, 'composing', 'get').mockReturnValue(true);

    syncPreviewToMarkdown('paste');

    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('syncPreviewToMarkdown: once composing turns false, the next scheduled retry proceeds with the real write', () => {
    const { view } = setupFixture();
    const composingSpy = vi.spyOn(view, 'composing', 'get').mockReturnValue(true);

    vi.useFakeTimers();
    try {
      syncPreviewToMarkdown('paste');
      expect(view.dispatch).not.toHaveBeenCalled();

      composingSpy.mockReturnValue(false);
      vi.advanceTimersByTime(COMPOSITION_RETRY_MS);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('syncPreviewToMarkdown', () => {
  beforeEach(() => {
    window.getSelection().removeAllRanges();
  });

  it("still exists under its exact exported name, requires an explicit origin argument, and writes via a single whole-document CM6 transaction", () => {
    const { view } = setupFixture();
    expect(typeof syncPreviewToMarkdown).toBe('function');
    expect(syncPreviewToMarkdown.length).toBe(1); // one required parameter, no default

    syncPreviewToMarkdown('paste');

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes.from).toBe(0);
    expect(changes.to).toBe(FIXTURE.length);
    expect(typeof changes.insert).toBe('string');
  });

  it('is idempotent -- calling it twice in a row issues only one dispatch call', () => {
    const { view } = setupFixture();
    syncPreviewToMarkdown('paste');
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    view.dispatch.mockClear();
    // Second call: getDocumentBody()/the CM6 view's own doc now reflect the
    // canonicalised result from the first call, and the preview DOM (still
    // holding the ORIGINAL fixture HTML) round-trips to that SAME
    // canonical text again -- so the second call is a genuine no-op.
    syncPreviewToMarkdown('paste');
    expect(view.dispatch).not.toHaveBeenCalled();
  });
});
