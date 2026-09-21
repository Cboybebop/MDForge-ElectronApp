// Single-subtree Turndown primitive — targeted-conversion sibling of
// back-convert.js's whole-document `turndown.turndown(getCleanPreviewHTML())`
// call (index.html:712-726 lineage). Phase 3 will use this to convert just
// the block(s) a caret edit touched, instead of re-serialising the entire
// preview on every keystroke; Phase 2 proves the primitive in isolation,
// with no pane/caret wiring (02-CONTEXT.md's "Electron-free primitives"
// scoping).
//
// Import discipline: exactly ONE TurndownService instance exists app-wide —
// the singleton configured in turndown-config.js (GFM plugin, emDelimiter,
// keep(), defaultReplacement, narrowed escape(), hr, the tableCell/
// taskListItems whitespace-trim overrides, commentPlaceholder). render.js
// and back-convert.js both already follow this rule for their respective
// marked/turndown singletons — turndownBlock() must not construct a second
// TurndownService, or it would silently miss every one of those rules (e.g.
// <u> would be deleted instead of kept).
//
// Comment-safety: per comment-preserve.js's call-site contract, HTML
// comments must be routed through protectComments() before Turndown ever
// sees the string, since Turndown's process() walker never dispatches
// Comment nodes (nodeType 8) to any rule.

import { turndown } from './turndown-config.js';
import { protectComments } from './comment-preserve.js';

export function turndownBlock(node) {
  return turndown.turndown(protectComments(node.outerHTML));
}
