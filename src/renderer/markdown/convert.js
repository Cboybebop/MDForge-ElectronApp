// convert.js -- the top-level compose entry points for the conversion core.
//
// This is the seam the round-trip corpus (tests/fixtures/corpus/) exercises
// directly. It adds NO new conversion logic of its own: it wires together
// the four independently-verified primitives from 02-01-PLAN.md/02-02-PLAN.md
// (marked-config.js, turndown-config.js, comment-preserve.js, front-matter.js)
// into the two functions Phase 3's pane wiring, and this phase's corpus, both
// depend on.
//
// Locked contract -- do not let this drift, the corpus depends on this exact
// shape (02-04-PLAN.md Task 1):
//   markdownToHtml(markdown) -> { html, frontMatter }
//   htmlToMarkdown(html, frontMatter) -> string

import { marked } from './marked-config.js';
import { turndown } from './turndown-config.js';
import { protectComments } from './comment-preserve.js';
import { stripFrontMatter, reattachFrontMatter } from './front-matter.js';

// Markdown -> HTML. Front matter is stripped out-of-band BEFORE marked ever
// sees the body (PITFALLS.md #6 / CONV-03) -- it never enters the
// marked/Turndown pipeline. The caller must hold onto the returned
// frontMatter value and pass it back into htmlToMarkdown() on serialise;
// this module holds no state of its own (see front-matter.js's header).
export function markdownToHtml(markdown) {
  const { frontMatter, body } = stripFrontMatter(markdown);
  const html = marked.parse(body);
  return { html, frontMatter };
}

// HTML -> Markdown. protectComments() MUST run before turndown.turndown()
// whenever the HTML may contain comments (comment-preserve.js's call-site
// contract) -- Turndown's process() structurally never dispatches Comment
// nodes to any rule, so skipping this step silently drops comments. The
// front matter held aside by markdownToHtml() is reattached last, verbatim.
export function htmlToMarkdown(html, frontMatter) {
  const body = turndown.turndown(protectComments(html));
  return reattachFrontMatter(frontMatter, body);
}
