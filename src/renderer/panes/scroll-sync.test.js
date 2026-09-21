// @vitest-environment jsdom
// Regression guard, v1.0 UAT: scroll-sync must ignore a scroll the APP caused.
//
// Editing in the preview makes back-convert.js write into the raw-pane
// surface via an app-initiated write, which focuses it and scrolls it to
// the caret. That is a real scroll event, so isSyncingScroll -- which only
// breaks sync->sync loops -- never saw it, and the resulting sync yanked the
// preview away from wherever the reader was.
//
// --- 12-04 Task 2: rewritten for attachLeftScrollSync(scrollDOM) ----------
//
// The old signature, attachLeftScrollSync(textareaEl, docId), closed over a
// docId captured once at attach-time -- correct when there was one
// scrollable node per document. CM6 replaces that with ONE shared scrollDOM
// for every document, so attachLeftScrollSync() is now called exactly once,
// with no docId parameter, and its guard resolves the ACTIVE docId fresh on
// every scroll event via getActiveDocId(). The mocked getActiveOrigin below
// is deliberately keyed BY docId (an origin table, not one shared value) so
// a test can prove the guard checks whichever docId is active NOW, not
// whichever one happened to be active when the listener was attached
// (T-12-08).
import { describe, it, expect, beforeEach, vi } from 'vitest'

let activeDocId = 1
let originByDoc = {}
vi.mock('../documents.js', () => ({
  getActiveEditor: () => null,
  getActiveDocId: () => activeDocId
}))
vi.mock('../markdown/sync-controller.js', () => ({
  getActiveOrigin: (docId) => originByDoc[docId] ?? null
}))

function makeScrollable (el, { scrollHeight, clientHeight }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  return el
}

let attachLeftScrollSync
let scrollDOM

beforeEach(async () => {
  vi.resetModules()
  activeDocId = 1
  originByDoc = {}
  document.body.innerHTML = `
    <input type="checkbox" id="toggle-sync-scroll" checked />
    <div id="preview"></div>`
  makeScrollable(document.getElementById('preview'), { scrollHeight: 2000, clientHeight: 500 })
  global.requestAnimationFrame = (fn) => { fn(); return 0 }
  ;({ attachLeftScrollSync } = await import('./scroll-sync.js'))
  scrollDOM = makeScrollable(document.createElement('div'), { scrollHeight: 2000, clientHeight: 500 })
  document.body.appendChild(scrollDOM)
  attachLeftScrollSync(scrollDOM)
})

function scrollSharedNode () {
  scrollDOM.scrollTop = 750
  scrollDOM.dispatchEvent(new Event('scroll'))
  return document.getElementById('preview').scrollTop
}

describe('attachLeftScrollSync', () => {
  it('syncs a scroll the user performed', () => {
    activeDocId = 1
    originByDoc = { 1: null }
    expect(scrollSharedNode()).toBeGreaterThan(0)
  })

  it('ignores a scroll caused by an app-initiated write', () => {
    activeDocId = 1
    originByDoc = { 1: 'preview' }
    expect(scrollSharedNode()).toBe(0)
  })

  it('ignores it for every write origin, not just one', () => {
    activeDocId = 1
    for (const origin of ['preview', 'toolbar', 'paste', 'tab-key']) {
      document.getElementById('preview').scrollTop = 0
      originByDoc = { 1: origin }
      expect(scrollSharedNode()).toBe(0)
    }
  })

  it('resumes syncing once the write finishes', () => {
    activeDocId = 1
    originByDoc = { 1: 'preview' }
    expect(scrollSharedNode()).toBe(0)
    document.getElementById('preview').scrollTop = 0
    originByDoc = { 1: null }
    expect(scrollSharedNode()).toBeGreaterThan(0)
  })

  // T-12-08: the whole reason attachLeftScrollSync() lost its docId
  // parameter. Two documents are "open" (represented purely by the mocked
  // origin table, since there is only one real scrollDOM) -- doc 2 has an
  // app-write in flight, doc 1 does not. The listener was attached ONCE,
  // before either docId became active, so if the guard ever cached a docId
  // at attach-time this test would fail the moment the active document
  // changes.
  it('resolves the ACTIVE document\'s origin fresh on every scroll event, not a docId captured once at attach-time', () => {
    originByDoc = { 1: null, 2: 'preview' }

    // Doc 2 is active and mid-app-write -- scrolling the shared node must
    // be suppressed.
    activeDocId = 2
    expect(scrollSharedNode()).toBe(0)

    // Switch the ACTIVE document to doc 1 (no app-write in progress) --
    // the SAME listener, on the SAME node, attached only once, must now
    // sync: proof the guard re-resolved getActiveDocId() fresh rather than
    // reusing whatever was active when attachLeftScrollSync() was called.
    activeDocId = 1
    document.getElementById('preview').scrollTop = 0
    expect(scrollSharedNode()).toBeGreaterThan(0)
  })
})
