// Regression tests for the crash-safe draft-journal storage primitive
// (PERS-01, PERS-02, PERS-03).
//
// `node:fs/promises` is mocked so injected failures (a corrupt sidecar, a
// missing original file) can be exercised deterministically, but every
// mocked function defaults to the REAL implementation (via
// vi.importActual), so any test that doesn't override a specific function
// still exercises genuine filesystem behaviour against a real
// fs.mkdtempSync() tmpDir -- mirrors atomic-write.test.js's own
// mock-with-real-passthrough-default idiom (06-PATTERNS.md).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const real = await vi.importActual('node:fs/promises')

const { readdirMock, mkdirMock, statMock, unlinkMock, readFileMock, writeFileMock, openMock, renameMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  mkdirMock: vi.fn(),
  statMock: vi.fn(),
  unlinkMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  openMock: vi.fn(),
  renameMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: (...args) => readdirMock(...args),
    mkdir: (...args) => mkdirMock(...args),
    stat: (...args) => statMock(...args),
    unlink: (...args) => unlinkMock(...args),
    readFile: (...args) => readFileMock(...args),
    writeFile: (...args) => writeFileMock(...args),
    open: (...args) => openMock(...args),
    rename: (...args) => renameMock(...args)
  }
}))

const {
  ensureDraftsDirExists,
  scanDraftsDir,
  writeDraft,
  deleteDraft,
  sweepAllDrafts,
  registerDraftsIpc
} = await import('./drafts-store.js')
const { ipcMain } = await import('electron')

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-store-test-'))
  // Default: delegate every mocked call to the real implementation, so a
  // test that overrides nothing still performs genuine fs operations.
  readdirMock.mockImplementation((...args) => real.readdir(...args))
  mkdirMock.mockImplementation((...args) => real.mkdir(...args))
  statMock.mockImplementation((...args) => real.stat(...args))
  unlinkMock.mockImplementation((...args) => real.unlink(...args))
  readFileMock.mockImplementation((...args) => real.readFile(...args))
  writeFileMock.mockImplementation((...args) => real.writeFile(...args))
  openMock.mockImplementation((...args) => real.open(...args))
  renameMock.mockImplementation((...args) => real.rename(...args))
})

afterEach(() => {
  vi.clearAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ensureDraftsDirExists', () => {
  it('creates a nested, previously-nonexistent directory', async () => {
    const draftsDir = path.join(tmpDir, 'nested', 'drafts')
    expect(fs.existsSync(draftsDir)).toBe(false)

    await ensureDraftsDirExists(draftsDir)

    expect(fs.existsSync(draftsDir)).toBe(true)
  })
})

describe('writeDraft -- real filesystem round trip', () => {
  it('writes a real <uuid>.md/<uuid>.json pair that reads back byte-for-byte', async () => {
    const draftsDir = tmpDir
    const uuid = 'a1b2c3d4-e5f6-4789-9abc-def012345678'
    const content = '# Hello\n\nSome draft content.\n'

    await writeDraft(draftsDir, uuid, content, { filePath: null, name: 'Untitled' })

    const readContent = fs.readFileSync(path.join(draftsDir, `${uuid}.md`), 'utf8')
    expect(readContent).toBe(content)

    const meta = JSON.parse(fs.readFileSync(path.join(draftsDir, `${uuid}.json`), 'utf8'))
    expect(meta).toMatchObject({ uuid, filePath: null, name: 'Untitled', originalStat: null })
    expect(typeof meta.writtenAt).toBe('number')
  })

  it('records originalStat against a real, existing meta.filePath', async () => {
    const draftsDir = tmpDir
    const originalFile = path.join(tmpDir, 'real-doc.md')
    fs.writeFileSync(originalFile, 'original content')
    const uuid = 'b2c3d4e5-f6a7-4890-abcd-ef0123456789'

    await writeDraft(draftsDir, uuid, 'draft body', { filePath: originalFile, name: 'real-doc.md' })

    const meta = JSON.parse(fs.readFileSync(path.join(draftsDir, `${uuid}.json`), 'utf8'))
    expect(meta.originalStat).not.toBeNull()
    expect(typeof meta.originalStat.mtimeMs).toBe('number')
    expect(typeof meta.originalStat.size).toBe('number')
  })

  it('records originalStat: null when meta.filePath does not exist on disk (no thrown error)', async () => {
    const draftsDir = tmpDir
    const uuid = 'c3d4e5f6-a7b8-4901-bcde-f01234567890'
    const missingPath = path.join(tmpDir, 'does-not-exist.md')

    await expect(
      writeDraft(draftsDir, uuid, 'draft body', { filePath: missingPath, name: 'does-not-exist.md' })
    ).resolves.toBeUndefined()

    const meta = JSON.parse(fs.readFileSync(path.join(draftsDir, `${uuid}.json`), 'utf8'))
    expect(meta.originalStat).toBeNull()
  })
})

describe('scanDraftsDir -- orphan and corruption hygiene', () => {
  it('excludes a real orphaned .tmp file from its valid set AND deletes it from disk', async () => {
    const draftsDir = tmpDir
    const tmpFile = path.join(draftsDir, 'notes.md.1234.deadbeef.tmp')
    fs.writeFileSync(tmpFile, 'leftover partial write')

    const result = await scanDraftsDir(draftsDir)

    expect(result.valid).toHaveLength(0)
    expect(fs.existsSync(tmpFile)).toBe(false)
  })

  it('excludes a uuid with only a .md half present (no matching .json) and increments corruptCount', async () => {
    const draftsDir = tmpDir
    const uuid = 'd4e5f6a7-b8c9-4012-cdef-012345678901'
    fs.writeFileSync(path.join(draftsDir, `${uuid}.md`), 'body with no sidecar')

    const result = await scanDraftsDir(draftsDir)

    expect(result.valid.find((d) => d.uuid === uuid)).toBeUndefined()
    expect(result.corruptCount).toBe(1)
  })

  it('excludes a uuid whose .json is unparsable garbage text, increments corruptCount, and does not throw', async () => {
    const draftsDir = tmpDir
    const uuid = 'e5f6a7b8-c9d0-4123-defa-123456789012'
    fs.writeFileSync(path.join(draftsDir, `${uuid}.md`), 'body content')
    fs.writeFileSync(path.join(draftsDir, `${uuid}.json`), 'not valid json {{{')

    const result = await scanDraftsDir(draftsDir)

    expect(result.valid.find((d) => d.uuid === uuid)).toBeUndefined()
    expect(result.corruptCount).toBe(1)
  })

  it('returns a valid draft with its content and meta intact for a genuine pair', async () => {
    const draftsDir = tmpDir
    const uuid = 'f6a7b8c9-d0e1-4234-efab-234567890123'
    await writeDraft(draftsDir, uuid, 'real draft body', { filePath: null, name: 'My Doc' })

    const result = await scanDraftsDir(draftsDir)

    expect(result.corruptCount).toBe(0)
    expect(result.valid).toHaveLength(1)
    expect(result.valid[0]).toMatchObject({ uuid, content: 'real draft body', name: 'My Doc', filePath: null })
  })

  it('never throws when draftsDir does not exist', async () => {
    const missingDir = path.join(tmpDir, 'never-created')
    await expect(scanDraftsDir(missingDir)).resolves.toEqual({ valid: [], corruptCount: 0 })
  })
})

describe('deleteDraft', () => {
  it('is a no-op on a uuid that was never written -- does not throw', async () => {
    const draftsDir = tmpDir
    await expect(deleteDraft(draftsDir, 'never-written-uuid')).resolves.toBeUndefined()
  })

  it('removes both halves of a real pair from disk', async () => {
    const draftsDir = tmpDir
    const uuid = 'a7b8c9d0-e1f2-4345-fabc-345678901234'
    await writeDraft(draftsDir, uuid, 'body', { filePath: null, name: 'Doc' })

    await deleteDraft(draftsDir, uuid)

    expect(fs.existsSync(path.join(draftsDir, `${uuid}.md`))).toBe(false)
    expect(fs.existsSync(path.join(draftsDir, `${uuid}.json`))).toBe(false)
  })
})

describe('sweepAllDrafts', () => {
  it('deletes every currently-valid draft pair, leaving zero valid drafts', async () => {
    const draftsDir = tmpDir
    await writeDraft(draftsDir, 'b8c9d0e1-f2a3-4456-abcd-456789012345', 'body1', { filePath: null, name: 'Doc1' })
    await writeDraft(draftsDir, 'c9d0e1f2-a3b4-4567-bcde-567890123456', 'body2', { filePath: null, name: 'Doc2' })

    await sweepAllDrafts(draftsDir)

    const result = await scanDraftsDir(draftsDir)
    expect(result.valid).toHaveLength(0)
  })

  it('leaves a stray corrupt half-pair untouched -- sweep only touches uuids reported as valid', async () => {
    const draftsDir = tmpDir
    const corruptUuid = 'd0e1f2a3-b4c5-4678-cdef-678901234567'
    fs.writeFileSync(path.join(draftsDir, `${corruptUuid}.md`), 'orphan half, no sidecar')

    await sweepAllDrafts(draftsDir)

    expect(fs.existsSync(path.join(draftsDir, `${corruptUuid}.md`))).toBe(true)
  })
})

// [CR-02, 06-REVIEW.md] registerDraftsIpc's own handlers are the actual
// trust boundary -- writeDraft()/deleteDraft() themselves have never
// validated their uuid argument (by design: composeRestorePlan/scanDraftsDir
// already only ever pass a real, main-generated uuid to them directly).
// These tests exercise the REGISTERED ipcMain.handle callbacks exactly as
// Electron would invoke them, with a genuinely adversarial, traversal-shaped
// uuid, proving the path-traversal gap CR-02 identified is now closed at
// the handler level.
describe('registerDraftsIpc -- CR-02 path-traversal gate', () => {
  function getHandler (channel) {
    const call = ipcMain.handle.mock.calls.find((c) => c[0] === channel)
    if (!call) throw new Error(`no ipcMain.handle registered for "${channel}"`)
    return call[1]
  }

  beforeEach(() => {
    ipcMain.handle.mockClear()
    registerDraftsIpc(tmpDir)
  })

  it('draft:write REJECTS a traversal-shaped uuid rather than silently substituting a fresh one', async () => {
    const handler = getHandler('draft:write')
    const traversalUuid = '../../../../Users/Public/evil'

    await expect(handler({}, traversalUuid, 'malicious content', {})).rejects.toThrow()

    // Confirms the rejection happened BEFORE any write -- no file escaped
    // draftsDir, and nothing landed inside it either.
    expect(fs.existsSync(path.join(tmpDir, '..', '..', '..', '..', 'Users', 'Public', 'evil.md'))).toBe(false)
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('draft:delete REJECTS a traversal-shaped uuid rather than silently no-op-ing on an unsafe path', async () => {
    const handler = getHandler('draft:delete')
    const traversalUuid = '..\\..\\..\\..\\Users\\Public\\evil'

    await expect(handler({}, traversalUuid)).rejects.toThrow()
  })

  it('draft:write ACCEPTS a well-formed uuid and reuses it verbatim (the legitimate repeat-write case)', async () => {
    const handler = getHandler('draft:write')
    const uuid = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

    const result = await handler({}, uuid, 'real content', { filePath: null, name: 'Doc' })

    expect(result).toEqual({ uuid })
    expect(fs.existsSync(path.join(tmpDir, `${uuid}.md`))).toBe(true)
  })

  it('draft:write with NO uuid (first write) still falls back to a freshly main-generated one', async () => {
    const handler = getHandler('draft:write')

    const result = await handler({}, null, 'real content', { filePath: null, name: 'Doc' })

    expect(typeof result.uuid).toBe('string')
    expect(fs.existsSync(path.join(tmpDir, `${result.uuid}.md`))).toBe(true)
  })

  it('draft:delete ACCEPTS a well-formed uuid and deletes the real pair', async () => {
    const uuid = 'f1e2d3c4-b5a6-4978-8cba-fed210987654'
    await writeDraft(tmpDir, uuid, 'body', { filePath: null, name: 'Doc' })
    const handler = getHandler('draft:delete')

    await handler({}, uuid)

    expect(fs.existsSync(path.join(tmpDir, `${uuid}.md`))).toBe(false)
  })
})
