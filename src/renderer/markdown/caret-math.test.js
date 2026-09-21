// Plain Node, no jsdom -- caret-math.js is pure numeric arithmetic with no
// DOM import (same rationale as splice.test.js).
import { describe, it, expect } from 'vitest'
import { computeShiftedOffset } from './caret-math.js'

describe('computeShiftedOffset', () => {
  it('leaves an offset strictly before rangeStart unchanged', () => {
    expect(computeShiftedOffset(2, { rangeStart: 5, rangeEnd: 10, replacementLength: 3 })).toBe(2)
  })

  it('leaves an offset exactly at rangeStart unchanged (boundary)', () => {
    expect(computeShiftedOffset(5, { rangeStart: 5, rangeEnd: 10, replacementLength: 3 })).toBe(5)
  })

  it('shifts an offset exactly at rangeEnd by the delta', () => {
    // delta = replacementLength - (rangeEnd - rangeStart) = 3 - 5 = -2
    expect(computeShiftedOffset(10, { rangeStart: 5, rangeEnd: 10, replacementLength: 3 })).toBe(8)
  })

  it('shifts an offset after rangeEnd by the delta', () => {
    expect(computeShiftedOffset(20, { rangeStart: 5, rangeEnd: 10, replacementLength: 3 })).toBe(18)
  })

  it('collapses an offset strictly inside the range to rangeStart + replacementLength', () => {
    expect(computeShiftedOffset(7, { rangeStart: 5, rangeEnd: 10, replacementLength: 3 })).toBe(8)
  })

  it('produces a correct positive shift for a replacement LONGER than the original range (net insertion)', () => {
    // range [5,10) (length 5) replaced by a 12-char string -> delta = +7
    const opts = { rangeStart: 5, rangeEnd: 10, replacementLength: 12 }
    expect(computeShiftedOffset(10, opts)).toBe(17)
    expect(computeShiftedOffset(20, opts)).toBe(27)
  })

  it('produces a correct negative shift for a replacement SHORTER than the original range (net deletion)', () => {
    // range [5,10) (length 5) replaced by a 1-char string -> delta = -4
    const opts = { rangeStart: 5, rangeEnd: 10, replacementLength: 1 }
    expect(computeShiftedOffset(10, opts)).toBe(6)
    expect(computeShiftedOffset(20, opts)).toBe(16)
  })

  it('handles a zero-length range (pure insertion): the boundary offset itself is unchanged, but anything after shifts by the full inserted length', () => {
    // range [5,5) (length 0) replaced by a 4-char string -> delta = +4.
    // offset === rangeStart (5) hits rule 1 (offset <= rangeStart) first,
    // per the mandated priority order, and is left unchanged.
    const opts = { rangeStart: 5, rangeEnd: 5, replacementLength: 4 }
    expect(computeShiftedOffset(5, opts)).toBe(5)
    expect(computeShiftedOffset(6, opts)).toBe(10)
    expect(computeShiftedOffset(20, opts)).toBe(24)
  })
})
