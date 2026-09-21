// Mechanism regression suite for turndown-config.js / comment-preserve.js /
// marked-config.js.
//
// Plain node environment throughout -- no jsdom docblock. Turndown's own
// @mixmark-io/domino fallback (a hard dependency of turndown itself,
// already resolved in package-lock.json) provides the DOM it needs to run
// under plain Node, verified in 02-RESEARCH.md's "Vitest test-environment
// routing" note. None of the assertions below touch DOMPurify or
// `document`, so jsdom is not required here.
import { describe, it, expect } from 'vitest'
import { turndown } from './turndown-config.js'
import { protectComments } from './comment-preserve.js'
import { marked } from './marked-config.js'

describe('turndown escape narrowing (non-intraword */_ only)', () => {
  // Turndown's default escape() unconditionally backslashes every `*`/`_`
  // anywhere in a text node. CommonMark never re-parses an intraword `_` as
  // emphasis, and never re-parses a space-flanked or trailing-lone `*`
  // either -- so the default behaviour produces pure backslash noise on
  // these constructs (02-RESEARCH.md Pattern 4; PITFALLS.md "Mangled:
  // backslash noise").
  it.each([
    ['get_user_name()', 'get_user_name()'],
    ['snake_case', 'snake_case'],
    ['a_b_c_d', 'a_b_c_d']
  ])('does not backslash-escape underscores in %s', (input, expected) => {
    expect(turndown.turndown(`<p>${input}</p>`)).toBe(expected)
  })

  it('backslash-escapes a fully intraword asterisk (CR-02: * is NOT symmetric with _)', () => {
    // 02-REVIEW.md CR-02: an earlier version of this file narrowed `*`
    // exactly like `_` (skip escaping when both neighbours are
    // alphanumeric), by analogy. That analogy is wrong: CommonMark's
    // flanking-delimiter rules explicitly PERMIT intraword `*` emphasis
    // (unlike `_`, which CommonMark forbids intraword). Leaving an
    // intraword literal `*` unescaped means it can become an available
    // emphasis delimiter on the next parse and pair with an unrelated,
    // genuine emphasis marker elsewhere in the same document -- wrapping an
    // arbitrary span of text in <em> and leaving a stray `*` behind. `*` is
    // therefore ALWAYS escaped now, unconditionally of intraword position.
    expect(turndown.turndown('<p>wor*d</p>')).toBe('wor\\*d')
  })

  it('still escapes a space-flanked asterisk (verbatim regex behaviour, not a defect)', () => {
    expect(turndown.turndown('<p>5 * 3 = 15</p>')).toBe('5 \\* 3 = 15')
  })

  it('does not let an unescaped literal intraword asterisk corrupt unrelated emphasis elsewhere in the document (CR-02)', () => {
    // Verbatim reproduction from 02-REVIEW.md CR-02: a literal
    // backslash-escaped asterisk earlier in the paragraph, and a genuine
    // emphasis pair later in the SAME paragraph. Before the fix, the
    // narrowed `*` rule (by incorrect analogy with `_`) skipped escaping
    // the literal star because it was flanked by alphanumerics, so it
    // silently lost its backslash on the way out -- becoming an available
    // delimiter that paired across the entire span to the next real `*`
    // and wrapped ~40 unrelated characters in emphasis, with a stray `*`
    // left dangling. The round trip must be identity: the input already
    // has a valid escaped literal star and valid real emphasis: nothing
    // here should change.
    const input = 'a\\*b literal star then later c*d*e'
    const html = marked.parse(input)
    expect(html).toBe('<p>a*b literal star then later c<em>d</em>e</p>\n')
    const back = turndown.turndown(html)
    expect(back).toBe(input)
    // And it must not corrupt on a second pass either (fixpoint).
    const html2 = marked.parse(back)
    expect(turndown.turndown(html2)).toBe(back)
  })

  it('leaves an isolated footnote marker unescaped ([ and ] no longer escaped)', () => {
    // No matching [^1]: definition anywhere -- marked treats this as
    // literal text, and the old default escape() rule falsely
    // bracket-escaped it (PITFALLS.md footnote case, isolated-marker shape
    // only -- see 02-RESEARCH.md Pitfall 3 for why the paired-definition
    // shape is a separate, out-of-scope-for-this-plan corruption).
    expect(turndown.turndown('<p>See [^1] for details.</p>')).toBe('See [^1] for details.')
  })
})

describe('emDelimiter fix for 2*3*4 (not an escape() bug)', () => {
  // The single most important case CONTEXT.md/RESEARCH.md name explicitly:
  // by the time Turndown runs, marked has already turned `2*3*4` into a
  // real <em> element (CommonMark permits intraword single-* emphasis).
  // escape() narrowing has zero effect here -- only emDelimiter controls
  // how that <em> element serialises back out (02-RESEARCH.md Pitfall 2 /
  // Major Correction 2).
  it('round-trips 2*3*4 = 24 through marked+turndown without corrupting to 2_3_4', () => {
    const html = marked.parse('2*3*4 = 24')
    expect(turndown.turndown(html)).toBe('2*3*4 = 24')
  })

  it('normalises underscore-style emphasis to asterisk-style (no regression)', () => {
    const html = marked.parse('_italic_ and __bold__ and ___bold italic___')
    expect(turndown.turndown(html)).toBe('*italic* and **bold** and ***bold italic***')
  })
})

describe('GFM pipe-escape regression (locked, unpatched)', () => {
  // 02-RESEARCH.md Major Correction 1: this scenario, taken verbatim from
  // PITFALLS.md's compounding-loss case, was expected to require a patch to
  // the plugin's own table rule. Verified against the pinned
  // @joplin/turndown-plugin-gfm@1.0.67: the plugin's cell() function
  // already escapes `|` via `.replace(/\|+/g, '\\|')`, and marked's GFM
  // table lexer correctly un-escapes it back to a literal `|` on the way
  // in. This test intentionally applies NO patch -- it exists to lock the
  // behaviour so a future turndown-plugin-gfm version bump cannot silently
  // reintroduce PITFALLS.md's "pipes is gone forever" bug.
  const pass0 = '| Cmd | Note |\n| --- | --- |\n| a \\| b | pipes |'

  it('does not lose the escaped-pipe cell on the first pass (identity)', () => {
    const html0 = marked.parse(pass0)
    const pass1 = turndown.turndown(html0)
    expect(pass1).toBe(pass0)
  })

  it('does not lose the escaped-pipe cell on a second pass (fixpoint)', () => {
    const html0 = marked.parse(pass0)
    const pass1 = turndown.turndown(html0)
    const html1 = marked.parse(pass1)
    const pass2 = turndown.turndown(html1)
    expect(pass2).toBe(pass1)
  })
})

describe('GFM table survives a preview edit unchanged (CONV-01)', () => {
  it('round-trips a plain table byte-identically after the tableCell whitespace override', () => {
    const md = '| Name | Qty |\n| --- | --- |\n| Bolt | 12 |\n| Nut | 7 |'
    const html = marked.parse(md)
    expect(turndown.turndown(html)).toBe(md)
  })

  // WR-01 note: a dedicated regression test for the reversed \n\r-vs-\r\n
  // CRLF regex in the tableCell rule (turndown-config.js) was attempted and
  // deliberately NOT added here. Turndown's own collapseWhitespace() DOM
  // preprocessing step (verified directly in turndown.cjs.js:368,
  // `text.data.replace(/[ \r\n\t]+/g, ' ')`) unconditionally collapses any
  // run of \r\n\t\space in a non-<pre> text node to a single space BEFORE
  // any rule (including this custom tableCell rule) ever sees the node's
  // content -- so a literal CRLF inside an ordinary table-cell text node
  // can never actually reach this regex in the standard turndown.turndown()
  // pipeline; it is provably unreachable dead code today, exactly as
  // 02-REVIEW.md WR-01 itself concludes ("not a data-loss bug today").
  // The regex direction is still corrected (matching the plugin's own
  // \r\n-then-\n intent rather than the transposed \n\r), verified via the
  // existing table round-trip test above and the full corpus suite with no
  // regressions, but no executable round-trip proof could be constructed
  // for the specific reachability claim without a deeper Turndown change
  // (e.g. a custom isPre) that is out of this fix's scope.
})

describe('GFM task list survives a preview edit (CONV-02)', () => {
  it('preserves checkbox state and does not double-space after the marker', () => {
    const md = '- [ ] todo\n- [x] done'
    const html = marked.parse(md)
    const back = turndown.turndown(html)
    // The leading 3-space padding after "-" (Turndown's own bullet-list-item
    // rendering, present even for a plain, non-task bullet list) is a
    // pre-existing normalisation, not new -- verified by round-tripping a
    // plain "- one\n- two" list through this same pipeline and observing
    // identical "-   " padding with no GFM/task-list involvement at all.
    // What this test actually locks down is the ABSENCE of a second,
    // doubled space between the checkbox marker and the item text
    // (02-RESEARCH.md Pitfall 1) -- the whitespace-trim override's real job.
    expect(back).toBe('-   [ ] todo\n-   [x] done')
    expect(back).not.toContain('[ ]  ')
    expect(back).not.toContain('[x]  ')
  })
})

describe('HTML comment preservation (CONV-04)', () => {
  it('round-trips a standalone block-level comment verbatim', () => {
    const html = '<p>before</p>\n<!-- TODO: revisit -->\n<p>after</p>'
    const back = turndown.turndown(protectComments(html))
    expect(back).toContain('<!-- TODO: revisit -->')
    expect(back).not.toContain('mdforge-comment')
  })

  it('round-trips an inline mid-paragraph comment verbatim', () => {
    const html = '<p>Some text <!-- inline note --> continues here.</p>'
    const back = turndown.turndown(protectComments(html))
    expect(back).toBe('Some text <!-- inline note --> continues here.')
  })

  it('preserves a literal <mdforge-comment> element already in the user\'s own document instead of garbling it (WR-03)', () => {
    // A user's own document may legitimately contain the literal
    // <mdforge-comment> tag name -- a custom element, or content
    // discussing/documenting this very mechanism. Before the fix, the
    // commentPlaceholder rule blindly ran Buffer.from(content, 'base64')
    // on ANY <mdforge-comment> element's content, and Node's base64
    // decoder is lenient (does not throw on invalid input) -- so this
    // literal, non-placeholder content would be silently mangled into
    // garbled text wrapped in a fabricated HTML comment. The per-session
    // marker check must reject it and preserve the text verbatim instead.
    const html = '<p>See <mdforge-comment>not a real placeholder</mdforge-comment> here.</p>'
    const back = turndown.turndown(protectComments(html))
    expect(back).toContain('not a real placeholder')
    expect(back).not.toContain('<!--')
  })

  it('does not silently delete everything after a stray, unterminated "<!--" (CR-01)', () => {
    // Verbatim reproduction from 02-REVIEW.md CR-01: a document with a
    // heading, an unterminated HTML comment opener, and real content after
    // it. Before the fix, protectComments()'s paired regex never matches an
    // unterminated comment, so the raw '<!--' reaches Turndown's HTML
    // parser unprotected -- which then treats it exactly like a real,
    // unterminated HTML comment (consumes to end-of-document) and silently
    // discards everything after it, because Turndown's process() never
    // dispatches Comment nodes to any rule.
    const input =
      '# Heading\n\n<!-- oops never closed\n\nParagraph after the stray comment opener.\n\n## Another heading\n'
    const html = marked.parse(input)
    const back = turndown.turndown(protectComments(html))
    expect(back).toContain('Heading')
    expect(back).toContain('Paragraph after the stray comment opener.')
    expect(back).toContain('Another heading')
  })
})

describe('<u> underline survives rather than being silently deleted (CONV-08)', () => {
  it('preserves <u>...</u> verbatim through turndown.turndown()', () => {
    expect(turndown.turndown('<p>a <u>b</u> c</p>')).toBe('a <u>b</u> c')
  })
})

describe('SCRIPT/STYLE/TEXTAREA raw-HTML blocks survive verbatim (CONV-04, Gap A closure)', () => {
  // 02-VERIFICATION.md human_verification item 1: Turndown's own internal
  // blockElements list (turndown.cjs.js) omits these three tag names, so
  // defaultReplacement's node.isBlock check never fired and they were
  // silently flattened to escaped plain text instead of surviving like
  // <iframe>/<div> do. Fixed by adding them to turndown.keep() above --
  // keep()'s own keepReplacement always emits node.outerHTML regardless of
  // isBlock, the same mechanism that already preserves <iframe> verbatim.
  it('preserves a <script> element verbatim', () => {
    const html = marked.parse('<script>window.__pwned = true;</script>')
    expect(turndown.turndown(protectComments(html))).toBe('<script>window.__pwned = true;</script>')
  })

  it('preserves a <style> element verbatim', () => {
    const html = marked.parse('<style>.x { color: red; }</style>')
    expect(turndown.turndown(protectComments(html))).toBe('<style>.x { color: red; }</style>')
  })

  it('preserves a <textarea> element verbatim', () => {
    const html = marked.parse('<textarea>plain text here</textarea>')
    expect(turndown.turndown(protectComments(html))).toBe('<textarea>plain text here</textarea>')
  })
})

describe('defaultReplacement preserves unrecognised block HTML (PITFALLS.md #1 rec. 5)', () => {
  it('keeps an unrecognised block wrapper as outerHTML instead of stripping to text', () => {
    const html = '<div class="note"><p>x</p></div>\n<p>after</p>'
    const back = turndown.turndown(html)
    expect(back).toContain('<div class="note">')
    expect(back).toContain('after')
  })
})

describe('marked breaks:false (deliberate parity break)', () => {
  it('does not convert a soft-wrapped newline into a <br>', () => {
    const html = marked.parse('line one\nline two')
    expect(html).not.toContain('<br>')
  })
})
