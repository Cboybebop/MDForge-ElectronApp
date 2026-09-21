// HTML comment preservation via string-level placeholder substitution.
//
// READ BUT DO NOT MODIFY THE CALL-SITE CONTRACT without updating every
// caller: Turndown's internal process() walker (turndown.cjs.js) only
// dispatches nodeType 1 (Element) and nodeType 3 (Text) to any rule; a
// Comment node (nodeType 8) always contributes an empty string, before any
// addRule/filter is even consulted. A turndown.addRule() filtering on
// node.nodeType === 8 is therefore dead code -- verified directly against
// turndown@7.2.4 (02-RESEARCH.md "Major correction 3").
//
// The working mechanism: convert every <!-- ... --> to a placeholder
// ELEMENT before Turndown ever parses the HTML string, carrying the comment
// payload as base64-encoded TEXT CONTENT. The payload MUST be text content,
// never an attribute -- Turndown's Rules.forNode() checks node.isBlank
// (empty/whitespace-only textContent) BEFORE consulting any custom rule,
// and short-circuits straight to blankRule regardless of what attributes
// are present. An attribute-only payload was verified to be silently
// dropped; the same payload as text content round-trips correctly.
//
// Call-site contract (mirrors back-convert.js's "READ BUT DO NOT MODIFY
// BEHAVIOR" documentation density): every caller MUST invoke
// `turndown.turndown(protectComments(html))`, never
// `turndown.turndown(html)` directly, whenever the HTML may contain
// comments. The paired `commentPlaceholder` addRule registered in
// turndown-config.js is a no-op without this pre-processing pass having
// run first -- it can only decode a placeholder that already exists in the
// HTML string it receives. That rule MUST decode via
// `decodeCommentPlaceholder()` below, never via a raw `Buffer.from(content,
// 'base64')` call of its own -- see the WR-03 marker note below for why.

// WR-03: a per-module-load random marker, folded into the base64 payload
// (never into the placeholder tag name -- changing the tag name would ripple
// into turndown-config.js's filter/registration for no extra safety), so a
// literal <mdforge-comment> element already present in the user's OWN
// document (a custom element, or a technical writeup/test-fixture discussing
// this very mechanism) is never mistaken for a placeholder produced by THIS
// call to protectComments() and blindly base64-decoded.
// Buffer.from(str, 'base64') is lenient and does not throw on invalid input
// in Node, so without this check the failure mode is silent, garbled output
// -- not a crash. Regenerated every time this module is loaded (i.e. once
// per app session); the marker never needs to leave this module -- callers
// only ever go through protectComments()/decodeCommentPlaceholder().
const MARKER = Array.from(
  globalThis.crypto.getRandomValues(new Uint8Array(8)),
  (b) => b.toString(16).padStart(2, '0')
).join('');

export function protectComments(html) {
  const converted = html.replace(/<!--([\s\S]*?)-->/g, (_, inner) => {
    const payload = MARKER + Buffer.from(inner, 'utf8').toString('base64');
    return `<mdforge-comment>${payload}</mdforge-comment>`;
  });
  // Any '<!--' left over after the paired substitution above has no matching
  // '-->' anywhere later in the string -- an unterminated comment. HTML5's
  // own comment-parsing rule (and Turndown's underlying DOM parser) treats
  // an unterminated comment as consuming everything to end-of-document, and
  // because Turndown's process() never dispatches Comment nodes to any rule,
  // that would silently discard the rest of the document (CR-01). Neutralise
  // the stray opener by escaping it so no downstream HTML parser treats it
  // as a real comment start; the user's document is preserved as literal
  // text instead of being truncated.
  return converted.replace(/<!--/g, '&lt;!--');
}

// Inverse of the payload half of protectComments(). Validates the
// per-session marker before trusting the remainder as base64 -- a literal
// <mdforge-comment> element in the user's own source (not produced by this
// module in this session) fails the marker check and is reported as
// isPlaceholder: false, so the caller (turndown-config.js's
// commentPlaceholder rule) can fall through to preserving the element's own
// text content verbatim instead of mangling it via a blind base64 decode.
export function decodeCommentPlaceholder(content) {
  if (!content.startsWith(MARKER)) {
    return { isPlaceholder: false, text: content };
  }
  const payload = content.slice(MARKER.length);
  return { isPlaceholder: true, text: Buffer.from(payload, 'base64').toString('utf8') };
}
