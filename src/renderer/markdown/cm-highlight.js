// Token-driven syntax highlighting + theming for the raw-Markdown CM6 pane
// (17-01-PLAN.md; EDIT-07/08/09/10/14). The token-to-role mapping below is
// copied EXACTLY from 17-UI-SPEC.md's "Token-to-Syntax-Role Mapping" table --
// it is not this file's own invention, and must not be re-derived by a
// future reader.
//
// Every `color`/`backgroundColor`/`borderLeftColor` value in both
// `mdHighlightStyle` and `mdEditorTheme` is a LITERAL `'var(--token)'`
// string, never a resolved hex. This is what makes theme switching "live":
// CM6's HighlightStyle/EditorView.theme machinery injects a static
// StyleModule <style> tag whose rule text is exactly what was passed to
// .define()/.theme() -- since every rule here is a literal var() reference,
// the browser re-resolves those custom properties the instant
// document.documentElement.dataset.theme changes, and the injected <style>
// tag repaints on its own, with zero CM6-side action, exactly like every
// other var()-based rule in panes.css/preview.css already does
// (17-UI-SPEC.md "Theme Switching Mechanism", paragraph 1).
// scripts/check-cm6-theme-no-hex.mjs is the permanent, npm-test-chained gate
// that keeps this true -- no hex/rgb()/rgba()/hsl()/hsla()/named colour may
// ever be introduced in this file.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

// See 17-UI-SPEC.md "Token-to-Syntax-Role Mapping" for the full rationale
// behind every row -- in particular why `tags.processingInstruction` is the
// ONE shared "dimmed marks" bucket every literal markup character resolves
// to (EDIT-08's "reads as annotated source, not a rainbow"), and why
// headings (EDIT-09) carry no colour rule at all -- differentiation is
// size/weight only, per the locked 28/23/19/16.5/15/14px,
// 700/700/600/600/600/600 scale.
export const mdHighlightStyle = HighlightStyle.define([
  // Dimmed-marks bucket (EDIT-08): HeaderMark, QuoteMark, ListMark,
  // LinkMark, EmphasisMark, CodeMark, HardBreak, GFM TableDelimiter, GFM
  // StrikethroughMark -- all tagged tags.processingInstruction by
  // @lezer/markdown's own markdownHighlighting/GFM styleTags calls.
  { tag: tags.processingInstruction, color: 'var(--text-dim)' },

  // Heading scale (EDIT-09) -- size/weight only, deliberately no colour.
  { tag: tags.heading1, fontSize: '28px', fontWeight: '700', lineHeight: '1.3' },
  { tag: tags.heading2, fontSize: '23px', fontWeight: '700', lineHeight: '1.3' },
  { tag: tags.heading3, fontSize: '19px', fontWeight: '600', lineHeight: '1.35' },
  { tag: tags.heading4, fontSize: '16.5px', fontWeight: '600', lineHeight: '1.4' },
  { tag: tags.heading5, fontSize: '15px', fontWeight: '600', lineHeight: '1.5' },
  { tag: tags.heading6, fontSize: '14px', fontWeight: '600', lineHeight: '1.5' },

  // Emphasis / strong / strikethrough content.
  { tag: tags.emphasis, color: 'var(--text-em)', fontStyle: 'italic' },
  { tag: tags.strong, color: 'var(--text-bright)', fontWeight: '700' },
  { tag: tags.strikethrough, color: 'var(--text-dim)', textDecoration: 'line-through' },

  // Links -- label pops via accent, marks/URL/label/title all recede.
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'none' },
  { tag: tags.url, color: 'var(--text-dim)' },
  { tag: tags.labelName, color: 'var(--text-dim)' }, // LinkLabel + CodeInfo
  { tag: tags.string, color: 'var(--text-dim)', fontStyle: 'italic' }, // LinkTitle

  // Inline code + fenced code content (identical tag in this grammar).
  { tag: tags.monospace, color: 'var(--accent)', backgroundColor: 'var(--accent-soft)' },

  // Blockquote content.
  { tag: tags.quote, color: 'var(--text-quote)', fontStyle: 'italic' },

  // GFM task list marker (EDIT-10) -- one opaque token, checked/unchecked
  // render identically (grammar limitation, not an oversight).
  { tag: tags.atom, color: 'var(--green)' },

  // GFM table header (EDIT-10) -- mirrors preview.css's #preview th exactly.
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },

  // YAML front matter (EDIT-14) -- custom FrontMatter node from
  // front-matter-lang.js, tagged tags.meta. Whole-block dim+italic.
  { tag: tags.meta, color: 'var(--text-dim)', fontStyle: 'italic' },

  // Discretionary: thematic break, mirrors preview.css's #preview hr.
  { tag: tags.contentSeparator, color: 'var(--border)' }
])

// Non-syntax chrome: selection, cursor, wrap/overflow. Kept as a standalone,
// module-scope object (not inlined into the EditorView.theme() call below)
// so it can be walked programmatically by cm-highlight.test.js -- the same
// zero-hex guarantee applies here as it does to mdHighlightStyle.specs.
//
// overflowWrap/overflowX (EDIT-12): EditorView.lineWrapping alone only
// wraps at word/whitespace boundaries -- a single unbroken token (a long
// URL, a long inline-code span) would not wrap under default
// word-break: normal and could still force horizontal overflow.
// overflowWrap: 'anywhere' forces a break mid-token for exactly that case;
// overflowX: 'hidden' on .cm-scroller is defense-in-depth on top of that.
export const mdEditorThemeSpec = {
  '.cm-content, .cm-line': { overflowWrap: 'anywhere' },
  '.cm-scroller': { overflowX: 'hidden' },
  // Matches panes.css line 186's #md-input::selection exactly.
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-soft-strong) !important'
  },
  // Matches preview.css's documented #preview { caret-color: var(--accent); }.
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: 'var(--accent)' }
}

export const mdEditorTheme = EditorView.theme(mdEditorThemeSpec)

// The single Compartment instance shared between cm-view.js (initial mount)
// and theme.js (toggle) -- see 17-UI-SPEC.md "Theme Switching Mechanism".
export const themeCompartment = new Compartment()

/**
 * Re-applies the theme Compartment's contents as a fresh, dispatched CM6
 * transaction. Structurally re-applies the SAME extension value
 * ([syntaxHighlighting(mdHighlightStyle), mdEditorTheme]) -- this is a
 * legitimate CM6 pattern ("same value, new transaction"), not a wasted
 * no-op: it is required by 17-CONTEXT.md Area 2's locked decision so the
 * repaint is a genuine, dispatched state transition inside the SAME
 * change/onSystemThemeChanged handler that mutates the data-theme
 * attribute, giving tests (and future readers) a real transition to assert
 * against rather than an assumption about implicit CSS cascade behaviour.
 * No EditorView rebuild ever occurs -- Compartment.reconfigure preserves
 * EditorState (undo history, selection, scroll) exactly.
 *
 * @param {import('@codemirror/view').EditorView} view
 */
export function repaintEditorTheme (view) {
  view.dispatch({
    effects: [themeCompartment.reconfigure([syntaxHighlighting(mdHighlightStyle), mdEditorTheme])]
  })
}
