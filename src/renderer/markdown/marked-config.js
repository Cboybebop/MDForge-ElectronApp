// marked configuration — ported from index.html:656-661.
//
// Import swap is the entire point of this module: the cdnjs <script> tag at
// index.html:20 (marked 9.1.6 as a global) is replaced by an npm ESM import
// (marked 18.0.9, pinned in package.json).
//
// One authorized deviation from strict parity (02-CONTEXT.md "Round-Trip
// Architecture & Conversion Config" decision, amended 2026-08-18):
//   1. breaks is now set to false, changed from Phase 1's original setting
//      of true (index.html:660). Turning every newline into <br> means
//      Turndown converts <br> back to two-space-plus-newline -- silently
//      rewriting every soft-wrapped paragraph on every round trip
//      (PITFALLS.md #4/#9) and colliding with editors/linters that strip
//      trailing whitespace. Round-trip stability and the old hard-break
//      behaviour are mutually exclusive; this is a deliberate, user-visible
//      break from Phase 1's strict-parity port -- soft-wrapped lines stop
//      rendering as hard line breaks.

import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: false,
});

export { marked };
