// @vitest-environment jsdom
//
// Task 1 (12-01-PLAN.md): cm-dispatch.js's annotation + dispatchAppWrite
// helper. Test 1 below is the literal "does a real CM6 EditorState/
// EditorView construct and dispatch under this repo's exact jsdom install"
// proof 12-RESEARCH.md Assumption A3 and this phase's "Wave 0 Gaps" table
// both require before any other jsdom-based CM6 test in this phase is
// trusted -- it MUST run first in this file.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { appWriteOrigin, dispatchAppWrite, markRecentAppWrite, wasRecentAppWrite } from './cm-dispatch.js'
import { getActiveOrigin } from './sync-controller.js'

// Small local helper: builds a view whose updateListener captures every
// transaction from the most recent dispatch, so tests can read back the
// annotations actually attached -- the dispatched TransactionSpec object
// itself does not carry them (CM6 resolves annotations onto the Transaction).
function mountCapturingView (doc = 'hello') {
  let lastTransactions = []
  const state = EditorState.create({
    doc,
    extensions: [
      EditorView.updateListener.of((update) => {
        if (update.transactions.length > 0) lastTransactions = update.transactions
      })
    ]
  })
  const view = new EditorView({ state, parent: document.createElement('div') })
  return { view, getLastTransactions: () => lastTransactions }
}

describe('cm-dispatch.js', () => {
  it('Test 1: a bare EditorState/EditorView constructs and dispatches under jsdom (Assumption A3 smoke test)', () => {
    const state = EditorState.create({ doc: 'hello' })
    const view = new EditorView({ state, parent: document.createElement('div') })

    expect(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } })
    }).not.toThrow()
    expect(view.state.doc.toString()).toBe('xhello')

    view.destroy()
  })

  it('Test 2: dispatchAppWrite attaches appWriteOrigin, readable on the resulting transaction', () => {
    const { view, getLastTransactions } = mountCapturingView()

    dispatchAppWrite(view, { from: 0, to: 0, insert: 'x' }, 'user-right', 2001)

    const [tr] = getLastTransactions()
    expect(tr).toBeTruthy()
    expect(tr.annotation(appWriteOrigin)).toBe('user-right')

    view.destroy()
  })

  it('Test 3: a plain, un-annotated dispatch (a real user-shaped transaction) never carries appWriteOrigin', () => {
    const { view, getLastTransactions } = mountCapturingView()

    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } })

    const [tr] = getLastTransactions()
    expect(tr).toBeTruthy()
    expect(tr.annotation(appWriteOrigin)).toBeUndefined()

    view.destroy()
  })

  it('Test 4: dispatchAppWrite tags isolateHistory "before" by default, and accepts an explicit override', () => {
    const { view, getLastTransactions } = mountCapturingView()

    dispatchAppWrite(view, { from: 0, to: 0, insert: 'x' }, 'user-right', 2002)
    expect(getLastTransactions()[0].annotation(isolateHistory)).toBe('before')

    dispatchAppWrite(view, { from: 0, to: 0, insert: 'y' }, 'paste', 2002, 'full')
    expect(getLastTransactions()[0].annotation(isolateHistory)).toBe('full')

    view.destroy()
  })

  it('Test 5: dispatchAppWrite calls the real beginWrite/endWrite -- active during dispatch, null immediately after', () => {
    const docId = 2003
    let originDuringDispatch = 'not-observed'
    const state = EditorState.create({
      doc: 'hello',
      extensions: [
        EditorView.updateListener.of((update) => {
          if (update.docChanged) originDuringDispatch = getActiveOrigin(docId)
        })
      ]
    })
    const view = new EditorView({ state, parent: document.createElement('div') })

    expect(getActiveOrigin(docId)).toBeNull()

    dispatchAppWrite(view, { from: 0, to: 0, insert: 'x' }, 'toolbar', docId)

    expect(originDuringDispatch).toBe('toolbar')
    expect(getActiveOrigin(docId)).toBeNull()

    view.destroy()
  })

  // [17-02] The off-viewport anchor-preservation path (dispatchAppWrite's
  // own real fix for the codemirror/dev#1552 shape scroll-sync.spec.js's
  // e2e tests exercise and prove end-to-end in a real Chromium layout
  // engine -- jsdom has no requestAnimationFrame at all, confirmed this
  // session, so the compensation loop itself cannot be meaningfully
  // exercised here). This test proves the TRANSACTION-BUILDING branch
  // (view.state.update() + tr.changes.mapPos() + view.dispatch(tr)) taken
  // when the edit is strictly before a (stubbed) viewport still writes the
  // correct content and never throws, even though requestAnimationFrame is
  // undefined under jsdom (the function's own typeof guard makes that a
  // safe, silent no-op rather than a crash).
  it('Test 7: dispatchAppWrite still writes correctly, and never throws, when the edit is strictly before the (stubbed) viewport', () => {
    const longDoc = 'x'.repeat(200)
    const { view, getLastTransactions } = mountCapturingView(longDoc)

    // Stub view.viewport/coordsAtPos to simulate being scrolled well past
    // the edit point -- jsdom's own zero-size layout would otherwise always
    // report the whole (short, in Tests 2-6) document as "the viewport",
    // never exercising this branch at all.
    Object.defineProperty(view, 'viewport', { configurable: true, get: () => ({ from: 100, to: 110 }) })
    view.coordsAtPos = () => ({ top: 500, bottom: 514, left: 0, right: 0 })

    expect(() => {
      dispatchAppWrite(view, { from: 0, to: 0, insert: 'INSERTED-' }, 'user-right', 2004)
    }).not.toThrow()

    expect(view.state.doc.toString()).toBe('INSERTED-' + longDoc)
    expect(getLastTransactions()[0].annotation(appWriteOrigin)).toBe('user-right')

    view.destroy()
  })

  // [15-02] markRecentAppWrite(docId) is a direct setter onto the SAME
  // lastWriteEndAt map dispatchAppWrite's own finally block populates --
  // its one caller is session/restore.js's boot-time scrollTop write (a raw
  // property assignment with no dispatchAppWrite bracket at all), which
  // needs the SAME wasRecentAppWrite() suppression window dispatchAppWrite
  // gets for free.
  it('Test 6: markRecentAppWrite(docId) makes wasRecentAppWrite(docId) return true immediately, and stays false for a different, never-marked docId', () => {
    const docId = 3001
    const otherDocId = 3002

    expect(wasRecentAppWrite(docId)).toBe(false)

    markRecentAppWrite(docId)

    expect(wasRecentAppWrite(docId)).toBe(true)
    expect(wasRecentAppWrite(otherDocId)).toBe(false)
  })
})
