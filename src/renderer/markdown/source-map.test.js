// Plain Node, no jsdom -- renderWithSourceMap() is marked.lexer()/parser()
// plus pure offset arithmetic, no DOM (same rationale as
// src/main/url-guard.test.js).
import { describe, it, expect } from 'vitest'
import { renderWithSourceMap } from './source-map.js'
import { marked } from './marked-config.js'

describe('renderWithSourceMap', () => {
  it('returns { html, blocks }', () => {
    const result = renderWithSourceMap('# Heading\n\nSome paragraph.\n')
    expect(result).toHaveProperty('html')
    expect(result).toHaveProperty('blocks')
    expect(Array.isArray(result.blocks)).toBe(true)
  })

  it('emits one block per top-level marked.lexer() token, in document order', () => {
    const md = '# Heading\n\nSome paragraph.\n'
    const tokens = marked.lexer(md)
    const { blocks } = renderWithSourceMap(md)
    expect(blocks).toHaveLength(tokens.length)
    blocks.forEach((block, i) => {
      expect(block.type).toBe(tokens[i].type)
      expect(block.index).toBe(i)
    })
  })

  it('sums (srcEnd - srcStart) across all blocks to exactly the source length', () => {
    // The load-bearing invariant CONV-05 depends on: untouched regions stay
    // byte-identical because splice.js can always find an exact source
    // range for every block, with no gaps and no overlap.
    const md =
      '# Heading\n\nSome paragraph.\n\n> a quote\n\n```js\ncode();\n```\n\n---\n\n' +
      '<div>raw html</div>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- item1\n- item2\n'
    const { blocks } = renderWithSourceMap(md)
    const total = blocks.reduce((sum, b) => sum + (b.srcEnd - b.srcStart), 0)
    expect(total).toBe(md.length)
  })

  it('blocks are contiguous and non-overlapping, in document order', () => {
    const md = '# Heading\n\nSome paragraph.\n\n> a quote\n\n- item1\n- item2\n'
    const { blocks } = renderWithSourceMap(md)
    expect(blocks[0].srcStart).toBe(0)
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].srcStart).toBe(blocks[i - 1].srcEnd)
    }
    expect(blocks[blocks.length - 1].srcEnd).toBe(md.length)
  })

  it('produces html byte-identical to marked.parse(md)', () => {
    const md = '# Heading\n\nSome **bold** paragraph.\n'
    const { html } = renderWithSourceMap(md)
    expect(html).toBe(marked.parse(md))
    expect(html.length).toBeGreaterThan(0)
  })

  it.each([
    ['paragraph', 'Some paragraph.\n'],
    ['heading', '# Heading\n'],
    ['blockquote', '> a quote\n'],
    ['code', '```js\ncode();\n```\n'],
    ['hr', '---\n'],
    ['html', '<div>raw html</div>\n'],
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |\n'],
    ['list', '- item1\n- item2\n']
  ])('covers the %s token type with an exact srcStart/srcEnd range', (type, md) => {
    const { blocks } = renderWithSourceMap(md)
    const block = blocks.find((b) => b.type === type)
    expect(block).toBeDefined()
    expect(md.slice(block.srcStart, block.srcEnd)).toBe(
      marked.lexer(md).find((t) => t.type === type).raw
    )
  })
})
