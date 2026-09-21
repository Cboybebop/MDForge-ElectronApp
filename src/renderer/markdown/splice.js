// Pure string surgery over a Markdown source string, keyed by source-offset
// range. This is the "replace" half of the block-splice model 02-CONTEXT.md's
// Round-Trip Architecture decision requires -- source-map.js's
// renderWithSourceMap() supplies the [srcStart, srcEnd) ranges this consumes.
//
// No module-level state, no DOM -- see split.js's clamp-logic terseness for
// the density this file matches: the whole point is that there is nothing
// here to get wrong.

// Replaces the [start, end) range of `md` with `replacement`. start === end
// is a pure insertion at that offset, with nothing deleted.
export function spliceByRange(md, start, end, replacement) {
  return md.slice(0, start) + replacement + md.slice(end);
}
