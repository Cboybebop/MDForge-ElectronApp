// Unit tests for workspace-tree.js's lazy, filtered directory listing
// (WORK-01, WORK-02). Plain vitest, no jsdom -- `electron` is mocked (only
// ipcMain.handle is touched by this module), but listWorkspaceDir runs
// against a genuine fs.mkdtempSync temp directory, matching
// dialogs.test.js's own established shape.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const { listWorkspaceDir } = await import('./workspace-tree.js')

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tree-test-'))

  fs.writeFileSync(path.join(tmpDir, 'notes.md'), '# notes')
  fs.writeFileSync(path.join(tmpDir, 'readme.markdown'), '# readme')
  fs.writeFileSync(path.join(tmpDir, 'ignore-me.txt'), 'not markdown')
  fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=1')

  fs.mkdirSync(path.join(tmpDir, '.git'))
  fs.writeFileSync(path.join(tmpDir, '.git', 'secret.md'), 'should never appear')

  fs.mkdirSync(path.join(tmpDir, 'node_modules'))
  fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.md'), 'should never appear')

  fs.mkdirSync(path.join(tmpDir, 'sub'))
  fs.writeFileSync(path.join(tmpDir, 'sub', 'child.md'), '# child')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('listWorkspaceDir -- WORK-01/WORK-02: filtered, lazy, single-level directory listing', () => {
  it('returns only notes.md, readme.markdown, and the sub directory', async () => {
    const result = await listWorkspaceDir(tmpDir)

    expect(result.error).toBeUndefined()
    const names = result.entries.map((e) => e.name)
    expect(names).toContain('notes.md')
    expect(names).toContain('readme.markdown')
    expect(names).toContain('sub')

    const subEntry = result.entries.find((e) => e.name === 'sub')
    expect(subEntry.type).toBe('dir')
  })

  it('excludes non-markdown files (ignore-me.txt)', async () => {
    const result = await listWorkspaceDir(tmpDir)
    expect(result.entries.map((e) => e.name)).not.toContain('ignore-me.txt')
  })

  it('excludes dotfiles (.env)', async () => {
    const result = await listWorkspaceDir(tmpDir)
    expect(result.entries.map((e) => e.name)).not.toContain('.env')
  })

  it('excludes .git and its contents entirely', async () => {
    const result = await listWorkspaceDir(tmpDir)
    expect(result.entries.map((e) => e.name)).not.toContain('.git')
  })

  it('excludes node_modules and its contents entirely', async () => {
    const result = await listWorkspaceDir(tmpDir)
    expect(result.entries.map((e) => e.name)).not.toContain('node_modules')
  })

  it('does NOT recurse into sub -- child.md is absent from the parent listing', async () => {
    const result = await listWorkspaceDir(tmpDir)
    expect(result.entries.map((e) => e.name)).not.toContain('child.md')
  })

  it('lazily returns child.md when listWorkspaceDir is called directly on sub', async () => {
    const result = await listWorkspaceDir(path.join(tmpDir, 'sub'))
    expect(result.error).toBeUndefined()
    expect(result.entries.map((e) => e.name)).toContain('child.md')
  })

  it('returns {error: {code: EINVALIDPATH}} for a traversal-shaped path, without throwing', async () => {
    // Built via string concatenation, NOT path.join -- path.join normalizes
    // '..' segments away, which would defeat this test (isSafeFilePath
    // checks for a literal '..' segment pre-normalization).
    const traversalPath = tmpDir + '\\..\\..\\evil'
    await expect(listWorkspaceDir(traversalPath)).resolves.toMatchObject({
      error: { code: 'EINVALIDPATH' }
    })
  })

  it('returns {error: {code: ENOENT}} for a nonexistent directory, without throwing', async () => {
    const nonexistent = path.join(tmpDir, 'does-not-exist')
    await expect(listWorkspaceDir(nonexistent)).resolves.toMatchObject({
      error: { code: 'ENOENT' }
    })
  })
})
