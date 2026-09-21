// These run under plain Node -- no jsdom, no Electron -- because
// front-matter.js is pure string-surgery with no DOM/Electron import (same
// rationale as src/main/url-guard.test.js).
import { describe, it, expect } from 'vitest'
import { stripFrontMatter, reattachFrontMatter } from './front-matter.js'

describe('stripFrontMatter / reattachFrontMatter', () => {
  it('round-trips a document with front matter byte-identically', () => {
    // The single most important case: CONV-03 requires this to be exact,
    // not approximate.
    const md = '---\ntitle: Test\n---\n\n# Body\n'
    const { frontMatter, body } = stripFrontMatter(md)
    expect(frontMatter).toBe('---\ntitle: Test\n---\n')
    expect(body).toBe('\n# Body\n')
    expect(reattachFrontMatter(frontMatter, body)).toBe(md)
  })

  it('returns an empty frontMatter for a document with none', () => {
    const md = '# No front matter\n'
    const { frontMatter, body } = stripFrontMatter(md)
    expect(frontMatter).toBe('')
    expect(body).toBe(md)
    expect(reattachFrontMatter(frontMatter, body)).toBe(md)
  })

  it.each([
    ['\r\n line endings', '---\r\ntitle: Test\r\n---\r\n\r\n# Body\r\n'],
    ['no trailing newline after closing delimiter', '---\ntitle: Test\n---'],
    ['multi-line YAML body', '---\ntitle: Test\ntags:\n  - a\n  - b\n---\n\nBody text.\n'],
    ['front matter only, no body', '---\ntitle: Test\n---\n']
  ])('round-trips byte-identically: %s', (_label, md) => {
    const { frontMatter, body } = stripFrontMatter(md)
    expect(reattachFrontMatter(frontMatter, body)).toBe(md)
  })

  it('does not treat a mid-document horizontal rule as front matter', () => {
    const md = '# Heading\n\n---\n\nMore text.\n'
    const { frontMatter, body } = stripFrontMatter(md)
    expect(frontMatter).toBe('')
    expect(body).toBe(md)
  })

  it('does not misclassify a document that legitimately opens with a thematic break as front matter (CR-03)', () => {
    // Verbatim reproduction from 02-REVIEW.md CR-03: a document opening
    // with a thematic break, a real paragraph, and a second thematic
    // break -- an ordinary authoring pattern (e.g. a byline/preamble rule)
    // that the old unconditional `---`-delimited regex could not
    // distinguish from YAML front matter. Before the fix, the entire
    // paragraph between the two rules was silently stripped out-of-band
    // and never reached marked.parse(), so the rendered preview omitted
    // it while the raw-Markdown pane still showed it -- a direct breach
    // of the "editing either pane... must always work" core value.
    const md = '---\n\nActual paragraph content here.\n\n---\n\nMore text after.\n'
    const { frontMatter, body } = stripFrontMatter(md)
    expect(frontMatter).toBe('')
    expect(body).toBe(md)
    expect(reattachFrontMatter(frontMatter, body)).toBe(md)
  })
})
