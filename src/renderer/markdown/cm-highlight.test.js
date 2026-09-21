// 17-01-PLAN.md Task 1: cm-highlight.js's mdHighlightStyle/mdEditorTheme/
// themeCompartment/repaintEditorTheme, verified standalone -- no EditorView,
// no DOM -- proving the token-to-role contract is correct in isolation
// before Plan 17-02 wires it into the live editor.
import { describe, it, expect } from 'vitest'
import { tags } from '@lezer/highlight'
import { Compartment } from '@codemirror/state'
import {
  mdHighlightStyle,
  mdEditorThemeSpec,
  themeCompartment,
  repaintEditorTheme
} from './cm-highlight.js'

// The exact set of tags the 17-01-PLAN.md <source_findings> token table
// names -- used to assert every mdHighlightStyle spec's tag is one of
// these, by identity (not by string name, since Tag objects are opaque).
const EXPECTED_TAGS = [
  tags.processingInstruction,
  tags.heading1,
  tags.heading2,
  tags.heading3,
  tags.heading4,
  tags.heading5,
  tags.heading6,
  tags.emphasis,
  tags.strong,
  tags.strikethrough,
  tags.link,
  tags.url,
  tags.labelName,
  tags.string,
  tags.monospace,
  tags.quote,
  tags.atom,
  tags.heading,
  tags.meta,
  tags.contentSeparator
]

// Recursively collects every color/backgroundColor/borderLeftColor value
// found anywhere in a style-object tree (mdHighlightStyle.specs entries, or
// mdEditorThemeSpec's nested per-selector objects). Deliberately skips the
// `tag`/`class` keys -- mdHighlightStyle.specs entries carry a `tag`
// property pointing at an opaque, internally-circular @lezer/highlight Tag
// object, and recursing into it would blow the call stack for no reason
// (it can never carry a color/backgroundColor/borderLeftColor value).
const COLOR_KEYS = ['color', 'backgroundColor', 'borderLeftColor']
const SKIP_KEYS = ['tag', 'class']

function collectColorValues (node, out = []) {
  if (node === null || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.includes(key)) continue
    if (COLOR_KEYS.includes(key) && typeof value === 'string') {
      out.push(value)
    } else if (value !== null && typeof value === 'object') {
      collectColorValues(value, out)
    }
  }
  return out
}

describe('cm-highlight.js', () => {
  it('mdHighlightStyle.specs has at least 19 entries, every one tagged with a tag from the locked token table', () => {
    expect(mdHighlightStyle.specs.length).toBeGreaterThanOrEqual(19)

    for (const spec of mdHighlightStyle.specs) {
      expect(EXPECTED_TAGS).toContain(spec.tag)
    }
  })

  it('every color/backgroundColor/borderLeftColor value in mdHighlightStyle.specs is a var(--token) reference', () => {
    const values = collectColorValues(mdHighlightStyle.specs)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(value.startsWith('var(--')).toBe(true)
    }
  })

  it('every color/backgroundColor/borderLeftColor value in mdEditorThemeSpec is a var(--token) reference', () => {
    const values = collectColorValues(mdEditorThemeSpec)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(value.startsWith('var(--')).toBe(true)
    }
  })

  it('mdEditorThemeSpec carries the required selection/cursor/wrap rules', () => {
    expect(mdEditorThemeSpec['.cm-content, .cm-line']).toEqual({ overflowWrap: 'anywhere' })
    expect(mdEditorThemeSpec['.cm-scroller']).toEqual({ overflowX: 'hidden' })
    expect(mdEditorThemeSpec['.cm-selectionBackground, .cm-content ::selection'].backgroundColor)
      .toBe('var(--accent-soft-strong) !important')
    expect(mdEditorThemeSpec['.cm-cursor, .cm-cursor-primary'].borderLeftColor)
      .toBe('var(--accent)')
  })

  it('themeCompartment is a real Compartment instance', () => {
    expect(themeCompartment instanceof Compartment).toBe(true)
  })

  it('repaintEditorTheme(view) dispatches exactly once with a single reconfigure effect', () => {
    const dispatched = []
    const mockView = { dispatch: (spec) => dispatched.push(spec) }

    repaintEditorTheme(mockView)

    expect(dispatched.length).toBe(1)
    expect(Array.isArray(dispatched[0].effects)).toBe(true)
    expect(dispatched[0].effects.length).toBe(1)
  })
})
