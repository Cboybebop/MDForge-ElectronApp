// YAML front matter — stripped/reattached out-of-band, per 02-CONTEXT.md's
// "Round-Trip Architecture & Conversion Config" decision: front matter never
// enters the marked/Turndown pipeline (PITFALLS.md #6). This is what CONV-03
// requires exactly, rather than approximately.
//
// No module-level state. Unlike sync-controller.js's origin-tag/revision or
// split.js's leftWidthPercent (a getter/setter pair over ONE shared value,
// per PATTERNS.md Shared Pattern 2/5), there is no single global document in
// this Electron-free core -- the caller (Phase 3's pane wiring) owns the
// document and must pass the stripped frontMatter value back in explicitly.
// Holding it as a bare `let frontMatter` here would violate the "no bare
// mutable export" convention those two files establish, and would be wrong
// even as a getter/setter: multiple documents (tabs) cannot share one slot.

// Requires the line immediately after the opening `---` to be non-blank --
// real YAML front matter content begins on the very next line, whereas a
// document that legitimately opens with a thematic break, a paragraph, and
// a second thematic break (---\n\nSome paragraph\n\n---\n...) always has a
// blank line right after the first `---`. Without this check the two
// shapes are indistinguishable and the paragraph between them is silently
// stripped out-of-band, never reaching marked.parse() -- CR-02-REVIEW.md
// CR-03. This is a heuristic, not a formal YAML-shape check, but it is
// strictly better than the previous unconditional match and every existing
// fixture (all of which have real YAML content on the line right after the
// opening delimiter) still matches unchanged.
const FRONT_MATTER_RE = /^---\r?\n(?!\r?\n)[\s\S]*?\r?\n---\r?\n?/;

// Splits a leading `---`-delimited YAML block off of `markdown`. Returns the
// exact matched delimiter-inclusive text (so reattachFrontMatter can just
// concatenate) and the remainder. No match -> frontMatter is '' and body is
// the whole input, unchanged.
export function stripFrontMatter(markdown) {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) {
    return { frontMatter: '', body: markdown };
  }
  return { frontMatter: match[0], body: markdown.slice(match[0].length) };
}

// Inverse of stripFrontMatter: plain concatenation. Reassembling the exact
// two values stripFrontMatter returned is always byte-identical to the
// original input, by construction.
export function reattachFrontMatter(frontMatter, body) {
  return frontMatter + body;
}
