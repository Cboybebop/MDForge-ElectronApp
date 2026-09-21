// @vitest-environment jsdom
//
// Task 2 (12-01-PLAN.md): cm-view.js's createEditorState/mountSharedView/
// getSharedView. cm-view.js reads the cm6-csp-nonce <meta> tag ONCE, at
// module scope, and caches it (mirroring the real serve-time-injected
// <meta> tag, which is only ever present once, at the start of one page
// load -- see protocol.js's CM6_STYLE_NONCE). Each test below resets the
// module registry and re-imports cm-view.js AFTER seeding (or deliberately
// not seeding) that meta tag, so the module-scope read happens against the
// DOM state each test actually sets up.
import { describe, it, expect, beforeEach, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('cm-view.js', () => {
  it('createEditorState(initialContent) returns an EditorState whose doc matches the given content', async () => {
    const { createEditorState } = await import('./cm-view.js')

    const state = createEditorState('x')

    expect(state.doc.toString()).toBe('x')
  })

  it('with a seeded cm6-csp-nonce meta tag, mountSharedView mounts a real EditorView whose injected <style> element carries that nonce', async () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'cm6-csp-nonce')
    meta.setAttribute('content', 'test-nonce-value')
    document.head.appendChild(meta)

    const { createEditorState, mountSharedView } = await import('./cm-view.js')
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const view = mountSharedView(parent, createEditorState('hello'))

    const styleEl = document.querySelector('style[nonce="test-nonce-value"]')
    expect(styleEl).not.toBeNull()

    view.destroy()
  })

  it('with no meta tag present, mountSharedView still mounts without throwing (empty-nonce fallback path)', async () => {
    const { createEditorState, mountSharedView, getSharedView } = await import('./cm-view.js')
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    let view
    expect(() => {
      view = mountSharedView(parent, createEditorState('hello'))
    }).not.toThrow()
    expect(getSharedView()).toBe(view)

    view.destroy()
  })

  // 17-02-PLAN.md Task 1: installing the markdown() language mode must
  // never mutate stored document content -- parsing is a read, not a
  // transform. Guards against a naive future regression (e.g. some
  // extension normalising whitespace/line endings on parse).
  it('createEditorState parses content through the new markdown language mode without mutating it', async () => {
    const { createEditorState } = await import('./cm-view.js')

    const state = createEditorState('# H1')

    expect(state.doc.toString()).toBe('# H1')
  })

  // 12-13-PLAN.md Task 1: document.execCommand('undo') does not reliably
  // reach CM6's own history (empirically confirmed against the real, built
  // app this session -- see cm-view.js's own comment on window.__cmUndo).
  // window.__cmUndo must drive @codemirror/commands' real `undo(view)`
  // command against the currently-mounted shared view.
  it('mountSharedView exposes window.__cmUndo, which drives the real CM6 undo command against the shared view', async () => {
    const { createEditorState, mountSharedView } = await import('./cm-view.js')
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const view = mountSharedView(parent, createEditorState(''))
    view.dispatch({ changes: { from: 0, to: 0, insert: 'hello' } })
    expect(view.state.doc.toString()).toBe('hello')

    window.__cmUndo()

    expect(view.state.doc.toString()).toBe('')

    view.destroy()
  })
})
