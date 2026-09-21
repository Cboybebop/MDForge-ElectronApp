// Theme <select> wiring (EDIT-02) — new module, no index.html analog.
//
// Consumes the preload contextBridge surface built in 01-02-PLAN.md
// (src/preload/index.js): window.mdforge.getTheme() / .setTheme() /
// .onSystemThemeChanged(). See 01-UI-SPEC.md "New Surface 1 — Theme Token
// Contract & Mechanism" and "New Surface 2 — Theme Control Spec".
//
// Mechanism: `document.documentElement.dataset.theme = 'light' | 'dark'`
// for an explicit choice; deleting the attribute for 'system' lets
// tokens.css's bare :root + @media(prefers-color-scheme) blocks resolve.
// This is a plain HTML attribute write, not `style=""` — CSP-safe under
// the locked `style-src 'self'` policy with no `unsafe-inline`.
//
// [17-03] The rest of the app's chrome (panes.css/preview.css) repaints
// purely from the CSS cascade with zero JS involvement, since every rule
// there is `var(--token)`-driven and `data-theme`/`prefers-color-scheme`
// changing is enough on its own. The raw-Markdown CM6 pane is the ONE
// exception: cm-highlight.js's mdHighlightStyle/mdEditorTheme rules are
// ALSO `var(--token)`-driven and would eventually repaint their pixels via
// the same cascade, but CM6 injects its highlight/theme rules into a
// StyleModule <style> tag through its own Compartment machinery, not a
// static stylesheet — a live, dispatched transaction
// (repaintEditorTheme(), from cm-highlight.js) is required on every theme
// change to give CM6 (and this codebase's own tests) a real, observable
// state transition to key off, rather than relying on incidental cascade
// timing. See 17-UI-SPEC.md "Theme Switching Mechanism".
import { repaintEditorTheme } from '../markdown/cm-highlight.js'
import { getSharedView } from '../markdown/cm-view.js'

const select = document.getElementById('theme-select');

// Preload already applied the persisted theme's `data-theme` attribute
// pre-paint (see src/preload/index.js). Sync the <select> to that same
// value so the control reflects reality on first render.
select.value = window.mdforge.getTheme();

select.addEventListener('change', () => {
  const value = select.value;

  // Mutate the DOM attribute synchronously in the renderer for instant
  // visual feedback, then persist via IPC. 'system' sets NO attribute at
  // all (locked mechanism) — falls through to tokens.css's
  // @media(prefers-color-scheme) fallback.
  if (value === 'light' || value === 'dark') {
    document.documentElement.dataset.theme = value;
  } else {
    delete document.documentElement.dataset.theme;
  }

  window.mdforge.setTheme(value);

  // [17-03] Fire the CM6-side repaint in the SAME handler that mutates the
  // data-theme attribute — same dispatch, no editor rebuild (Compartment
  // reconfigure preserves EditorState: undo history, selection, scroll).
  repaintEditorTheme(getSharedView());
});

// No DOM-attribute mutation is required when the OS theme changes while in
// 'system' mode — tokens.css's bare :root + @media(prefers-color-scheme)
// block already resolves correctly with no data-theme attribute present,
// and the rest of the app's chrome repaints from that cascade alone with no
// JS involvement. The CM6 raw pane is the exception (see header comment
// above): its highlight/theme rules live in a StyleModule Compartment, not
// a static stylesheet, so a live dispatch is still required here even
// though this handler sets no data-theme attribute itself.
window.mdforge.onSystemThemeChanged((_shouldUseDarkColors) => {
  repaintEditorTheme(getSharedView());
});
