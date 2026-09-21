// 17-01-PLAN.md Task 2: front-matter-lang.js's frontMatterExtension,
// verified standalone -- parses directly against @lezer/markdown's
// MarkdownParser (via @codemirror/lang-markdown's markdown() config), no
// EditorView, no DOM.
import { describe, it, expect } from 'vitest'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { frontMatterExtension } from './front-matter-lang.js'

function parseWith (extensions, text) {
  return markdown({ extensions }).language.parser.parse(text)
}

describe('front-matter-lang.js', () => {
  it('tags a leading ---/---/--- block as a FrontMatter node covering exactly the three opening/content/closing lines', () => {
    const text = '---\ntitle: Test\n---\n\n# Body'
    const tree = parseWith([frontMatterExtension], text)

    const first = tree.topNode.firstChild
    expect(first).not.toBeNull()
    expect(first.name).toBe('FrontMatter')
    expect(first.from).toBe(0)
    // Ends at the closing "---" line's own end, excluding its trailing
    // newline -- the offset of "---\ntitle: Test\n---" (19 chars: indices
    // 0..19 exclusive).
    expect(first.to).toBe(text.indexOf('\n\n# Body'))
  })

  it('produces NO FrontMatter node when the document has no leading ---', () => {
    const text = '# Heading\n\nBody'
    const tree = parseWith([frontMatterExtension], text)

    expect(tree.topNode.getChild('FrontMatter')).toBeNull()
  })

  it('an unclosed leading --- block (no closing delimiter before EOF) produces exactly one FrontMatter node spanning to the document end, without throwing or hanging', () => {
    const text = '---\ntitle: Test'
    let tree
    expect(() => { tree = parseWith([frontMatterExtension], text) }).not.toThrow()

    const frontMatterNodes = tree.topNode.getChildren('FrontMatter')
    expect(frontMatterNodes.length).toBe(1)
    expect(frontMatterNodes[0].from).toBe(0)
    expect(frontMatterNodes[0].to).toBe(text.length)
  })

  // Documented, accepted known mismatch vs. front-matter.js's own regex
  // (which requires the line immediately after the opening --- to be
  // non-blank, precisely so it does NOT treat two thematic breaks around a
  // paragraph as front matter -- see front-matter.js's FRONT_MATTER_RE
  // comment). This grammar has no such lookahead, so it tags the whole
  // ---\n\nSome paragraph\n\n---\n span as ONE FrontMatter node. Recorded
  // here as REQUIREMENTS.md Future Requirements' accepted, cosmetic-only,
  // non-data-path gap -- this test asserts the CURRENT behaviour, not a
  // "should not happen" failure.
  it('KNOWN, ACCEPTED MISMATCH: two thematic breaks around a paragraph are tagged as one FrontMatter node (front-matter.js\'s regex disagrees, by design -- cosmetic-only gap)', () => {
    const text = '---\n\nSome paragraph\n\n---\n'
    const tree = parseWith([frontMatterExtension], text)

    const frontMatterNodes = tree.topNode.getChildren('FrontMatter')
    expect(frontMatterNodes.length).toBe(1)
    expect(frontMatterNodes[0].from).toBe(0)
    // Covers through the second "---" line, excluding its own trailing
    // newline -- i.e. everything up to the final newline character.
    expect(frontMatterNodes[0].to).toBe(text.length - 1)
  })

  it('production parity: a leading front-matter block AND a GFM table coexist correctly in the combined [GFM, frontMatterExtension] configuration', () => {
    const text = '---\ntitle: Test\n---\n\n| A |\n| --- |\n| 1 |\n'
    const tree = parseWith([GFM, frontMatterExtension], text)

    const frontMatter = tree.topNode.getChild('FrontMatter')
    expect(frontMatter).not.toBeNull()
    expect(frontMatter.from).toBe(0)

    const table = tree.topNode.getChild('Table')
    expect(table).not.toBeNull()
    expect(table.from).toBeGreaterThan(frontMatter.to)
  })
})
