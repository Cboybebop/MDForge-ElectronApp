// EDIT-13 (17-04-PLAN.md Task 1): dedicated, canary-proven coverage for
// @codemirror/lang-markdown's Enter-continuation/Backspace-degradation
// StateCommands against PRODUCTION's real extension wiring
// (createEditorState() -- cm-view.js's sharedExtensions(), post-17-02),
// not a hand-rolled duplicate extension list that could silently drift
// from what ships. No jsdom needed -- these commands operate on a plain
// { state, dispatch } target, no real EditorView/DOM required (17-04-PLAN.md
// source_findings).
//
// Deviation from the plan's literal action text (documented in
// 17-04-SUMMARY.md): the plan's own <source_findings> mischaracterized
// `insertNewlineContinueMarkupCommand` as itself being a StateCommand
// (`(target) => boolean`). Confirmed directly against
// node_modules/@codemirror/lang-markdown/dist/index.d.ts (line 22) and its
// compiled index.js (line 296): `insertNewlineContinueMarkupCommand` is a
// CONFIG FACTORY, `(config?) => StateCommand` -- calling it with a
// `{ state, dispatch }` object (as the plan's action text literally
// describes) would pass that object as `config` and return an unused,
// freshly-configured command function, never actually invoking anything.
// `markdownKeymap` itself binds Enter to `insertNewlineContinueMarkup`, the
// module's own already-instantiated default-config command
// (`insertNewlineContinueMarkupCommand()`, called with no arguments,
// index.js line 296) -- so this file imports and exercises
// `insertNewlineContinueMarkup` directly, the exact function a real Enter
// keypress dispatches through (see markdown-editing-behavior.spec.js Task
// 2 for the real-keypress proof), not the factory.
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { createEditorState } from './cm-view.js'

/**
 * Builds a production EditorState (createEditorState() -- the real
 * sharedExtensions() config) for `content`, with the cursor placed at
 * `pos`.
 */
function stateWithCursor (content, pos) {
  const initial = createEditorState(content)
  return initial.update({ selection: EditorSelection.cursor(pos) }).state
}

/**
 * Invokes a StateCommand against `state` via a minimal { state, dispatch }
 * target, mirroring exactly how @codemirror/view's keymap facet invokes a
 * bound command. Returns both the command's own boolean return value
 * (`applied`) and the resulting state (unchanged from the input if the
 * command never dispatched).
 */
function runCommand (command, state) {
  let result = state
  const applied = command({ state, dispatch: (tr) => { result = tr.state } })
  return { applied, state: result }
}

describe('EDIT-13: Enter-continuation and Backspace-degradation, against production wiring', () => {
  describe('Enter-continuation (insertNewlineContinueMarkup)', () => {
    it('at the end of a bullet list item, continues the list with a new "- " marker', () => {
      const state = stateWithCursor('- item', 6) // cursor immediately after 'item'
      const { applied, state: next } = runCommand(insertNewlineContinueMarkup, state)

      expect(applied).toBe(true)
      expect(next.doc.toString()).toBe('- item\n- ')
    })

    it('at the end of an ordered list item, continues the list with the INCREMENTED "2. " marker', () => {
      const state = stateWithCursor('1. item', 7) // cursor immediately after 'item'
      const { applied, state: next } = runCommand(insertNewlineContinueMarkup, state)

      expect(applied).toBe(true)
      expect(next.doc.toString()).toBe('1. item\n2. ')
    })

    it('at the end of a blockquote line, continues the quote with a new "> " marker', () => {
      const state = stateWithCursor('> quote', 7) // cursor immediately after 'quote'
      const { applied, state: next } = runCommand(insertNewlineContinueMarkup, state)

      expect(applied).toBe(true)
      expect(next.doc.toString()).toBe('> quote\n> ')
    })

    it('on an EMPTY bullet-list line, removes the empty marker (exits the list) instead of duplicating it onto a new line', () => {
      const state = stateWithCursor('- ', 2) // cursor right after the marker, no item text
      const { applied, state: next } = runCommand(insertNewlineContinueMarkup, state)

      expect(applied).toBe(true)
      // The sole (now-empty) list item's own markup is deleted outright --
      // exiting the list rather than inserting a second empty "- " line.
      expect(next.doc.toString()).toBe('')
    })
  })

  describe('Backspace-degradation (deleteMarkupBackward)', () => {
    it('immediately after a bullet-list marker, degrades (removes) the marker in one step -- does not delete the line', () => {
      const state = stateWithCursor('- item', 2) // cursor right after "- "
      const { applied, state: next } = runCommand(deleteMarkupBackward, state)

      expect(applied).toBe(true)
      // Pinned from the real observed result of this run, not assumed in
      // advance: for a single (non-multi-item) top-level list, the "- "
      // marker is deleted outright (the library's "delete one level of
      // indentation" branch, not its documented "replaced by spaces"
      // branch -- that branch is reserved for a different structural case,
      // e.g. an OrderedList/nested-item alignment scenario this fixture
      // does not hit), leaving "item" -- the line survives intact, neither
      // merged with an adjacent line nor deleted outright.
      expect(next.doc.toString()).toBe('item')
    })

    it('Backspace at document position 0 of a NON-EMPTY document is a safe no-op -- never throws, leaves doc.length unchanged', () => {
      const state = stateWithCursor('- item', 0)

      expect(() => runCommand(deleteMarkupBackward, state)).not.toThrow()
      const { applied, state: next } = runCommand(deleteMarkupBackward, state)
      expect(applied).toBe(false)
      expect(next.doc.length).toBe(6)
    })

    it('Backspace at document position 0 of an EMPTY document is a safe no-op -- never throws', () => {
      const state = stateWithCursor('', 0)

      expect(() => runCommand(deleteMarkupBackward, state)).not.toThrow()
      const { applied, state: next } = runCommand(deleteMarkupBackward, state)
      expect(applied).toBe(false)
      expect(next.doc.length).toBe(0)
    })

    it('immediately after a list marker NESTED inside a blockquote, degrades ONE level (the list marker), not the whole nested structure', () => {
      // "> - item": Blockquote > ListItem. Cursor right after "> - " (index 4).
      const state = stateWithCursor('> - item', 4)
      const { applied, state: next } = runCommand(deleteMarkupBackward, state)

      expect(applied).toBe(true)
      // Pinned from the real observed result of this run, not assumed in
      // advance: only the innermost (list) markup degrades -- the "- "
      // list marker is removed while the blockquote's own "> " marker is
      // left completely untouched, and the line is neither deleted nor
      // merged with any other line. Proves "degrades ONE level" for a
      // nested structure, not the whole thing at once.
      expect(next.doc.toString()).toBe('> item')
    })

    // Real finding (recorded, not silently assumed away): the plan's own
    // action text assumed deleteMarkupBackward degrades a HEADING mark
    // ("# ") the same way it degrades list/blockquote markup. Verified
    // directly against @codemirror/lang-markdown's real source
    // (contextNodeForDelete/getContext, index.js lines ~94-145 and
    // ~319-317): both helpers only ever recognise `ListItem` and
    // `Blockquote` node names when walking up the parse tree -- a heading
    // line produces an EMPTY context array, so deleteMarkupBackward's own
    // `if (context.length)` guard is never entered and the command falls
    // through to its own final `return dont = { range }` -- it returns
    // `false` for a heading in EVERY case, by design (its own JSDoc says
    // "cursor directly after list OR BLOCKQUOTE markup" -- headings are
    // never mentioned). This is not a bug to fix: with no other Backspace
    // binding installed in this app (no defaultKeymap/standardKeymap is
    // wired anywhere in cm-view.js -- confirmed via grep), a real Backspace
    // keypress here falls through markdownKeymap's Prec.high binding to
    // CM6's own native single-character-backward deletion, a safe, ordinary
    // edit -- never a whole-line delete and never document corruption.
    it('immediately after a heading mark ("# "), the command does NOT apply (headings are out of this library command\'s scope -- pinned to the real, verified behaviour, not the plan\'s original assumption)', () => {
      const state = stateWithCursor('# Heading', 2) // cursor right after "# "
      const { applied, state: next } = runCommand(deleteMarkupBackward, state)

      expect(applied).toBe(false)
      // No transaction was dispatched -- the document is untouched. This
      // is what "not deleted outright" means for a construct this command
      // does not claim to support; a real keypress instead reaches CM6's
      // own native character-backward deletion (unreachable from this
      // direct-invocation unit test -- see markdown-editing-behavior.spec.js).
      expect(next.doc.toString()).toBe('# Heading')
    })
  })

  describe('Canary: proves this suite has teeth (fails against a bare EditorState with no markdown extension)', () => {
    it('insertNewlineContinueMarkup returns false and produces no list continuation against a bare, extension-less EditorState', () => {
      const bare = EditorState.create({ doc: '- item', extensions: [] })
        .update({ selection: EditorSelection.cursor(6) }).state
      const { applied, state: next } = runCommand(insertNewlineContinueMarkup, bare)

      // No markdown language is active in this bare state, so the command's
      // own `markdownLanguage.isActiveAt(...)` guard fails immediately and
      // it declines to apply -- proving Task 1's other passing assertions
      // above are genuinely exercising the real markdown wiring, not
      // passing unconditionally regardless of configuration.
      expect(applied).toBe(false)
      expect(next.doc.toString()).toBe('- item')
      expect(next.doc.toString()).not.toContain('\n- ')
    })
  })
})
