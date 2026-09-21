// @vitest-environment jsdom
//
// sync-controller.js itself holds no DOM reference at all in its own six
// state-slot primitives (same rationale as splice.test.js/split.test.js's
// pure-logic tests) -- jsdom is opted in at the FILE level only because the
// 03-06-PLAN.md describe blocks below (kept, unmodified, at the bottom of
// this file) drive renderMarkdown()/syncPreviewBlockToMarkdown() -- render.js/
// back-convert.js's real, wired entry points -- through an actual DOM.
//
// --- 05-02: REWRITTEN for the per-docId keying rewrite --------------------
//
// Every describe block above the 03-06 integration section is rewritten
// (not merely extended) to exercise the new Map<docId, ...> shape directly,
// per 05-02-PLAN.md Task 2's explicit instruction. The 03-06 integration
// blocks (conversion counter call-count, wall-time budget) are left
// unchanged below: they call setDocumentBody/setDocumentBlocks/
// setFrontMatter with no explicit docId, which still resolves to
// DEFAULT_DOC_ID (1) exactly as before this rewrite -- their own
// single-document assertions are unaffected by the per-docId keying
// underneath, and preserving them keeps real regression coverage for
// render.js/back-convert.js that this plan's own "REWRITE, do not extend"
// instruction was never meant to discard.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('./source-map.js', async () => {
  const actual = await vi.importActual('./source-map.js')
  return { ...actual, renderWithSourceMap: vi.fn(actual.renderWithSourceMap) }
})
vi.mock('./turndown-block.js', async () => {
  const actual = await vi.importActual('./turndown-block.js')
  return { ...actual, turndownBlock: vi.fn(actual.turndownBlock) }
})

import {
  nextRevision,
  currentRevision,
  beginWrite,
  endWrite,
  getActiveOrigin,
  isNoOp,
  recordApplied,
  scheduleFlush,
  flush,
  flushAll,
  cancelPending,
  discardDocState,
  getDocumentBody,
  setDocumentBody,
  getDocumentBlocks,
  setDocumentBlocks,
  getFrontMatter,
  setFrontMatter,
} from './sync-controller.js'
import { renderWithSourceMap } from './source-map.js'
import { turndownBlock } from './turndown-block.js'
// 12-09: the last remaining textarea-shaped fixture in this file is retired
// in favour of the real, shared CM6 EditorView/EditorState pair --
// getSharedView() reads the SAME live view getActiveEditor() (../documents.js)
// resolves (mounted once at documents.js's own module-load-time bootstrap,
// triggered transitively below when back-convert.js is imported -- see
// beforeAll's own comment); createEditorState() is the one factory every
// per-tab state in this app is built from (cm-view.js), used here to replace
// the shared view's live state wholesale between test groups so accumulated
// undo history from earlier tests in this file never leaks into a later
// group's own measurement (most load-bearing for the wall-time-budget
// describe block below, per 12-09-PLAN.md Task 2).
import { createEditorState, getSharedView } from './cm-view.js'

// 05-03: back-convert.js now imports documents.js, which captures
// `#md-input`/`#left-pane` as live element references AT MODULE-LOAD TIME
// and immediately wires attachEditorEvents()/attachLeftScrollSync() onto
// the bootstrap document's surface -- including scroll-sync.js's own
// module-scope `#preview` lookup (a transitive import). render.js and
// back-convert.js are therefore deferred to a dynamic import inside
// `beforeAll`, AFTER a persistent DOM fixture is built -- mirroring
// preview/events.test.js's/back-convert.test.js's own established pattern
// -- rather than this file's previous static top-of-file import (which used
// to run before any test's DOM existed, harmless before this plan since
// back-convert.js had no DOM-querying import of its own at module scope).
// The DOM `setupSyncDom()` used to build fresh via `document.body.innerHTML`
// every test is now built ONCE, here; `setupSyncDom()` below resets CONTENT
// on these same persistent nodes instead, so the exact element
// documents.js's getActiveEditor() resolves to is never a different, stale
// node than the one these tests directly manipulate.
let renderMarkdown
let syncPreviewBlockToMarkdown

beforeAll(async () => {
  // 12-09: `<div id="md-input">` -- matching index.html's real post-12-02
  // shape (12-05-SUMMARY.md's own established fixture pattern,
  // back-convert.test.js/preview/events.test.js) -- not a `<textarea>`.
  // back-convert.js (imported below) statically imports `../documents.js`,
  // whose own module-load-time bootstrap calls mountSharedView() against
  // THIS element the moment that import resolves -- no separate explicit
  // `import('../documents.js')` or mount call is needed here; duplicating it
  // would construct a second, unused EditorView.
  document.body.innerHTML = `
    <div id="left-pane">
      <div id="md-input"></div>
    </div>
    <div id="preview" contenteditable="true"></div>
    <div id="empty-state"></div>
    <span id="file-label"></span>
    <button id="btn-save"></button>
    <input type="checkbox" id="toggle-sync-scroll" />
  `
  ;({ renderMarkdown } = await import('./render.js'))
  ;({ syncPreviewBlockToMarkdown } = await import('./back-convert.js'))
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('nextRevision / currentRevision', () => {
  it('increments monotonically per docId, using DEFAULT_DOC_ID (1) when omitted', () => {
    const start = currentRevision()
    const first = nextRevision()
    const second = nextRevision()
    expect(first).toBe(start + 1)
    expect(second).toBe(start + 2)
    expect(currentRevision()).toBe(second)
    expect(currentRevision()).toBe(second) // reading again does not increment
  })

  it('keeps two docIds independent -- advancing one never advances the other', () => {
    const aStart = currentRevision('doc-A')
    const bStart = currentRevision('doc-B')
    nextRevision('doc-A')
    nextRevision('doc-A')
    expect(currentRevision('doc-A')).toBe(aStart + 2)
    expect(currentRevision('doc-B')).toBe(bStart)
  })
})

describe('beginWrite / endWrite / getActiveOrigin', () => {
  it('is null before any beginWrite and after endWrite, for the default docId', () => {
    endWrite() // hygiene: clear any leakage from a prior test in this suite
    expect(getActiveOrigin()).toBe(null)
    beginWrite('user-left')
    expect(getActiveOrigin()).toBe('user-left')
    endWrite()
    expect(getActiveOrigin()).toBe(null)
  })

  it('keeps two docIds independent -- a write in flight for one never leaks into another', () => {
    beginWrite('user-left', 'doc-A')
    expect(getActiveOrigin('doc-A')).toBe('user-left')
    expect(getActiveOrigin('doc-B')).toBe(null)

    beginWrite('user-right', 'doc-B')
    expect(getActiveOrigin('doc-A')).toBe('user-left')
    expect(getActiveOrigin('doc-B')).toBe('user-right')

    endWrite('doc-A')
    expect(getActiveOrigin('doc-A')).toBe(null)
    expect(getActiveOrigin('doc-B')).toBe('user-right')

    endWrite('doc-B')
  })
})

describe('isNoOp / recordApplied', () => {
  it('round-trips per targetPane independently for the default docId -- setting left does not affect preview', () => {
    expect(isNoOp('left', 'hello-default')).toBe(false)
    recordApplied('left', 'hello-default')
    expect(isNoOp('left', 'hello-default')).toBe(true)
    expect(isNoOp('preview', 'hello-default')).toBe(false)

    recordApplied('preview', 'world-default')
    expect(isNoOp('preview', 'world-default')).toBe(true)
    expect(isNoOp('left', 'world-default')).toBe(false)
    expect(isNoOp('left', 'hello-default')).toBe(true)
  })

  it('keeps the same targetPane independent across two different docIds', () => {
    recordApplied('left', 'A content', 'doc-A')
    recordApplied('left', 'B content', 'doc-B')

    expect(isNoOp('left', 'A content', 'doc-A')).toBe(true)
    expect(isNoOp('left', 'B content', 'doc-A')).toBe(false)
    expect(isNoOp('left', 'B content', 'doc-B')).toBe(true)
    expect(isNoOp('left', 'A content', 'doc-B')).toBe(false)
  })
})

describe('scheduleFlush / flush / flushAll / cancelPending', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  // [05-13, Rule 1 - Bug] Moved timer restoration into afterEach instead of
  // relying on each individual test's own trailing `vi.useRealTimers()`
  // call. 05-13-PLAN.md flagged a pre-existing, intermittent flake in this
  // exact file ("400/401, 395/396 under --pool=forks") and asked for it to
  // be investigated as part of THIS plan, not dismissed. The bug: if any
  // assertion above a test's own `vi.useRealTimers()` line ever threw
  // (a genuine failure OR a future edit that added an earlier `expect()`),
  // execution would never reach that line, and fake timers would leak into
  // every subsequent test in this file -- including the wall-time-budget
  // describe block below, which measures real elapsed time via
  // `performance.now()` and would then measure against a frozen or
  // artificially-advanced fake clock instead of real wall-clock time,
  // producing exactly the kind of non-deterministic pass/fail drift the
  // reported flake describes. `afterEach` runs regardless of whether the
  // test threw, closing this gap unconditionally. The individual
  // `vi.useRealTimers()` calls inside each test below are now redundant but
  // left in place (harmless double-call) rather than removed, since
  // removing them is not necessary to fix the bug and touches more lines
  // than the fix requires.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls fn after the delay and clears the pending entry, for the default docId', () => {
    const fn = vi.fn()
    scheduleFlush('left', fn, 60)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60)
    expect(fn).toHaveBeenCalledTimes(1)

    // pending entry was cleared -- a subsequent flush() is a no-op
    flush()
    expect(fn).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('cancels the first call when scheduleFlush is called twice for the same targetPane+docId before it fires', () => {
    const first = vi.fn()
    const second = vi.fn()
    scheduleFlush('preview', first, 100, 'doc-cancel-first')
    scheduleFlush('preview', second, 100, 'doc-cancel-first')
    vi.advanceTimersByTime(100)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('flush(docId) synchronously invokes a pending fn without waiting for its timer, then clears it', () => {
    const fn = vi.fn()
    scheduleFlush('left', fn, 5000, 'doc-flush-sync')
    flush('doc-flush-sync')
    expect(fn).toHaveBeenCalledTimes(1)

    // A subsequent flush() call is a no-op -- the entry was cleared.
    flush('doc-flush-sync')
    expect(fn).toHaveBeenCalledTimes(1)

    // Advancing time past the original delay must not fire it again --
    // the timer was cleared by flush().
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('keeps left and preview pending entries independent within one docId', () => {
    const leftFn = vi.fn()
    const previewFn = vi.fn()
    scheduleFlush('left', leftFn, 1000, 'doc-left-preview')
    scheduleFlush('preview', previewFn, 1000, 'doc-left-preview')

    flush('doc-left-preview')
    expect(leftFn).toHaveBeenCalledTimes(1)
    expect(previewFn).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  // --- The three cases 05-02-PLAN.md Task 2 explicitly requires ----------

  it('a pending flush scheduled for docId A never fires against docId B (Pitfall 4 / threat T-5-02)', () => {
    const fnA = vi.fn()
    const fnB = vi.fn()
    scheduleFlush('left', fnA, 60, 'doc-A-isolation')
    scheduleFlush('left', fnB, 60, 'doc-B-isolation')

    // Flushing B must never invoke A's callback.
    flush('doc-B-isolation')
    expect(fnB).toHaveBeenCalledTimes(1)
    expect(fnA).not.toHaveBeenCalled()

    // A's own timer is still armed and independent -- advancing time fires
    // it exactly once, proving B's flush did not also consume/clear it.
    vi.advanceTimersByTime(60)
    expect(fnA).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  // [05-13, Task 1] The exact fake-timer proof this plan requires (see the
  // verify command in 05-13-PLAN.md: `-t "cancels pending flush on document
  // close"`), distinct from the pre-existing 05-02 "clears a scheduled
  // timer" test above -- this one specifically mirrors documents.js's real
  // closeDocument() call order (cancelPending(docId) BEFORE the docId's Map
  // entry is removed) and asserts the Pitfall-4 failure mode never happens:
  // no TypeError, no stale write recorded, even when the "pending write"
  // itself would throw if it ever ran against a closed document.
  it('cancels pending flush on document close', () => {
    const closedDocId = 'doc-closed-on-tab-close'
    const staleWrite = vi.fn(() => {
      throw new Error('stale write fired against a closed document -- this must never happen')
    })

    // Schedule a flush exactly as editor-events.js's input listener does
    // (scheduleFlush('preview', ..., RENDER_DEBOUNCE_MS, docId)), then
    // cancel it exactly as documents.js's closeDocument() does, BEFORE the
    // document's own Map entry would be removed.
    scheduleFlush('preview', staleWrite, 60, closedDocId)
    cancelPending(closedDocId)

    // Advance well past the debounce delay. If cancelPending() had failed
    // to clear the timer, staleWrite() would fire here and throw
    // synchronously inside advanceTimersByTime() -- this assertion would
    // then fail with that thrown error, not silently pass.
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(staleWrite).not.toHaveBeenCalled()

    // A subsequent flush() must also be a genuine no-op -- the entry was
    // removed outright, not merely paused.
    flush(closedDocId)
    expect(staleWrite).not.toHaveBeenCalled()
  })

  // [05-15, Task 2] Gap-closure regression: proves discardDocState(docId)
  // genuinely DELETES a closed document's entry from every one of the seven
  // per-docId Maps -- not merely cancels its pending timers (cancelPending's
  // own, narrower, unchanged contract, proven above). Fast and
  // deterministic, unlike the slow e2e soak (tabs-soak.spec.js) which stays
  // the separate, non-collapsed proof of the same underlying fix under real
  // heap measurement. Confirmed (once, manually, during this plan's
  // execution): swapping this call to cancelPending(docId) makes the
  // getDocumentBody/getFrontMatter/getActiveOrigin/currentRevision
  // assertions below fail (getDocumentBody read back 'leftover body'
  // instead of '') -- see 05-15-SUMMARY.md.
  it('discardDocState(docId) removes a closed document\'s state from all 7 per-doc Maps', () => {
    const docId = 'doc-discard-state'

    setDocumentBody('leftover body', docId)
    setDocumentBlocks([{ index: 0, type: 'paragraph' }], docId)
    setFrontMatter('---\nx: 1\n---\n', docId)
    beginWrite('user-left', docId)
    nextRevision(docId)
    recordApplied('left', 'leftover body', docId)
    scheduleFlush('left', vi.fn(), 999999, docId)

    discardDocState(docId)

    // Every accessor must read back its ensureDocState()-initialized DEFAULT
    // value, not the value set above -- proving the Map KEY was genuinely
    // deleted, not merely left holding its old value untouched.
    expect(getDocumentBody(docId)).toBe('')
    expect(getDocumentBlocks(docId)).toEqual([])
    expect(getFrontMatter(docId)).toBe('')
    expect(getActiveOrigin(docId)).toBe(null)
    expect(currentRevision(docId)).toBe(0)
    expect(isNoOp('left', 'leftover body', docId)).toBe(false)
  })

  it('cancelPending(docId) clears a scheduled timer without invoking its callback', () => {
    const fn = vi.fn()
    scheduleFlush('left', fn, 1000, 'doc-cancel-pending')
    cancelPending('doc-cancel-pending')

    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()

    // The entry was cleared, not merely paused -- a subsequent flush() is a
    // no-op.
    flush('doc-cancel-pending')
    expect(fn).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('flushAll() runs every currently-pending docId\'s callback synchronously', () => {
    const fnA = vi.fn()
    const fnB = vi.fn()
    const fnC = vi.fn()
    scheduleFlush('left', fnA, 9999, 'doc-flushall-A')
    scheduleFlush('preview', fnB, 9999, 'doc-flushall-B')
    scheduleFlush('left', fnC, 9999, 'doc-flushall-C')

    flushAll()

    expect(fnA).toHaveBeenCalledTimes(1)
    expect(fnB).toHaveBeenCalledTimes(1)
    expect(fnC).toHaveBeenCalledTimes(1)

    // None of the timers fire again later -- flushAll() cleared them.
    vi.advanceTimersByTime(9999)
    expect(fnA).toHaveBeenCalledTimes(1)
    expect(fnB).toHaveBeenCalledTimes(1)
    expect(fnC).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})

describe('shared document bookkeeping defaults', () => {
  it('getDocumentBody defaults to an empty string for a fresh docId', () => {
    expect(getDocumentBody('doc-fresh-body')).toBe('')
  })

  it('getDocumentBlocks defaults to an empty array for a fresh docId', () => {
    expect(getDocumentBlocks('doc-fresh-blocks')).toEqual([])
  })

  it('getFrontMatter defaults to an empty string for a fresh docId', () => {
    expect(getFrontMatter('doc-fresh-fm')).toBe('')
  })

  it('setDocumentBody/setDocumentBlocks/setFrontMatter round-trip for the default docId', () => {
    setDocumentBody('# Hello')
    expect(getDocumentBody()).toBe('# Hello')

    const blocks = [{ index: 0, type: 'heading', srcStart: 0, srcEnd: 7 }]
    setDocumentBlocks(blocks)
    expect(getDocumentBlocks()).toBe(blocks)

    setFrontMatter('---\ntitle: x\n---\n')
    expect(getFrontMatter()).toBe('---\ntitle: x\n---\n')
  })

  it('keeps documentBody/documentBlocks/frontMatter fully independent across two docIds', () => {
    setDocumentBody('doc A body', 'doc-bookkeeping-A')
    setDocumentBody('doc B body', 'doc-bookkeeping-B')
    setDocumentBlocks([{ index: 0, type: 'paragraph' }], 'doc-bookkeeping-A')
    setFrontMatter('---\nA: 1\n---\n', 'doc-bookkeeping-A')

    expect(getDocumentBody('doc-bookkeeping-A')).toBe('doc A body')
    expect(getDocumentBody('doc-bookkeeping-B')).toBe('doc B body')
    expect(getDocumentBlocks('doc-bookkeeping-B')).toEqual([])
    expect(getFrontMatter('doc-bookkeeping-B')).toBe('')
    expect(getFrontMatter('doc-bookkeeping-A')).toBe('---\nA: 1\n---\n')
  })
})

// --- 03-06-PLAN.md Task 1: conversion counter + wall-time budget ---------
//
// Unchanged by the 05-02 per-docId rewrite: every call below omits docId and
// therefore resolves to DEFAULT_DOC_ID (1), exactly matching this describe
// block's own single-document assumptions from before this rewrite.
//
// Closes 03-RESEARCH.md Pitfall 3's named blind spot: call-count alone
// cannot distinguish "2 cheap per-block calls" from "2 whole-document
// calls" that happen to also number 2. The two describe blocks below prove
// each half separately -- call COUNT here, wall-TIME in the block after it
// -- against renderMarkdown()/syncPreviewBlockToMarkdown(), render.js's/
// back-convert.js's real, unmocked entry points.

// Resets CONTENT on the SAME persistent `#md-input`/`#preview`/etc. nodes
// built once in the top-level `beforeAll` -- deliberately NOT
// `document.body.innerHTML = ...` (which would create a brand-new
// `<textarea id="md-input">` every test, orphaning the exact element
// reference documents.js cached at import time and making
// syncPreviewBlockToMarkdown's getActiveEditor() write into a detached node
// instead of the one these tests directly manipulate and inspect).
// 12-09: resets the shared CM6 view's own live state to a fresh, empty
// EditorState (createEditorState(''), never a dispatched delete-everything
// transaction) -- discarding any accumulated undo history from a PRIOR
// test's writes, rather than merely emptying the document while leaving that
// history attached. This matters most for the wall-time-budget describe
// block below: dispatching against the SAME shared view/history dozens of
// times over this file's run would let CM6's own per-dispatch history
// bookkeeping cost grow test-over-test, confounding a measurement that is
// supposed to isolate back-convert.js's own conversion cost (12-RESEARCH.md
// section 8). getSharedView() resolves the exact same live view
// getActiveEditor() (../documents.js) returns -- there is only ever one.
function setupSyncDom() {
  getSharedView().setState(createEditorState(''))
  document.getElementById('preview').innerHTML = ''
  document.getElementById('empty-state').classList.remove('hidden')
}

// Places a collapsed caret at the end of `element`'s own content -- jsdom
// has no click-to-caret mapping, so this places selection state directly,
// mirroring back-convert.test.js's/format.test.js's established idiom for
// the same limitation.
function placeCaretAtEnd(element) {
  const textNode = element.firstChild
  const range = document.createRange()
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, textNode.textContent.length)
  } else {
    range.selectNodeContents(element)
  }
  range.collapse(false)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

function combinedCallCount() {
  return renderWithSourceMap.mock.calls.length + turndownBlock.mock.calls.length
}

describe('conversion counter: renderWithSourceMap + turndownBlock combined call count per keystroke', () => {
  // Deliberately a SINGLE-paragraph document, not the 200-line multi-block
  // fixture: back-convert.js's range-based neighbour search has a
  // data-dependent cost (it walks outward until it finds a verifiably
  // unchanged block on each side), so a single-block document is the one
  // shape where the call-count arithmetic is exact and traceable rather
  // than dependent on how many neighbours the search happens to visit.
  // caret-stationary.spec.js (tests/e2e/) is what proves this same
  // mechanism holds up under sustained typing against a REAL multi-block
  // 200-line document; this test proves the call-count ceiling itself,
  // which is easiest to reason about exactly here.
  beforeEach(() => {
    setupSyncDom()
    setDocumentBody('')
    setDocumentBlocks([])
    setFrontMatter('')
  })

  it('a mixed left/right sequence on a single-paragraph document averages at most 2 combined calls per keystroke', () => {
    const view = getSharedView()
    const preview = document.getElementById('preview')

    // Seed: establishes the shared documentBody/Blocks bookkeeping and the
    // initial preview DOM. Not counted -- cleared below.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Hello world.' } })
    renderMarkdown(view.state.doc.toString())
    vi.clearAllMocks()

    let totalCalls = 0
    let keystrokeCount = 0

    // 5 left-pane keystrokes: each dispatches a real CM6 append transaction
    // (simulating one keystroke at the document's end) then calls
    // renderMarkdown() against the view's own live content -- the same
    // debounced entry point editor-events.js schedules -- one call per
    // keystroke here simulates the worst case of zero debounce coalescing.
    for (let i = 0; i < 5; i++) {
      const before = combinedCallCount()
      view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
      renderMarkdown(view.state.doc.toString())
      totalCalls += combinedCallCount() - before
      keystrokeCount++
    }

    // 5 right-pane keystrokes: append one character to the single
    // paragraph and drive syncPreviewBlockToMarkdown('user-right') directly
    // -- preview/events.js's real debounced entry point.
    for (let i = 0; i < 5; i++) {
      const before = combinedCallCount()
      const p = preview.children[0]
      p.textContent += '!'
      placeCaretAtEnd(p)
      syncPreviewBlockToMarkdown('user-right')
      totalCalls += combinedCallCount() - before
      keystrokeCount++
    }

    expect(keystrokeCount).toBe(10)
    expect(totalCalls / keystrokeCount).toBeLessThanOrEqual(2)
  })

  it('a right-pane-only sequence (the more expensive direction) still averages at most 2 combined calls per keystroke', () => {
    const view = getSharedView()
    const preview = document.getElementById('preview')
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Hello world.' } })
    renderMarkdown(view.state.doc.toString())
    vi.clearAllMocks()

    let totalCalls = 0
    const KEYSTROKES = 8
    for (let i = 0; i < KEYSTROKES; i++) {
      const before = combinedCallCount()
      const p = preview.children[0]
      p.textContent += 'x'
      placeCaretAtEnd(p)
      syncPreviewBlockToMarkdown('user-right')
      totalCalls += combinedCallCount() - before
    }

    expect(totalCalls / KEYSTROKES).toBeLessThanOrEqual(2)
  })

  it('a left-pane-only sequence never calls turndownBlock at all', () => {
    const view = getSharedView()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Hello world.' } })
    renderMarkdown(view.state.doc.toString())
    vi.clearAllMocks()

    for (let i = 0; i < 6; i++) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
      renderMarkdown(view.state.doc.toString())
    }

    expect(turndownBlock.mock.calls.length).toBe(0)
    expect(renderWithSourceMap.mock.calls.length).toBeLessThanOrEqual(6)
  })
})

describe('conversion wall-time budget: a single right-pane keystroke on a large real document', () => {
  // 03-RESEARCH.md Pitfall 3 (measured against this repo's own real
  // Markdown, not synthetic text): whole-document htmlToMarkdown() costs a
  // median 55ms at 200 lines and 320ms at 2000 lines; a single-block
  // turndownBlock() call costs a median ~0.06ms regardless of document
  // size. 35ms is comfortably above a handful of per-candidate round-trip
  // normalisation calls (03-06's own back-convert.js fix -- see
  // `normalisedForm()` -- adds one full markdownToHtml/htmlToMarkdown pass
  // per anchor-search candidate, still bounded by ONE BLOCK's size, not the
  // document's) and comfortably below even the smaller 55ms whole-document
  // figure -- wide enough to absorb jsdom's own DOM-API overhead (this test
  // runs in jsdom, not the real Chromium the research measurements were
  // taken against) without narrowing the margin that makes the assertion
  // meaningless. A warm-up pass (below) removes one-time JIT/regex-
  // compilation cold-start cost from the measurement, which is what made
  // an even-more-generous 40ms budget still occasionally flake under
  // shared-machine contention before the warm-up was added -- this is what
  // catches a regression that keeps the call COUNT at <=2 (the describe
  // block above) while accidentally widening what each call converts back
  // to whole-document scope -- e.g. passing the whole #preview element into
  // turndownBlock instead of the one changed child, which would still be
  // "2 calls" but cost tens of milliseconds instead of a fraction of one.
  //
  // [12-09-PLAN.md Task 2] Re-measured after this file's Step 4 write
  // mechanism moved from a stubbed `execCommand` to a real, dispatched CM6
  // transaction (dispatchAppWrite, via the real, shared, mounted
  // EditorView) -- per 12-CONTEXT.md's binding constraint 10, this could not
  // be left unverified. Measured this session, in isolation
  // (`vitest run ... -t "wall-time budget"`, 15 runs): 6.4-9.7ms, median
  // ~6.8ms -- comfortably under budget, and if anything CHEAPER than the
  // execCommand-stub era this replaces (real CM6 dispatch has no DOM-command
  // dispatch overhead to pay). Budget KEPT at 35ms; no change justified by
  // the isolated, steady-state number this test is actually trying to
  // bound.
  //
  // Separately (12-CONTEXT.md's named flake, "passed 25/25 in isolation
  // during Phase 11 but failed inside a full-suite run"): reproduced
  // directly this session, not merely inherited as a rumour. 13 full-suite
  // runs (`npx vitest run`, this repo's real `pool: 'threads'` config,
  // ~60 other test files racing for the same thread pool) measured
  // 16.8-37.1ms for this exact call -- one of the 13 runs (37.1ms) exceeded
  // this 35ms budget and failed. The isolated number never moved outside its
  // 6.4-9.7ms band across the same session; the full-suite number is 2-5x
  // higher and swings by >20ms run to run, entirely explained by thread-pool
  // contention from unrelated concurrently-running test files, not by
  // anything this plan (or this phase) changed in back-convert.js's own cost
  // path (Steps 1-3 byte-for-byte unchanged since 03-04-PLAN.md; Step 4's
  // own isolated cost went DOWN, not up, per the paragraph above). Verdict:
  // STILL FLAKY under full-suite/parallel load, with a concrete, now-proven
  // cause (thread contention, not a CM6-rebuild regression) -- this is a
  // machine-load measurement, not a back-convert.js correctness signal, once
  // it leaves isolation. Raising WALL_TIME_BUDGET_MS further would not fix
  // this (contention can consume arbitrarily more wall time under heavier
  // load than this session happened to produce) and would only narrow this
  // test's actual ability to catch the real regression class it exists for
  // (a whole-document-scope conversion costs tens of milliseconds too, per
  // the 55-320ms figures cited above). Recommendation, left for the phase's
  // own follow-up rather than actioned unilaterally here (a vitest.config.js
  // pool/isolation change is a test-infrastructure decision with blast
  // radius across every timing-sensitive test in this suite, outside this
  // plan's own `files_modified: [sync-controller.test.js]` scope): either
  // pin this one test to run outside the shared thread pool (e.g. `test.
  // concurrent: false` plus a dedicated pool, or a separate vitest project),
  // or accept the current rare-under-contention flake as a known, named
  // limitation of a wall-clock assertion sharing a machine with 60+ other
  // files, and keep this comment as the record of that decision the next
  // person who sees a red CI run here needs to find.
  const WALL_TIME_BUDGET_MS = 35

  beforeEach(() => {
    setupSyncDom()
    setDocumentBody('')
    setDocumentBlocks([])
    setFrontMatter('')
  })

  // Seeds a fresh DOM/sync-controller state with `markdown`, edits the
  // middle paragraph by one character, and returns the wall-time cost of
  // the resulting syncPreviewBlockToMarkdown('user-right') call.
  //
  // 12-09: seeds the shared CM6 view via getSharedView().setState(
  // createEditorState(markdown)) rather than a dispatched change -- a fresh
  // EditorState (not a diff against whatever the PREVIOUS measured pass left
  // behind) is what setupSyncDom() already establishes above, and this
  // mirrors it exactly for seeding real content: no history entries survive
  // between the warm-up pass and the real measured pass below, so neither
  // one's `view.dispatch()` cost is inflated by an unrelated prior pass's
  // history bookkeeping.
  function measureOneMiddleParagraphEdit(markdown) {
    setupSyncDom()
    setDocumentBody('')
    setDocumentBlocks([])
    setFrontMatter('')

    const view = getSharedView()
    view.setState(createEditorState(markdown))
    const preview = document.getElementById('preview')

    renderMarkdown(view.state.doc.toString())

    const paragraphs = Array.from(preview.querySelectorAll('p'))
    expect(paragraphs.length).toBeGreaterThan(1)
    const target = paragraphs[Math.floor(paragraphs.length / 2)]

    target.textContent += '!'
    placeCaretAtEnd(target)

    const before = performance.now()
    syncPreviewBlockToMarkdown('user-right')
    return performance.now() - before
  }

  it('stays under the wall-time budget on tests/fixtures/corpus/real-roadmap.md (standing in for the 2000-line scale)', () => {
    const fixturePath = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'corpus', 'real-roadmap.md')
    const markdown = fs.readFileSync(fixturePath, 'utf8')

    // Warm-up pass (discarded): a cold first call in this describe block
    // pays one-time JIT/regex-compilation costs (marked's/Turndown's own
    // lazily-compiled regexes, V8 tiering) that have nothing to do with
    // this test's actual concern (whole-document-scope regressions) --
    // measured, empirically, to add tens of milliseconds of pure one-time
    // overhead on a cold run, which would otherwise make this assertion
    // flaky for a reason unrelated to what it exists to catch. Running the
    // exact same shape once, unmeasured, before the real measurement
    // removes that confound the same way a benchmark warm-up iteration
    // does. Content differs by one appended paragraph so render.js's own
    // idempotence check (sync-controller.js's `lastApplied` cache, a
    // module-level singleton this warm-up pass's setDocumentBody/Blocks
    // reset does NOT clear) does not treat the real measured pass below as
    // a no-op and skip patching #preview entirely.
    measureOneMiddleParagraphEdit(markdown + '\n\nWarm-up marker paragraph.')

    const elapsed = measureOneMiddleParagraphEdit(markdown)

    expect(elapsed).toBeLessThan(WALL_TIME_BUDGET_MS)
  })
})

// --- 05-REVIEW.md CR-01 regression -----------------------------------------
//
// Proves render.js and back-convert.js stay docId-consistent across TWO real
// documents -- the exact gap CR-01 found: render.js used to write
// documentBody/documentBlocks always under DEFAULT_DOC_ID (1), so
// back-convert.js's syncPreviewBlockToMarkdown(docId=2) read a phantom,
// permanently-empty "previous body" and spliced the preview edit in as a
// COLLAPSED INSERT AT OFFSET 0 -- prepending onto the real content instead of
// replacing it -- for any document other than the literal first-created tab.
// This test fails before the fix (asserting a corrupted
// 'Hello EDITED worldHello world' value) and passes after it.
describe('CR-01 regression: renderMarkdown()/syncPreviewBlockToMarkdown() stay docId-consistent across two open documents', () => {
  beforeEach(() => {
    setupSyncDom()
    setDocumentBody('')
    setDocumentBlocks([])
    setFrontMatter('')
  })

  it('a preview edit on a second, non-bootstrap document patches THAT document\'s real content -- never a corrupted prepend into the bootstrap document\'s empty slot', async () => {
    const { createDocument, setActiveDocId, getDocumentContent, closeDocument } = await import('../documents.js')

    // Doc 2: created with real content and made active, exactly as
    // files/open.js's applyOpenedFile() does for a freshly opened file.
    const docId = createDocument({ initialContent: 'Hello world' })
    setActiveDocId(docId)
    // No explicit docId argument -- proving the DEFAULT (docId =
    // getActiveDocId()) resolves correctly, matching every real call site
    // (editor-events.js, files/open.js, files/new.js) which never passes one.
    renderMarkdown('Hello world')

    const preview = document.getElementById('preview')
    expect(preview.children.length).toBe(1)
    expect(preview.textContent.trim()).toBe('Hello world')

    // Edit the rendered text directly in #preview -- CR-01's exact trace:
    // a preview edit on the ACTIVE, non-bootstrap document.
    const p = preview.children[0]
    p.textContent = 'Hello EDITED world'
    placeCaretAtEnd(p)

    syncPreviewBlockToMarkdown('user-right')

    // [12-09, Rule 1 - Bug] This assertion used to read `getDocument(docId)
    // .surface.value` -- `surface` was renamed to `state` (an immutable
    // EditorState) by 12-02-PLAN.md, and CM6 states have no `.value`
    // property at all, so this read had been silently broken (undefined
    // .value) since 12-02 landed, without failing loudly until 12-05's real
    // dispatchAppWrite() cutover made this file's fixture mismatch surface
    // as an actual failure. getDocumentContent(docId) (12-08-PLAN.md's own
    // shared content-read primitive) is the correct, current replacement --
    // it resolves the shared view's LIVE state when docId is active (true
    // here; docId was never switched away from) and never touches a
    // property that no longer exists on the per-doc record.
    const content = getDocumentContent(docId)
    // Before the fix: the corrupted value was 'Hello EDITED worldHello world'
    // (the edit prepended ahead of the untouched original content, because
    // back-convert.js's baseline read for docId 2 was always '').
    expect(content).toBe('Hello EDITED world')

    closeDocument(docId) // cleanup -- restore single-doc state for later files
  })
})
