// @vitest-environment jsdom
//
// Unit tests for getCurrentBlockTag()'s extended selector coverage (CONV-08)
// and, per Task 3, a round-trip safety audit of every command the WYSIWYG
// formatting toolbar offers. jsdom is required throughout -- these tests
// touch window.getSelection()/document.createRange() (Task 2) and construct
// contenteditable-shaped DOM directly (Task 3).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { savePreviewSelection } from './selection.js';
import { turndownBlock } from '../markdown/turndown-block.js';
import { renderWithSourceMap } from '../markdown/source-map.js';
import {
  getDocumentBody,
  setDocumentBody,
  setDocumentBlocks,
  setFrontMatter,
} from '../markdown/sync-controller.js';

// 05-03: format.js imports back-convert.js, which now imports documents.js
// -- documents.js captures `#md-input`/`#left-pane` as live element
// references AT MODULE-LOAD TIME and immediately wires
// attachEditorEvents()/attachLeftScrollSync() onto the bootstrap document's
// surface, including scroll-sync.js's own module-scope `#preview` lookup (a
// transitive import). A minimal DOM must therefore exist BEFORE format.js
// is ever imported -- mirroring preview/events.test.js's/
// back-convert.test.js's own established pattern (dynamic import inside
// `beforeAll`, after building a fixture) -- rather than this file's
// previous static top-of-file import (harmless before this plan, since
// format.js had no DOM-querying import of its own at module scope
// transitively). Every describe block below is free to replace
// `document.body.innerHTML` again afterward for its own fixture -- most of
// their assertions don't depend on getActiveEditor() resolving to any
// particular node, since format.js's own execCommand calls always target
// the LIVE `#preview` directly, never the raw-Markdown surface. [12-06]
// EXCEPTION: the "runFormatCommand routes its post-command sync through
// syncPreviewBlockToMarkdown" describe block below DOES depend on
// getActiveEditor()'s live CM6 document content -- back-convert.js's
// splice write (12-05's dispatchAppWrite() cutover) writes computed
// splice ranges straight into that real, shared view, so its own fixture
// helper seeds the view's document to match, see that block's own comment.
let getCurrentBlockTag;
let runFormatCommand;
let getActiveEditor;

beforeAll(async () => {
  // [12-05, applied here 12-06] `#md-input` is now a plain mount-host
  // `<div>`, matching index.html's real post-12-02 shape -- format.js
  // transitively imports back-convert.js -> documents.js, whose real,
  // unmocked bootstrap now mounts a real CM6 EditorView into this element
  // and throws against a mismatched `<textarea>` fixture (the same fixture
  // gap 12-05-PLAN.md already closed in preview/events.test.js; this file
  // was outside that plan's own files_modified list, tracked in
  // deferred-items.md until now).
  document.body.innerHTML = `
    <div id="preview" contenteditable="true"></div>
    <div id="md-input"></div>
  `;
  ({ getCurrentBlockTag, runFormatCommand } = await import('./format.js'));
  // [12-06] Dynamic import, same as format.js above and for the exact same
  // reason (this file's own header note, lines 20-35): documents.js
  // captures live element references at MODULE-LOAD TIME, so it must never
  // be imported statically before the DOM fixture above exists.
  ({ getActiveEditor } = await import('../documents.js'));
});

function setupDom() {
  document.body.innerHTML = `
    <div id="preview" contenteditable="true">
      <table>
        <tr><th>Header</th><td>Cell</td></tr>
      </table>
      <h5>Heading 5</h5>
      <h6>Heading 6</h6>
      <ul>
        <li>outer item<ul><li>inner item</li></ul></li>
      </ul>
    </div>
  `;
}

// Places a collapsed caret inside the first text node of the given element,
// mirroring how a real user's click/typing leaves window.getSelection()'s
// anchorNode pointed at a Text node inside the target block.
function placeCaretIn(element) {
  const textNode = element.firstChild;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('getCurrentBlockTag', () => {
  beforeEach(() => {
    setupDom();
  });

  it.each([
    ['h5', 'H5'],
    ['h6', 'H6'],
    ['th', 'TH'],
    ['td', 'TD'],
  ])('resolves a caret inside a <%s> to %s, not the old P fallback', (selector, expectedTag) => {
    placeCaretIn(document.querySelector(selector));
    expect(getCurrentBlockTag()).toBe(expectedTag);
  });

  it('resolves a caret in the innermost <li> of a nested list to LI (nearest ancestor via closest())', () => {
    const innerLi = document.querySelectorAll('li')[1];
    placeCaretIn(innerLi);
    expect(getCurrentBlockTag()).toBe('LI');
  });

  it('resolves a caret in the outer li\'s own text (not shared with the nested list) to LI', () => {
    const outerLi = document.querySelectorAll('li')[0];
    // outerLi's firstChild is the "outer item" text node, which precedes the
    // nested <ul> in document order -- distinct from the inner li's text.
    placeCaretIn(outerLi);
    expect(getCurrentBlockTag()).toBe('LI');
  });

  // Pre-existing coverage (already worked before this phase's selector
  // extension) locked as a regression guard so a future edit to the
  // selector string cannot silently break h1-h4/blockquote/pre/p.
  it.each([
    ['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'],
  ])('continues to resolve <%s> to %s unchanged', (tag, expectedTag) => {
    document.getElementById('preview').innerHTML = `<${tag}>text</${tag}>`;
    placeCaretIn(document.querySelector(tag));
    expect(getCurrentBlockTag()).toBe(expectedTag);
  });

  it.each([
    ['blockquote', 'BLOCKQUOTE'],
    ['pre', 'PRE'],
    ['p', 'P'],
  ])('continues to resolve <%s> to %s unchanged', (tag, expectedTag) => {
    document.getElementById('preview').innerHTML = `<${tag}>text</${tag}>`;
    placeCaretIn(document.querySelector(tag));
    expect(getCurrentBlockTag()).toBe(expectedTag);
  });
});

// --- Task 3: per-toolbar-command round-trip audit (CONV-08) ---
//
// jsdom does not implement document.execCommand at all (verified: calling
// it throws "doc.execCommand is not a function" under jsdom@30.0.1), so
// these tests cannot invoke the toolbar's actual runFormatCommand() and
// observe jsdom's own execCommand output -- there isn't any. Per
// 02-PATTERNS.md's explicit guidance for this file, each case instead
// constructs the DOM shape a real Chromium execCommand call is documented/
// verified to produce (a bare <b>/<i>/<u>/<strike> wrapper, a bare
// <ul>/<ol><li> list, an <a href> from createLink, and the formatBlock tag
// itself for the 7 format-block values), then runs that DOM through
// turndownBlock() -- the same primitive Task 1 built -- and asserts the
// resulting Markdown is non-lossy. This exercises exactly the half of the
// round trip that is deterministic and testable without a real browser;
// the execCommand-invocation half is inherently Electron/Chromium-only and
// out of this Electron-free core's testable surface.

function makeElement(tag, html) {
  document.body.innerHTML = `<${tag}>${html}</${tag}>`;
  return document.body.firstElementChild;
}

describe('per-toolbar-command round trip', () => {
  it.each([
    ['bold', 'b', 'bold text', '**bold text**'],
    ['italic', 'i', 'italic text', '*italic text*'],
    ['underline', 'u', 'underlined text', '<u>underlined text</u>'],
    ['strikeThrough', 'strike', 'struck text', '~~struck text~~'],
  ])('%s survives a round trip through turndown', (command, tag, text, expected) => {
    const node = makeElement('p', `<${tag}>${text}</${tag}>`);
    expect(turndownBlock(node)).toContain(expected);
  });

  it('insertUnorderedList survives a round trip through turndown', () => {
    const node = makeElement('ul', '<li>one</li><li>two</li>');
    const md = turndownBlock(node);
    expect(md).toContain('one');
    expect(md).toContain('two');
    expect(md).toMatch(/^-\s+one/m);
  });

  it('insertOrderedList survives a round trip through turndown', () => {
    const node = makeElement('ol', '<li>one</li><li>two</li>');
    const md = turndownBlock(node);
    expect(md).toContain('one');
    expect(md).toContain('two');
    expect(md).toMatch(/^1\.\s+one/m);
  });

  it('createLink produces a real Markdown link, not a bare href or a dropped link', () => {
    const node = makeElement('p', '<a href="https://example.com">click here</a>');
    const md = turndownBlock(node);
    expect(md).toBe('[click here](https://example.com)');
  });

  // The 7 format-block values (index.html's #format-block <select>): each
  // gets its own named it() since the expected Markdown shape differs per
  // value, per the plan's explicit instruction.
  it('formatBlock P round-trips to a plain paragraph', () => {
    const node = makeElement('p', 'plain paragraph text');
    expect(turndownBlock(node)).toBe('plain paragraph text');
  });

  it('formatBlock H1 round-trips to a # heading', () => {
    const node = makeElement('h1', 'Heading level one');
    expect(turndownBlock(node)).toBe('# Heading level one');
  });

  it('formatBlock H2 round-trips to a ## heading', () => {
    const node = makeElement('h2', 'Heading level two');
    expect(turndownBlock(node)).toBe('## Heading level two');
  });

  it('formatBlock H3 round-trips to a ### heading', () => {
    const node = makeElement('h3', 'Heading level three');
    expect(turndownBlock(node)).toBe('### Heading level three');
  });

  it('formatBlock H4 round-trips to a #### heading', () => {
    const node = makeElement('h4', 'Heading level four');
    expect(turndownBlock(node)).toBe('#### Heading level four');
  });

  it('formatBlock BLOCKQUOTE round-trips to a > blockquote with no residual wrapper HTML', () => {
    const node = makeElement('blockquote', 'quoted text');
    const md = turndownBlock(node);
    expect(md).toBe('> quoted text');
    expect(md).not.toContain('<');
  });

  it('formatBlock PRE round-trips to a fenced code block with no residual <pre> wrapper HTML', () => {
    // Named suspect from 02-CONTEXT.md: document.execCommand('formatBlock',
    // '<pre>') wraps the caret's block in a BARE <pre>text</pre> -- no
    // nested <code> -- which Turndown's own default fencedCodeBlock rule
    // (PRE > CODE only) does not match. This is the exact gap the
    // 'bareFencedCodeBlock' rule added to turndown-config.js in this plan
    // closes; without it, this assertion fails with the literal <pre> tag
    // still present in the output.
    const node = makeElement('pre', 'code text');
    const md = turndownBlock(node);
    expect(md).toBe('```\ncode text\n```');
    expect(md).not.toContain('<pre');
  });

  it('formatBlock PRE nested inside an existing blockquote produces no invalid nested <pre> in the Markdown', () => {
    // Second half of the same named suspect: formatBlock('<PRE>') applied
    // while the caret is already inside a blockquote.
    const node = makeElement('blockquote', '<pre>code text</pre>');
    const md = turndownBlock(node);
    expect(md).not.toContain('<pre');
    expect(md).toContain('```');
    expect(md.split('\n').every(line => line.startsWith('>'))).toBe(true);
  });

  it('a <span style="..."> wrapper (a known execCommand emission suspect) does not silently drop the inner text', () => {
    const node = makeElement('p', '<span style="font-weight:bold">span text</span>');
    expect(turndownBlock(node)).toContain('span text');
  });

  it('a <font> wrapper (a known execCommand emission suspect) does not silently drop the inner text', () => {
    const node = makeElement('p', '<font color="red">font text</font>');
    expect(turndownBlock(node)).toContain('font text');
  });
});

// --- 03-04-PLAN.md Task 2: runFormatCommand's post-command sync is routed
// through the range-based splice mechanism, not the whole-document one ---
//
// This is the exact test the plan-checker asked for, proving the fix
// rather than merely asserting the formatting result: a 3-paragraph
// fixture, a collapsed caret in paragraph 2, one format command -- and
// paragraph 1/paragraph 3's source ranges in getDocumentBody() must be
// BYTE-IDENTICAL before and after, not merely "still contain the text".
describe('runFormatCommand routes its post-command sync through syncPreviewBlockToMarkdown', () => {
  const FIXTURE = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.';

  function setupThreeParagraphFixture() {
    document.body.innerHTML = `
      <div id="preview" contenteditable="true"></div>
      <div id="md-input"></div>
      <span id="file-label"></span>
      <button id="btn-save"></button>
      <select id="format-block"><option value="P">P</option></select>
    `;
    const preview = document.getElementById('preview');
    const { html, blocks } = renderWithSourceMap(FIXTURE);
    preview.innerHTML = html;
    setFrontMatter('');
    setDocumentBody(FIXTURE);
    setDocumentBlocks(blocks);
    // [12-06] `#md-input` is now a plain mount-host `<div>` -- the shared
    // CM6 view mounted into it (documents.js's real, unmocked bootstrap,
    // from this file's own top-level beforeAll) is a SEPARATE piece of
    // state from sync-controller.js's own getDocumentBody() tracked
    // string set above. syncPreviewBlockToMarkdown() (back-convert.js)
    // computes its splice range by searching getDocumentBody(), but
    // WRITES that range straight into the live CM6 view via
    // dispatchAppWrite() -- leaving the view's real document at its
    // post-12-02 default (empty) throws `RangeError` the moment a
    // non-trivial splice range is dispatched against it. This dispatch
    // seeds the view's actual document to agree with FIXTURE, the CM6-
    // shaped equivalent of the retired `mdInput.value = FIXTURE`
    // assignment that used to keep the old textarea surface in sync.
    const view = getActiveEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: FIXTURE } });
    return { preview };
  }

  beforeEach(() => {
    // jsdom implements neither execCommand('bold', ...) nor
    // execCommand('insertText', ...) (this file's own header note) --
    // stub both. The non-insertText branch simulates an arbitrary
    // formatting mutation to whichever block the selection currently
    // rests in, so paragraph two's content genuinely changes; the
    // insertText branch simulates the real textarea-mutation side effect
    // syncPreviewBlockToMarkdown's write depends on.
    document.execCommand = vi.fn((command, _unused, value) => {
      if (command === 'insertText') {
        const ta = document.activeElement;
        if (ta && typeof ta.selectionStart === 'number') {
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          ta.value = ta.value.slice(0, start) + value + ta.value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + value.length;
        }
      } else {
        // Mutate the existing Text node's `data` in place (never reassign
        // `.textContent`, which would replace the Text node object outright
        // and detach the live selection Range from the DOM).
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const anchor = selection.anchorNode;
          const textNode = anchor && anchor.nodeType === Node.TEXT_NODE ? anchor : anchor?.firstChild;
          if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            textNode.data += ' FORMATTED';
          }
        }
      }
      return true;
    });
  });

  it('placing a collapsed caret in paragraph 2 and invoking a format command leaves paragraph 1 and paragraph 3 byte-identical', () => {
    const { preview } = setupThreeParagraphFixture();
    const bodyBefore = getDocumentBody();
    const { blocks } = renderWithSourceMap(bodyBefore);
    const paragraphs = blocks.filter((b) => b.type === 'paragraph');
    const p1 = paragraphs[0];
    const p2 = paragraphs[1];
    const p3 = paragraphs[2];
    expect(bodyBefore.slice(p1.srcStart, p1.srcEnd)).toBe('Paragraph one.');
    expect(bodyBefore.slice(p3.srcStart, p3.srcEnd)).toBe('Paragraph three.');

    const target = preview.children[1]; // paragraph two
    const range = document.createRange();
    range.setStart(target.firstChild, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // runFormatCommand's FIRST statement is restorePreviewSelection(), which
    // restores selection.js's own module-level savedSelection -- a singleton
    // that earlier tests in this file may have already populated with a
    // stale range. Without seeding it here, restorePreviewSelection() would
    // silently restore THAT stale selection instead of the one just placed
    // above (cross-test pollution), which is exactly what a real user
    // already did via the keyup/mouseup listeners' savePreviewSelection()
    // call before ever clicking a toolbar button -- so this mirrors real
    // production call order, not a test-only workaround.
    savePreviewSelection();

    runFormatCommand('bold');

    // Not the whole-document `syncPreviewToMarkdown` identifier at all --
    // grep-verified separately (see acceptance criteria); this test proves
    // the BEHAVIOURAL consequence of that routing.
    const bodyAfter = getDocumentBody();
    expect(bodyAfter.slice(0, p1.srcStart)).toBe(bodyBefore.slice(0, p1.srcStart));
    expect(bodyAfter.slice(p1.srcStart, p1.srcEnd)).toBe(bodyBefore.slice(p1.srcStart, p1.srcEnd));
    const delta = bodyAfter.length - bodyBefore.length;
    expect(bodyAfter.slice(p3.srcStart + delta, p3.srcEnd + delta)).toBe(
      bodyBefore.slice(p3.srcStart, p3.srcEnd)
    );
    expect(bodyAfter).toContain('Paragraph two. FORMATTED');
  });
});
