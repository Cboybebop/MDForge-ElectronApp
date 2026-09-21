// Plain Node, no jsdom -- splice.js is pure string arithmetic with no DOM
// import (same rationale as src/main/url-guard.test.js).
import { describe, it, expect } from 'vitest'
import { spliceByRange } from './splice.js'

describe('spliceByRange', () => {
  it('replaces an exact source-offset range', () => {
    expect(spliceByRange('abcdef', 2, 4, 'XY')).toBe('abXYef')
  })

  it('performs a pure insertion with no deletion at a zero-length range', () => {
    expect(spliceByRange('abcdef', 3, 3, 'XY')).toBe('abcXYdef')
  })

  it('replaces a range at the very start of the string', () => {
    expect(spliceByRange('abcdef', 0, 2, 'XY')).toBe('XYcdef')
  })

  it('replaces a range at the very end of the string', () => {
    expect(spliceByRange('abcdef', 4, 6, 'XY')).toBe('abcdXY')
  })

  it('replaces the entire string when the range spans it', () => {
    expect(spliceByRange('abcdef', 0, 6, 'XY')).toBe('XY')
  })

  it('deletes a range with no replacement when given an empty string', () => {
    expect(spliceByRange('abcdef', 2, 4, '')).toBe('abef')
  })
})
