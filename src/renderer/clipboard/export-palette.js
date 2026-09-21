// New Surface 4 — Export/Clipboard Palette Contract (01-UI-SPEC.md).
// Hard-coded. Never import tokens.css or read CSS custom properties here.
//
// This module is physically separate from src/renderer/styles/tokens.css and
// from any file that imports CSS custom properties, so a future theme edit
// can never silently leak dark styling into a Confluence/Word paste — a
// dark-mode user's clipboard/export output must always look like the light
// theme. Values equal the light theme hex constants from 01-UI-SPEC.md's
// Color section, authored verbatim here.
//
// TODO(phase-4): wire copy.js / word.js / confluence.js to import EXPORT_PALETTE
// (EXPT-01/EXPT-02). Until then this module has no consumers by design.
//
// Flagged as apparent dead code by 01-REVIEW.md IN-02 and deliberately KEPT.
// Creating this separation in Phase 1 is a locked decision — 01-CONTEXT.md and
// 01-UI-SPEC.md New Surface 4 require the export palette to be physically
// distinct from tokens.css, and 01-PATTERNS.md explicitly instructs not to skip
// creating it. Deleting the file to satisfy a dead-code check would reintroduce
// exactly the coupling those decisions exist to prevent. The marker above is
// greppable so its status is unambiguous rather than something a future reader
// has to infer from prose.

export const EXPORT_PALETTE = {
  bg: '#faf8f5',
  surface: '#ffffff',
  border: '#ddd6cc',
  accent: '#96600c',
  accentDim: '#7a4d0a',
  onAccent: '#fff8f0',
  text: '#4a4438',
  textDim: '#6b6459',
  textBright: '#1f1b15',
  textEm: '#55503f',
  textQuote: '#6b6456',
};
