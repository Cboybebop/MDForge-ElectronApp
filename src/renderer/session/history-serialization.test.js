// @vitest-environment jsdom
//
// 15-01-PLAN.md Task 2 (TDD). Tests a REAL EditorState/EditorView round trip
// (mirroring cm-dispatch.test.js's own mountCapturingView pattern) so the
// happy-path assertion proves genuine, applicable undo depth -- not merely
// "did not throw". Each of the four failure modes named in 15-CONTEXT.md
// ("truncated JSON, valid JSON of the wrong shape, a history referencing
// positions past the end of the document, and a version mismatch") is its
// own named test, using the exact fixture recipes verified against installed
// source in this plan's own <source_findings> -- not a single generic
// "corrupt input" case.
import { describe, it, expect, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { isolateHistory, undo, undoDepth } from '@codemirror/commands'
import { createEditorState } from '../markdown/cm-view.js'
import {
  serializeHistoryForTab,
  restoreHistoryState,
  MAX_HISTORY_JSON_BYTES
} from './history-serialization.js'

// Mirrors cm-dispatch.test.js's own mountCapturingView() helper -- builds a
// real, dispatchable EditorView wrapping a real EditorState built via this
// app's own createEditorState() (so history()/historyKeymap are present,
// exactly like a genuine per-tab document).
function mountRealView (initialContent = '') {
  const state = createEditorState(initialContent, [])
  const view = new EditorView({ state, parent: document.createElement('div') })
  return view
}

describe('history-serialization.js', () => {
  describe('serializeHistoryForTab', () => {
    it('returns null for a null/undefined state, never throws', () => {
      expect(serializeHistoryForTab(null)).toBeNull()
      expect(serializeHistoryForTab(undefined)).toBeNull()
    })

    it('returns a JSON string containing doc, selection, and history keys for a real state', () => {
      const view = mountRealView('hello')
      view.dispatch({ changes: { from: 5, to: 5, insert: ' world' } })

      const json = serializeHistoryForTab(view.state)

      expect(typeof json).toBe('string')
      const parsed = JSON.parse(json)
      expect(parsed).toHaveProperty('doc')
      expect(parsed).toHaveProperty('selection')
      expect(parsed).toHaveProperty('history')

      view.destroy()
    })

    it('drops an oversized serialized history: returns null and calls console.warn naming the byte length and the cap', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const view = mountRealView('')
      // A single huge insert makes the serialized `doc` (and thus the whole
      // JSON string) exceed MAX_HISTORY_JSON_BYTES on its own.
      const hugeInsert = 'x'.repeat(MAX_HISTORY_JSON_BYTES + 1000)
      view.dispatch({ changes: { from: 0, to: 0, insert: hugeInsert } })

      const result = serializeHistoryForTab(view.state)

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [message] = warnSpy.mock.calls[0]
      expect(message).toEqual(expect.stringContaining(String(MAX_HISTORY_JSON_BYTES)))

      view.destroy()
      warnSpy.mockRestore()
    })
  })

  describe('restoreHistoryState -- happy path', () => {
    it('a real round trip proves genuine, applicable undo depth: undoDepth > 0 and undo() actually reverts the last change', () => {
      const view = mountRealView('start')
      view.dispatch({ changes: { from: 5, to: 5, insert: ' middle' } })
      // isolateHistory('full') forces a NEW undo group boundary on both
      // sides of this transaction -- without it, two synchronous dispatches
      // in a test (no real wall-clock gap between them) fall inside CM6's
      // own newGroupDelay (500ms) and get grouped into ONE undo event,
      // which would make undo() revert BOTH edits at once rather than just
      // the last one. A real user typing two separate edits gets this
      // separation for free from actual elapsed time; this annotation
      // reproduces that same real-world separation deterministically.
      view.dispatch({ changes: { from: 12, to: 12, insert: ' end' }, annotations: [isolateHistory.of('full')] })
      const preLastEditContent = 'start middle' // content after edit 1, before edit 2
      const finalContent = view.state.doc.toString()
      expect(finalContent).toBe('start middle end')

      const json = serializeHistoryForTab(view.state)
      expect(json).not.toBeNull()

      const restored = restoreHistoryState(json, finalContent, [])

      expect(restored).not.toBeNull()
      expect(undoDepth(restored)).toBeGreaterThan(0)

      let result = null
      undo({ state: restored, dispatch: (tr) => { result = tr.state } })
      expect(result).not.toBeNull()
      expect(result.doc.toString()).toBe(preLastEditContent)

      view.destroy()
    })
  })

  describe('restoreHistoryState -- failure modes (each independently degrades to null, never throws)', () => {
    it('typeof historyJson !== "string" (no history was ever saved) returns null with no console.warn -- not a failure', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(restoreHistoryState(null, 'anything', [])).toBeNull()
      expect(restoreHistoryState(undefined, 'anything', [])).toBeNull()
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    it('failure mode 1 -- truncated JSON: a real serialized history string sliced partway through fails JSON.parse and returns null', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const view = mountRealView('hello')
      view.dispatch({ changes: { from: 5, to: 5, insert: ' world' } })
      const json = serializeHistoryForTab(view.state)
      const truncated = json.slice(0, Math.floor(json.length / 2))

      const result = restoreHistoryState(truncated, view.state.doc.toString(), [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()

      view.destroy()
      warnSpy.mockRestore()
    })

    it('failure mode 2 -- wrong-shape JSON: valid JSON, wrong types (doc is not a string) returns null', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wrongShape = JSON.stringify({ doc: 42, selection: null })

      const result = restoreHistoryState(wrongShape, 'hi', [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('failure mode 2b -- wrong-shape JSON: doc is a string but history is not an object, returns null', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wrongShape = JSON.stringify({ doc: 'hi', history: 'nope' })

      const result = restoreHistoryState(wrongShape, 'hi', [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('failure mode 3 -- position past the end of the document: CM6\'s own fromJSON accepts this shape without throwing (checkSelection only validates the top-level selection); this module\'s OWN explicit post-fromJSON bounds check must catch it', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Verified-shape fixture from 15-01-PLAN.md's own <source_findings>:
      // doc is 'hi' (length 2), but the buried startSelection claims
      // position 500 -- CM6's fromJSON/checkSelection do not validate this.
      const pastEndJson = JSON.stringify({
        doc: 'hi',
        selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
        history: {
          done: [{ startSelection: { ranges: [{ anchor: 500, head: 500 }], main: 0 }, selectionsAfter: [] }],
          undone: []
        }
      })

      const result = restoreHistoryState(pastEndJson, 'hi', [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('failure mode 4 -- version-mismatch-shaped history: a done entry missing selectionsAfter throws TypeError inside HistEvent.fromJSON, caught and returned as null', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Verified-shape fixture: missing selectionsAfter entirely on a done
      // entry -- @codemirror/commands@6.10.4's HistEvent.fromJSON
      // unconditionally calls json.selectionsAfter.map(...), throwing
      // TypeError. This is the source-grounded stand-in for a future/older
      // @codemirror/commands version restructuring this field in a way this
      // installed version cannot read.
      const versionMismatchJson = JSON.stringify({
        doc: 'hi',
        selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
        history: {
          done: [{ startSelection: { ranges: [{ anchor: 0, head: 0 }], main: 0 } }],
          undone: []
        }
      })

      const result = restoreHistoryState(versionMismatchJson, 'hi', [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('restoreHistoryState -- doc-match guard', () => {
    it('a valid, well-formed serialized history whose doc differs from currentContent returns null (never applies history against the wrong document)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const view = mountRealView('original content')
      view.dispatch({ changes: { from: 0, to: 0, insert: 'edit ' } })
      const json = serializeHistoryForTab(view.state)

      // currentContent deliberately does NOT match the serialized doc.
      const result = restoreHistoryState(json, 'a completely different document', [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()

      view.destroy()
      warnSpy.mockRestore()
    })
  })

  describe('restoreHistoryState -- oversized on-disk string (defense in depth)', () => {
    it('rejects a historyJson string longer than MAX_HISTORY_JSON_BYTES * 2 before ever calling JSON.parse on it', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const oversized = 'x'.repeat(MAX_HISTORY_JSON_BYTES * 2 + 1)

      const result = restoreHistoryState(oversized, 'anything', [])

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})
