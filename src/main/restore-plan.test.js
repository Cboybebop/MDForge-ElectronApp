// Exhaustive ordering/dedup permutation coverage for composeRestorePlan --
// the phase's single highest-value unit test (06-CONTEXT.md, 06-PATTERNS.md).
// Every case is a pure input/output pair over synthetic data, no Electron
// launch or fs access required, mirroring window-state.test.js's
// `boundsFitOnADisplay` "external-monitor-unplugged" style: name each test
// after the real-world scenario it proves, not just the mechanism.
import { describe, it, expect } from 'vitest'
import { composeRestorePlan } from './restore-plan.js'

// Minimal helper to build a file-backed entry with only the fields a given
// test cares about (the rest of the unified entry shape is irrelevant to
// pure ordering/dedup logic).
function fileEntry (filePath, extra = {}) {
  return { filePath, draftUuid: null, name: filePath, content: '', dirty: false, scrollTop: 0, conflicted: false, source: 'test', ...extra }
}

function untitledEntry (draftUuid, extra = {}) {
  return { filePath: null, draftUuid, name: 'Untitled', content: '', dirty: true, scrollTop: 0, conflicted: false, source: 'test', ...extra }
}

describe('composeRestorePlan', () => {
  it('returns an empty plan when all three inputs are empty', () => {
    expect(composeRestorePlan([], [], [])).toEqual([])
  })

  it('recovery-only: both entries appear, in given order, first', () => {
    const a = fileEntry('C:\\A.md')
    const b = fileEntry('C:\\B.md')
    const plan = composeRestorePlan([a, b], [], [])
    expect(plan).toEqual([a, b])
  })

  it('argv-only: a single entry appears alone', () => {
    const a = fileEntry('C:\\A.md')
    const plan = composeRestorePlan([], [a], [])
    expect(plan).toEqual([a])
  })

  it('session-only: all three entries appear, in given order, preserved among themselves', () => {
    const a = fileEntry('C:\\A.md')
    const b = fileEntry('C:\\B.md')
    const c = fileEntry('C:\\C.md')
    const plan = composeRestorePlan([], [], [a, b, c])
    expect(plan).toEqual([a, b, c])
  })

  it('a path present in BOTH argv and session (identical string) appears exactly once, in the ARGV position', () => {
    const argvCopy = fileEntry('C:\\Doc.md', { source: 'argv' })
    const sessionCopy = fileEntry('C:\\Doc.md', { source: 'session' })
    const plan = composeRestorePlan([], [argvCopy], [sessionCopy])
    expect(plan).toEqual([argvCopy])
  })

  it('a path present in BOTH argv and session with DIFFERING case still dedups as one entry, in the argv position', () => {
    const argvCopy = fileEntry('C:\\Doc.md', { source: 'argv' })
    const sessionCopy = fileEntry('c:\\doc.md', { source: 'session' })
    const plan = composeRestorePlan([], [argvCopy], [sessionCopy])
    expect(plan).toEqual([argvCopy])
  })

  it('a path present in BOTH recovery and argv appears exactly once, in the RECOVERY position', () => {
    const recoveryCopy = fileEntry('C:\\Doc.md', { source: 'recovery' })
    const argvCopy = fileEntry('C:\\Doc.md', { source: 'argv' })
    const plan = composeRestorePlan([recoveryCopy], [argvCopy], [])
    expect(plan).toEqual([recoveryCopy])
  })

  it('a path present in all three sources (recovery + argv + session) appears exactly once, in the recovery position', () => {
    const recoveryCopy = fileEntry('C:\\Doc.md', { source: 'recovery' })
    const argvCopy = fileEntry('C:\\Doc.md', { source: 'argv' })
    const sessionCopy = fileEntry('C:\\Doc.md', { source: 'session' })
    const plan = composeRestorePlan([recoveryCopy], [argvCopy], [sessionCopy])
    expect(plan).toEqual([recoveryCopy])
  })

  it('two untitled entries (filePath: null, draftUuid: null) in the same input array are never collapsed into one', () => {
    const u1 = untitledEntry(null, { name: 'Untitled 1' })
    const u2 = untitledEntry(null, { name: 'Untitled 2' })
    const plan = composeRestorePlan([], [], [u1, u2])
    expect(plan).toHaveLength(2)
    expect(plan).toEqual([u1, u2])
  })

  it('two entries with the SAME draftUuid in both recovery and session dedup to one, in the recovery position', () => {
    const recoveryCopy = untitledEntry('draft-uuid-1', { source: 'recovery' })
    const sessionCopy = untitledEntry('draft-uuid-1', { source: 'session' })
    const plan = composeRestorePlan([recoveryCopy], [], [sessionCopy])
    expect(plan).toEqual([recoveryCopy])
  })

  it('a realistic mixed scenario composes to exactly 3 entries in recovery, argv, session order', () => {
    const recoveryEntry = fileEntry('C:\\Recovered.md', { source: 'recovery' })
    const argvDuplicateOfRecovery = fileEntry('C:\\Recovered.md', { source: 'argv-dup' })
    const argvNew = fileEntry('C:\\ArgvNew.md', { source: 'argv' })
    const sessionDuplicateOfArgv = fileEntry('C:\\ArgvNew.md', { source: 'session-dup' })
    const sessionDuplicateOfRecovery = fileEntry('C:\\Recovered.md', { source: 'session-dup-2' })
    const sessionNew = fileEntry('C:\\SessionNew.md', { source: 'session' })

    const plan = composeRestorePlan(
      [recoveryEntry],
      [argvDuplicateOfRecovery, argvNew],
      [sessionDuplicateOfArgv, sessionDuplicateOfRecovery, sessionNew]
    )

    expect(plan).toEqual([recoveryEntry, argvNew, sessionNew])
  })

  it('does not throw on a malformed entry (neither a usable filePath nor draftUuid) and includes it as-is', () => {
    const malformed = { filePath: 42, draftUuid: undefined, name: 'weird' }
    const plan = composeRestorePlan([], [], [malformed])
    expect(plan).toEqual([malformed])
  })
})
