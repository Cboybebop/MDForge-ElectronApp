// splice-integration.test.js -- the concrete, end-to-end reachability proof
// for CONV-05/success criterion 2: "regions of a document the user did not
// edit are byte-identical after a round trip." Every prior plan (02-01,
// 02-02, 02-04, 02-05) tested its own primitive in isolation; this is the
// first test that COMPOSES renderWithSourceMap() + a single-block conversion
// + spliceByRange() over one genuinely multi-block document and asserts
// exact substring equality (toBe) outside the edited range -- not a loose
// "still contains the text somewhere" check.
//
// Environment note: plain node, no `// @vitest-environment jsdom` docblock.
// The simulated edit is expressed as a plain HTML string -- exactly the
// shape a contenteditable edit to a single paragraph produces -- so no live
// DOM node needs to be constructed. This test therefore calls
// `turndown.turndown(protectComments(editedHtml))` directly rather than
// `turndownBlock(node)` (02-05-PLAN.md's single-DOM-subtree wrapper, which
// requires a real `node.outerHTML`): per 02-06-PLAN.md Task 2's explicit
// "if no DOM node is genuinely needed" branch, since the edited content is
// already available as an HTML string, wrapping it in a throwaway DOM
// element just to call turndownBlock() would add jsdom as a dependency of
// this test for no behavioral difference -- turndown.turndown() and
// turndownBlock() call the exact same configured singleton either way (see
// turndown-block.js's own body). Phase 3 is where a REAL DOM node from a
// live contenteditable edit gets passed to turndownBlock() -- this test
// proves the composition at the primitive level, which is exactly what
// 02-06-PLAN.md's objective calls for ("Phase 3 wires real DOM edits and
// caret tracking on top of exactly this composition").
import { describe, it, expect } from 'vitest';
import { renderWithSourceMap } from './source-map.js';
import { spliceByRange } from './splice.js';
import { turndown } from './turndown-config.js';
import { protectComments } from './comment-preserve.js';
import { markdownToHtml, htmlToMarkdown } from './convert.js';

// Four distinct top-level block types -- heading, two paragraphs, and a GFM
// table -- PLUS a raw HTML block and an HTML comment among the untouched
// blocks, per 02-06-PLAN.md's explicit instruction not to write a
// paragraphs-only test. Boundaries verified empirically against
// renderWithSourceMap() (see this file's own assertions below for the exact
// srcStart/srcEnd of every block -- no magic numbers are hardcoded).
const FIXTURE =
  '# Heading\n' +
  '\n' +
  'Paragraph A text.\n' +
  '\n' +
  'Paragraph B original text.\n' +
  '\n' +
  '<div class="note">A raw HTML block.</div>\n' +
  '\n' +
  '<!-- an html comment -->\n' +
  '\n' +
  '| Col1 | Col2 |\n' +
  '| --- | --- |\n' +
  '| a | b |\n';

// Locates paragraph B's block entry: the SECOND 'paragraph'-typed top-level
// token, by document order. Shared by both tests below so the edit-target
// identification logic is asserted once and reused, not duplicated.
function findParagraphB(fixture) {
  const { blocks } = renderWithSourceMap(fixture);
  const paragraphBlocks = blocks.filter((b) => b.type === 'paragraph');
  expect(paragraphBlocks.length).toBeGreaterThanOrEqual(2);
  return paragraphBlocks[1];
}

describe('splice-integration: renderWithSourceMap + turndown + spliceByRange', () => {
  it('leaves every untouched block byte-identical after a targeted single-block edit', () => {
    const { blocks } = renderWithSourceMap(FIXTURE);
    const paragraphB = findParagraphB(FIXTURE);

    // Sanity: the block's source range really is paragraph B's original
    // text, and blocks are contiguous (no gaps a splice could fall into).
    expect(FIXTURE.slice(paragraphB.srcStart, paragraphB.srcEnd)).toBe(
      'Paragraph B original text.'
    );
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].srcStart).toBe(blocks[i - 1].srcEnd);
    }

    // Simulate an edit to ONLY paragraph B: construct its post-edit HTML
    // directly (the shape a contenteditable edit would produce) and convert
    // just that HTML to Markdown.
    const editedHtml = '<p>Paragraph B EDITED text.</p>';
    const newParagraphBMarkdown = turndown.turndown(protectComments(editedHtml));

    const result = spliceByRange(
      FIXTURE,
      paragraphB.srcStart,
      paragraphB.srcEnd,
      newParagraphBMarkdown
    );

    // --- The core proof: exact substring equality (toBe), not a loose
    // contains check, on every byte outside the edited [srcStart, srcEnd)
    // range. ---
    const beforeOriginal = FIXTURE.slice(0, paragraphB.srcStart);
    const beforeResult = result.slice(0, paragraphB.srcStart);
    expect(beforeResult).toBe(beforeOriginal);

    const afterOriginal = FIXTURE.slice(paragraphB.srcEnd);
    const afterResult = result.slice(paragraphB.srcStart + newParagraphBMarkdown.length);
    expect(afterResult).toBe(afterOriginal);

    // The edited region reflects the new content, and only the new content.
    expect(result).toContain('Paragraph B EDITED text.');
    expect(result).not.toContain('Paragraph B original text.');

    // Explicit, named checks on each of the four untouched block types,
    // beyond the blanket before/after substring equality above -- this is
    // what proves the claim at the block-type level, not just "some bytes
    // matched somewhere".
    expect(beforeResult).toContain('# Heading');
    expect(beforeResult).toContain('Paragraph A text.');
    expect(afterResult).toContain('<div class="note">A raw HTML block.</div>');
    expect(afterResult).toContain('<!-- an html comment -->');
    expect(afterResult).toContain('| Col1 | Col2 |');
  });

  it('a second full markdownToHtml/htmlToMarkdown pass does not additionally alter the untouched blocks (fixpoint)', () => {
    const paragraphB = findParagraphB(FIXTURE);
    const editedHtml = '<p>Paragraph B EDITED text.</p>';
    const newParagraphBMarkdown = turndown.turndown(protectComments(editedHtml));
    const spliced = spliceByRange(
      FIXTURE,
      paragraphB.srcStart,
      paragraphB.srcEnd,
      newParagraphBMarkdown
    );

    // Fixpoint check per CONTEXT.md's "both an identity test AND a fixpoint
    // test" requirement (criterion 3), applied here to the SPLICED document:
    // running it through a second full round trip must not further disturb
    // the blocks the single-block edit did not touch.
    const { html: html1, frontMatter: fm1 } = markdownToHtml(spliced);
    const pass1 = htmlToMarkdown(html1, fm1);
    const { html: html2, frontMatter: fm2 } = markdownToHtml(pass1);
    const pass2 = htmlToMarkdown(html2, fm2);

    expect(pass2).toBe(pass1);

    // The untouched blocks survive both full-document passes, unperturbed
    // by the composition of a full round trip on top of the targeted splice.
    for (const marker of [
      '# Heading',
      'Paragraph A text.',
      '<div class="note">A raw HTML block.</div>',
      '<!-- an html comment -->'
    ]) {
      expect(pass1).toContain(marker);
      expect(pass2).toContain(marker);
    }
    expect(pass1).toContain('Paragraph B EDITED text.');
    expect(pass2).toContain('Paragraph B EDITED text.');
  });
});
