// renderWithSourceMap(md) -- the offset half of the block-splice model
// 02-CONTEXT.md's Round-Trip Architecture decision requires. Pairs with
// splice.js's spliceByRange() (the replace half) to satisfy CONV-05:
// "regions of a document the user did not edit are byte-identical after a
// round trip."
//
// Imports the configured singleton from marked-config.js rather than
// importing the bare npm package directly -- marked-config.js's module-level
// marked.setOptions({ gfm: true, breaks: false }) call must have already run
// so marked.lexer()/marked.parser() below use the same options render.js's
// display path uses. Bypassing marked-config.js risks this module silently
// diverging if some future import order lets it run first.
import { marked } from './marked-config.js';

// Decision (02-02-PLAN.md Task 2, resolving 02-RESEARCH.md Open Question 3):
// represent every top-level block's source range in a side table, uniformly
// across ALL token types -- not per-type attribute-wrapping via a custom
// renderer. table/list tokens render multi-tag output that doesn't compose
// cleanly with naive single-tag attribute wrapping (02-RESEARCH.md Pattern 1's
// own caveat); a side table sidesteps that composition problem entirely, and
// means html itself needs no custom renderer methods at all -- marked's own
// default renderer, unmodified, produces it via marked.parser(tokens).
//
// renderWithSourceMap(md) returns { html, blocks } where blocks is an
// ordered array of { index, type, srcStart, srcEnd }, one entry per
// marked.lexer() top-level token (this includes marked's own `space` tokens
// between blocks, not just the "visible" block types -- that's what makes
// the offsets contiguous and the sum-to-md.length invariant exact).
export function renderWithSourceMap(md) {
  const tokens = marked.lexer(md);

  const blocks = [];
  let offset = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // Verified (02-RESEARCH.md Pattern 1, reproduced against the installed
    // marked 18.0.9): every top-level token's .raw is an exact substring of
    // the source starting at the running offset, and
    // sum(tokens[i].raw.length) === md.length exactly -- true even across
    // marked v18's changed table/blank-line boundary capture, because those
    // changes moved characters into the *adjacent* token's .raw rather than
    // dropping them from the accounting.
    //
    // Do NOT attempt to derive finer-than-top-level (e.g. list-item-level)
    // offsets by summing item.raw.length across a list token's .items --
    // verified to under-count by exactly one character on a loose list's
    // last item, because that item's own .raw is missing a trailing newline
    // the parent list token's .raw correctly includes. Block/top-level
    // granularity only -- it's what the splice model actually needs.
    const srcStart = offset;
    const srcEnd = offset + token.raw.length;
    blocks.push({ index, type: token.type, srcStart, srcEnd });
    offset = srcEnd;
  }

  // marked.parser(tokens) on the SAME token array marked.lexer() produced is
  // verified byte-identical to marked.parse(md) directly -- no custom
  // renderer needed, since offsets live in the side table above, not in the
  // HTML.
  const html = marked.parser(tokens);

  return { html, blocks };
}
