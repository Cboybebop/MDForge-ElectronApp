// Regression tests for the atomic, Windows-safe write primitive (SHELL-03/04).
//
// `node:fs/promises` is mocked so real failures (EPERM/EBUSY/EACCES/ENOSPC)
// can be injected into the rename step deterministically -- these run under
// plain Node, no jsdom, no Electron, matching path-guard/url-guard's shape.
// By default every mocked function delegates to the REAL implementation
// (via vi.importActual), so tests that don't override a specific function
// still exercise genuine filesystem behaviour (real temp files, real
// fsync, real rename) -- only the specific failure-injection tests below
// override `rename` to simulate the Windows lock conditions PITFALLS.md
// documents. This is why the "real content round-trips" test at the top
// needs no override: it is a real integration test, not a stubbed one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const real = await vi.importActual('node:fs/promises')

const { openMock, renameMock, unlinkMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  renameMock: vi.fn(),
  unlinkMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: {
    open: (...args) => openMock(...args),
    rename: (...args) => renameMock(...args),
    unlink: (...args) => unlinkMock(...args)
  }
}))

const { atomicWrite } = await import('./atomic-write.js')

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'))
  // Default: delegate every mocked call to the real implementation, so a
  // test that overrides nothing still performs genuine fs operations.
  openMock.mockImplementation((...args) => real.open(...args))
  renameMock.mockImplementation((...args) => real.rename(...args))
  unlinkMock.mockImplementation((...args) => real.unlink(...args))
})

afterEach(() => {
  vi.clearAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('atomicWrite -- real filesystem round trip', () => {
  it('writes string content and the target file matches exactly', async () => {
    const target = path.join(tmpDir, 'notes.md')
    await atomicWrite(target, '# Hello\n\nSome content.\n')
    expect(fs.readFileSync(target, 'utf8')).toBe('# Hello\n\nSome content.\n')
  })

  it('writes Buffer content byte-for-byte', async () => {
    const target = path.join(tmpDir, 'notes-buffer.md')
    const buffer = Buffer.from([0x23, 0x20, 0x48, 0x69, 0x0a]) // "# Hi\n"
    await atomicWrite(target, buffer)
    expect(fs.readFileSync(target)).toEqual(buffer)
  })

  it('leaves no leftover temp file after a successful write', async () => {
    const target = path.join(tmpDir, 'notes-clean.md')
    await atomicWrite(target, 'content')
    const entries = fs.readdirSync(tmpDir)
    expect(entries).toEqual(['notes-clean.md'])
  })
})

describe('atomicWrite -- temp file placement and naming', () => {
  // IN-01 (04-REVIEW.md): the temp name now carries a random suffix in
  // addition to <pid>, so this asserts the SHAPE via regex rather than the
  // single exact literal `notes.md.<pid>.tmp` the naming scheme used before
  // that fix -- a legitimate, intentional change to this expectation (see
  // the dedicated IN-01 describe block below for why).
  it('uses a same-directory temp path matching <name>.<pid>.<random>.tmp', async () => {
    const target = path.join(tmpDir, 'notes.md')
    await atomicWrite(target, 'content')

    const [openTempPath] = openMock.mock.calls[0]
    const [renameTempPath, renameTargetPath] = renameMock.mock.calls[0]

    expect(path.dirname(openTempPath)).toBe(path.dirname(target))
    expect(path.dirname(renameTempPath)).toBe(path.dirname(target))
    expect(renameTargetPath).toBe(target)
    expect(path.basename(openTempPath)).toMatch(new RegExp(`^notes\\.md\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`))
    expect(openTempPath).toBe(renameTempPath)
  })

  it('never opens or writes to the real target path -- only the temp path', async () => {
    const target = path.join(tmpDir, 'notes.md')
    await atomicWrite(target, 'content')

    expect(openMock).toHaveBeenCalledTimes(1)
    expect(openMock.mock.calls[0][0]).not.toBe(target)
  })
})

describe('atomicWrite -- fsync-before-close-before-rename ordering', () => {
  it('calls sync() before close(), and both before rename', async () => {
    const order = []
    const fakeHandle = {
      writeFile: vi.fn(async () => order.push('writeFile')),
      sync: vi.fn(async () => order.push('sync')),
      close: vi.fn(async () => order.push('close'))
    }
    openMock.mockImplementation(async () => fakeHandle)
    renameMock.mockImplementation(async () => {
      order.push('rename')
    })

    await atomicWrite(path.join(tmpDir, 'notes.md'), 'content')

    expect(order).toEqual(['writeFile', 'sync', 'close', 'rename'])
    expect(fakeHandle.sync).toHaveBeenCalledTimes(1)
    expect(fakeHandle.close).toHaveBeenCalledTimes(1)
  })
})

describe('atomicWrite -- IN-01: temp file naming is non-deterministic per call, not just per process+target', () => {
  it('uses a DIFFERENT temp filename for two overlapping writes to the SAME target from the SAME process', async () => {
    const target = path.join(tmpDir, 'notes.md')

    // <pid> alone is identical for both calls (same process, same target) --
    // before this fix, both writes would have raced on the literal SAME
    // temp filename. Drive both calls concurrently (not sequentially) so
    // both temp paths are captured before either completes.
    const [firstResult, secondResult] = await Promise.allSettled([
      atomicWrite(target, 'first writer'),
      atomicWrite(target, 'second writer')
    ])
    expect(firstResult.status).toBe('fulfilled')
    expect(secondResult.status).toBe('fulfilled')

    const tempPathsUsed = openMock.mock.calls.map(([tempPath]) => tempPath)
    expect(tempPathsUsed).toHaveLength(2)
    expect(tempPathsUsed[0]).not.toBe(tempPathsUsed[1])
    expect(path.basename(tempPathsUsed[0])).toMatch(new RegExp(`^notes\\.md\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`))
    expect(path.basename(tempPathsUsed[1])).toMatch(new RegExp(`^notes\\.md\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`))
  })
})

describe('atomicWrite -- WR-01: temp file cleanup when the write phase itself fails', () => {
  it('cleans up the temp file and propagates the original error when handle.writeFile() throws, never reaching rename', async () => {
    const target = path.join(tmpDir, 'notes.md')
    const fakeHandle = {
      writeFile: vi.fn(async () => {
        const err = new Error('write ENOSPC')
        err.code = 'ENOSPC'
        throw err
      }),
      sync: vi.fn(),
      close: vi.fn(async () => {})
    }
    openMock.mockImplementation(async () => fakeHandle)

    await expect(atomicWrite(target, 'content')).rejects.toMatchObject({ code: 'ENOSPC' })

    expect(fakeHandle.close).toHaveBeenCalledTimes(1)
    expect(fakeHandle.sync).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
    expect(unlinkMock).toHaveBeenCalledTimes(1)
    expect(unlinkMock.mock.calls[0][0]).toBe(openMock.mock.calls[0][0]) // the temp path
    // No orphan temp file left behind in the target directory.
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('cleans up the temp file and propagates the original error when handle.sync() throws, never reaching rename', async () => {
    const target = path.join(tmpDir, 'notes.md')
    const fakeHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {
        const err = new Error('sync EIO')
        err.code = 'EIO'
        throw err
      }),
      close: vi.fn(async () => {})
    }
    openMock.mockImplementation(async () => fakeHandle)

    await expect(atomicWrite(target, 'content')).rejects.toMatchObject({ code: 'EIO' })

    expect(fakeHandle.writeFile).toHaveBeenCalledTimes(1)
    expect(fakeHandle.close).toHaveBeenCalledTimes(1)
    expect(renameMock).not.toHaveBeenCalled()
    expect(unlinkMock).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('does not mask the original write error even if the cleanup unlink itself fails', async () => {
    const target = path.join(tmpDir, 'notes.md')
    const fakeHandle = {
      writeFile: vi.fn(async () => {
        const err = new Error('write ENOSPC')
        err.code = 'ENOSPC'
        throw err
      }),
      sync: vi.fn(),
      close: vi.fn(async () => {})
    }
    openMock.mockImplementation(async () => fakeHandle)
    unlinkMock.mockImplementation(async () => {
      throw new Error('unlink also failed -- must not surface instead of the real error')
    })

    let caught
    try {
      await atomicWrite(target, 'content')
    } catch (err) {
      caught = err
    }

    expect(caught.code).toBe('ENOSPC')
    expect(caught.message).toBe('write ENOSPC')
  })
})

describe('atomicWrite -- WR-02: optional precheck immediately before rename', () => {
  it('never invokes rename and cleans up the temp file when precheck reports a conflict', async () => {
    const target = path.join(tmpDir, 'notes.md')
    const precheck = vi.fn(async () => ({ actual: { mtimeMs: 123, size: 456 } }))

    await expect(atomicWrite(target, 'content', { precheck })).rejects.toMatchObject({
      code: 'ECONFLICT',
      conflict: { actual: { mtimeMs: 123, size: 456 } }
    })

    expect(precheck).toHaveBeenCalledTimes(1)
    expect(renameMock).not.toHaveBeenCalled()
    expect(unlinkMock).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('proceeds to rename normally when precheck resolves to a falsy value', async () => {
    const target = path.join(tmpDir, 'notes.md')
    const precheck = vi.fn(async () => null)

    await atomicWrite(target, 'content', { precheck })

    expect(precheck).toHaveBeenCalledTimes(1)
    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(target, 'utf8')).toBe('content')
  })

  it('is invoked AFTER the temp file is written and fsynced, but BEFORE rename -- the narrowest point this module can check', async () => {
    const order = []
    const target = path.join(tmpDir, 'notes.md')
    const fakeHandle = {
      writeFile: vi.fn(async () => order.push('writeFile')),
      sync: vi.fn(async () => order.push('sync')),
      close: vi.fn(async () => order.push('close'))
    }
    openMock.mockImplementation(async () => fakeHandle)
    renameMock.mockImplementation(async () => order.push('rename'))
    const precheck = vi.fn(async () => { order.push('precheck'); return null })

    await atomicWrite(target, 'content', { precheck })

    expect(order).toEqual(['writeFile', 'sync', 'close', 'precheck', 'rename'])
  })

  it('skips the precheck call entirely when none is supplied (default behaviour unchanged)', async () => {
    const target = path.join(tmpDir, 'notes.md')
    await atomicWrite(target, 'content')
    expect(fs.readFileSync(target, 'utf8')).toBe('content')
  })
})

describe('atomicWrite -- retry-with-backoff on transient Windows lock errors', () => {
  it('retries on EPERM and succeeds once a later attempt succeeds', async () => {
    let calls = 0
    renameMock.mockImplementation(async (...args) => {
      calls++
      if (calls <= 3) {
        const err = new Error('rename EPERM')
        err.code = 'EPERM'
        throw err
      }
      return real.rename(...args)
    })

    const target = path.join(tmpDir, 'notes.md')
    await expect(atomicWrite(target, 'content')).resolves.toBeUndefined()

    expect(renameMock).toHaveBeenCalledTimes(4)
    expect(fs.readFileSync(target, 'utf8')).toBe('content')
  })

  it('retries on EBUSY across all 5 attempts, then fails leaving the original untouched', async () => {
    const target = path.join(tmpDir, 'notes.md')
    fs.writeFileSync(target, 'original content')

    renameMock.mockImplementation(async () => {
      const err = new Error('rename EBUSY')
      err.code = 'EBUSY'
      throw err
    })

    await expect(atomicWrite(target, 'new content')).rejects.toMatchObject({ code: 'EBUSY' })

    expect(renameMock).toHaveBeenCalledTimes(5)
    expect(unlinkMock).toHaveBeenCalledTimes(1)
    expect(unlinkMock.mock.calls[0][0]).toBe(openMock.mock.calls[0][0]) // the temp path
    // The original file must be provably untouched.
    expect(fs.readFileSync(target, 'utf8')).toBe('original content')
    // The temp file must be cleaned up, not left behind.
    expect(fs.readdirSync(tmpDir)).toEqual(['notes.md'])
  })

  it('surfaces the errno on exhaustion via err.code and err.cause', async () => {
    renameMock.mockImplementation(async () => {
      const err = new Error('rename EACCES')
      err.code = 'EACCES'
      throw err
    })

    let caught
    try {
      await atomicWrite(path.join(tmpDir, 'notes.md'), 'content')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught.code).toBe('EACCES')
    expect(caught.cause).toBeInstanceOf(Error)
    expect(caught.cause.code).toBe('EACCES')
    expect(caught.message).toMatch(/locked by another process/i)
  })

  it('does not retry a non-retryable error code -- fails after exactly one attempt', async () => {
    renameMock.mockImplementation(async () => {
      const err = new Error('rename ENOSPC')
      err.code = 'ENOSPC'
      throw err
    })

    await expect(atomicWrite(path.join(tmpDir, 'notes.md'), 'content')).rejects.toMatchObject({
      code: 'ENOSPC'
    })
    expect(renameMock).toHaveBeenCalledTimes(1)
  })
})
