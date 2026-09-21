// Plain Node, no jsdom -- composition-gate.js is a pure state machine with
// no DOM reference (same rationale as sync-controller.test.js).
import { describe, it, expect } from 'vitest'
import { createCompositionGate } from './composition-gate.js'

describe('createCompositionGate', () => {
  it('isComposing() is false initially', () => {
    const gate = createCompositionGate()
    expect(gate.isComposing()).toBe(false)
  })

  it('isComposing() is true after start()', () => {
    const gate = createCompositionGate()
    gate.start()
    expect(gate.isComposing()).toBe(true)
  })

  it('isComposing() is false after end()', () => {
    const gate = createCompositionGate()
    gate.start()
    gate.end()
    expect(gate.isComposing()).toBe(false)
  })

  it('two independently-created instances do not share state', () => {
    const left = createCompositionGate()
    const preview = createCompositionGate()

    left.start()
    expect(left.isComposing()).toBe(true)
    expect(preview.isComposing()).toBe(false)

    preview.start()
    expect(preview.isComposing()).toBe(true)

    left.end()
    expect(left.isComposing()).toBe(false)
    expect(preview.isComposing()).toBe(true) // unaffected by left's end()
  })
})
