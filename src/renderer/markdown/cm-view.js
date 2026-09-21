// The shared-view / per-tab-state factory this entire phase builds on top
// of. 12-CONTEXT.md Area 1: "One EditorView, many EditorStates" -- a single
// shared view with per-tab states swapped on tab change, each state
// carrying its own history() (this is what makes independent per-tab undo
// stacks real rather than approximated).
//
// [17-02] Phase 17 has now landed the Markdown language mode (with GFM +
// the custom front-matter grammar), token-driven syntax highlighting/theme
// (via a Compartment, live-repaintable on theme toggle -- see
// cm-highlight.js), and permanent production soft wrap -- all three were
// deliberately deferred past Phase 12's "a bare, correct editor first"
// (12-CONTEXT.md Area 1) so a corpus/sync regression there could only ever
// mean a sync bug, never a language-mode interaction. See sharedExtensions()
// below.
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyField, historyKeymap, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { mdHighlightStyle, mdEditorTheme, themeCompartment } from './cm-highlight.js'
import { frontMatterExtension } from './front-matter-lang.js'

// The nonce protocol.js (main process) injects into index.html's <head> at
// serve time, via a <meta name="cm6-csp-nonce" content="..."> tag -- see
// protocol.js's CM6_STYLE_NONCE comment and 12-01-PLAN.md Task 2. Read ONCE,
// at module scope, and cached: the value never changes for the life of one
// page load, and re-querying the DOM on every EditorState.create() call
// would be pointless work.
//
// In dev mode (electron-vite's own Vite dev server, which never goes
// through protocol.js's app:// handler) there is no meta tag at all -- its
// own DEV_CSP already permits 'unsafe-inline' for style-src, so CM6's
// injected <style> tag needs no nonce there. Same story for a jsdom test
// fixture with no meta tag seeded: cspNonceExtension() must never throw,
// it must just return no facet.
const cachedNonce = typeof document !== 'undefined'
  ? document.querySelector('meta[name="cm6-csp-nonce"]')?.content
  : undefined

function cspNonceExtension () {
  if (!cachedNonce) return []
  return [EditorView.cspNonce.of(cachedNonce)]
}

// [15-01] Single source of truth for the extension set both a fresh
// EditorState (createEditorState) and a rehydrated-from-JSON one
// (createEditorStateFromJSON) are built from -- extracted so the two can
// never drift apart (e.g. a future extension added to one and forgotten in
// the other, silently making a restored tab behave differently from a fresh
// one). Nothing here reads any outer state beyond the one module-scope,
// once-computed cache above (cachedNonce, via cspNonceExtension()), so
// calling this twice (once for a fresh state, once for a restored one) is
// always safe and side-effect-free.
function sharedExtensions (extraExtensions = []) {
  return [
    history(),
    // [Rule 2 - Missing Critical, discovered by 12-13-PLAN.md Task 3's own
    // empirical undo-grouping investigation] Without a real keymap binding
    // undo/redo, a real end-user pressing Ctrl+Z in the raw pane falls
    // through to the browser's own native contenteditable undo command --
    // the SAME mechanism this file's window.__cmUndo comment already
    // documents as corrupting CM6's document (typing "Hello CM6" then
    // triggering that native command left the document at "H", not a real
    // CM6 history entry). historyKeymap (Mod-z/undo, Mod-y & Mod-Shift-z/
    // redo, Mod-u/undoSelection, Alt-u/redoSelection -- @codemirror/
    // commands' own documented bindings) routes a real Ctrl+Z through
    // CM6's OWN history mechanism instead, the only correct way to make
    // undo/redo actually work for a real user, not just for this plan's
    // window.__cmUndo test seam. No existing accelerator in this codebase
    // claims Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z (confirmed by grep this session --
    // no Edit > Undo Menu entry exists, mirrored by
    // tabs-undo-independence.spec.js's own header comment), so this
    // introduces no conflict.
    keymap.of(historyKeymap),
    EditorView.contentAttributes.of({ spellcheck: 'true' }),
    ...cspNonceExtension(),
    // [17-02] Markdown language mode (base + GFM + the custom front-matter
    // grammar), permanent production soft wrap, and the token-driven
    // highlight-style/theme pairing -- see 17-UI-SPEC.md "Module
    // Organization" item 3. addKeymap: true (the default) is kept explicit
    // here deliberately -- it is what wires markdownKeymap's
    // insertNewlineContinueMarkupCommand/deleteMarkupBackward bindings for
    // EDIT-13 (17-04 depends on this exact wiring); do not pass a custom
    // `keymap` option here, it would shadow those bindings.
    markdown({ base: markdownLanguage, extensions: [GFM, frontMatterExtension], addKeymap: true, completeHTMLTags: false }),
    EditorView.lineWrapping,
    themeCompartment.of([syntaxHighlighting(mdHighlightStyle), mdEditorTheme]),
    ...extraExtensions
  ]
}

/**
 * Builds one per-tab EditorState. Each tab gets its OWN history() instance
 * (independent undo stack, DOC-09) -- history is state-level, not
 * view-level, and setState() carries it correctly across a tab switch
 * (12-RESEARCH.md section 5, confirmed directly against @codemirror/view
 * source).
 *
 * @param {string} [initialContent='']
 * @param {import('@codemirror/state').Extension[]} [extraExtensions=[]]
 */
export function createEditorState (initialContent = '', extraExtensions = []) {
  return EditorState.create({
    doc: initialContent,
    extensions: sharedExtensions(extraExtensions)
  })
}

/**
 * [15-01] Rehydrates a per-tab EditorState from a `state.toJSON({ history:
 * historyField })`-shaped object (see session/history-serialization.js's
 * serializeHistoryForTab), restoring its real, applicable undo history --
 * not merely its document text/selection.
 *
 * Built on the EXACT SAME `sharedExtensions()` array createEditorState()
 * uses, so a restored state has full feature parity (spellcheck attribute,
 * CSP nonce, sync extensions, historyKeymap) with a freshly-created one, not
 * a stripped-down substitute.
 *
 * Why passing BOTH `fields: { history: historyField }` AND the full
 * `history()` extension (folded into `sharedExtensions()`) in
 * `config.extensions` is safe, not a duplicate-field conflict (verified
 * directly against @codemirror/state@6.7.1's own source this session, see
 * 15-01-PLAN.md's own <source_findings>): `StateField.prototype.init()`
 * returns `[this, initField.of({ field: this, create })]`, so passing
 * `fields: { history: historyField }` to `fromJSON` already includes the raw
 * `historyField_` singleton in the resulting state's extensions.
 * `flatten()`'s own `seen` map dedupes by extension VALUE identity, so
 * ALSO including the full `history()` extension (which contains that same
 * `historyField_` singleton) in `config.extensions` is not a
 * duplicate-field error -- the custom `fields`-driven initializer wins via
 * `StateField.create()`'s own `state.facet(initField).find(i => i.field ==
 * this)` lookup, which prefers the custom `create` over the field's own
 * default `() => HistoryState.empty`. A future reader must not "fix" this
 * into two conflicting extension lists -- it is deliberately one list, used
 * twice, for two different purposes (feature parity AND correct history
 * rehydration).
 *
 * Deliberately NOT wrapped in try/catch here: `EditorState.fromJSON()`
 * genuinely throws synchronously on malformed input (shape/truncation/
 * version-mismatch -- confirmed against source), and this function's
 * contract stays "construct or throw," matching `EditorState.fromJSON`'s own
 * contract rather than inventing a second one. The CALLER
 * (history-serialization.js's restoreHistoryState) owns catching it.
 *
 * @param {object} json - a `state.toJSON({ history: historyField })` shape.
 * @param {import('@codemirror/state').Extension[]} [extraExtensions=[]]
 */
export function createEditorStateFromJSON (json, extraExtensions = []) {
  return EditorState.fromJSON(
    json,
    { extensions: sharedExtensions(extraExtensions) },
    { history: historyField }
  )
}

// The ONE shared EditorView every open document swaps its EditorState
// into/out of via setState() on tab change (12-RESEARCH.md section 5). No
// other file in this phase may construct a second EditorView -- documents.js
// (12-02-PLAN.md) calls mountSharedView() exactly once, at bootstrap.
let sharedView = null

/**
 * Constructs the single shared EditorView and mounts it into `parentEl`.
 *
 * Also assigns it to `window.__cmView` -- a narrow, deliberately test-only
 * global seam, mirroring spellcheck-spike.js's own `window.__spikeView`
 * convention and its T-9-03 accepted-risk disposition (09-01-PLAN.md threat
 * model: a narrow, named seam is preferred over a broader capability).
 *
 * @param {HTMLElement} parentEl
 * @param {import('@codemirror/state').EditorState} initialState
 * @returns {EditorView}
 */
export function mountSharedView (parentEl, initialState) {
  sharedView = new EditorView({ state: initialState, parent: parentEl })
  if (typeof window !== 'undefined') {
    window.__cmView = sharedView
    // Test-only seam (12-13-PLAN.md Task 1), same narrow-seam disposition as
    // window.__cmView above. Empirically confirmed this session:
    // document.execCommand('undo') against CM6's contenteditable content DOM
    // does NOT reach CM6's own history -- it invokes the browser's native
    // contenteditable undo command instead, which mutates the DOM directly
    // behind CM6's back. Measured: typing "Hello CM6" then calling
    // execCommand('undo') left the document at "H" (not "" and not any real
    // CM6 history entry), and a second execCommand('undo') call left it
    // unchanged at "H" -- corruption, not a walk through CM6's actual undo
    // stack. This finding is also what motivated adding historyKeymap to
    // createEditorState() above (a real end-user's Ctrl+Z would otherwise hit
    // this exact same corrupting native command) -- window.__cmUndo remains
    // useful as a direct, keyboard-focus-independent test seam even now that
    // a real keybinding exists.
    window.__cmUndo = () => undo(sharedView)
  }
  return sharedView
}

/**
 * Returns the shared EditorView, or null if mountSharedView() has not been
 * called yet.
 *
 * @returns {EditorView | null}
 */
export function getSharedView () {
  return sharedView
}
