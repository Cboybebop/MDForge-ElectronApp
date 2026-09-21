// Regression tests for the native file-path validation guard (SHELL-02).
//
// These run under plain Node -- no jsdom, no Electron -- because path-guard.js
// deliberately has no `electron` import. Mirrors url-guard.test.js's shape.
import { describe, it, expect } from 'vitest'
import { isSafeFilePath } from './path-guard.js'

const NUL_BYTE = String.fromCharCode(0)

describe('isSafeFilePath', () => {
  it.each([
    ['C:\\Users\\me\\notes.md', 'ordinary absolute Windows path'],
    ['\\\\server\\share\\team\\notes.md', 'UNC path -- must NOT be rejected'],
    ['C:\\' + 'a'.repeat(300) + '\\notes.md', '>260-character path -- must NOT be rejected'],
    ['/home/me/notes.md', 'ordinary absolute POSIX path']
  ])('permits %s (%s)', (candidate) => {
    expect(isSafeFilePath(candidate)).toBe(true)
  })

  it.each([
    ['C:\\Users\\me\\..\\..\\Windows\\System32\\config\\SAM', 'backslash-form traversal segment'],
    ['../../../etc/passwd', 'forward-slash-form relative traversal'],
    ['C:\\Users\\me\\notes\\..\\..\\SAM', 'traversal segment mid-path']
  ])('rejects %s (%s)', (candidate) => {
    expect(isSafeFilePath(candidate)).toBe(false)
  })

  it('rejects a path containing an embedded NUL byte', () => {
    expect(isSafeFilePath(`C:\\notes${NUL_BYTE}.md`)).toBe(false)
  })

  it.each([[''], [null], [undefined], [42], [{}], [[]]])(
    'fails closed on non-string/empty input %s',
    (candidate) => {
      expect(isSafeFilePath(candidate)).toBe(false)
    }
  )
})
