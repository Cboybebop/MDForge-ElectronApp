// Lazy, filtered directory-listing service for the sidebar workspace tree
// (WORK-01, WORK-02). This module owns the ONLY fs.readdir call site for the
// workspace tree -- every invocation reads exactly one directory's immediate
// children, never recursing into a subdirectory's own contents. Lazy
// expansion is real, not cosmetic: a repository with a deep tree must not
// stall the app at folder-open time (07-CONTEXT.md).
//
// Follows text-file.js's readTextFile shape exactly: validate with
// isSafeFilePath, perform the fs op inside a try/catch that never lets a
// rejection escape, and return a structured {error: {message, code}} result
// on any failure instead of throwing across the IPC boundary.
//
// The ignore set (dotfiles/dot-directories, node_modules, .git) and the
// file-extension allowlist (.md/.markdown only) are both fixed and NOT
// user-configurable in v1, per 07-CONTEXT.md's locked decision -- this app
// browses Markdown, it is not a general file manager.
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { ipcMain } from 'electron'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { isSafeFilePath } from './path-guard.js'

const IGNORED_NAMES = new Set(['node_modules', '.git'])
const ALLOWED_FILE_EXTENSIONS = new Set(['.md', '.markdown'])

function isIgnoredName (name) {
  return name.startsWith('.') || IGNORED_NAMES.has(name)
}

/**
 * Classifies a single dirent as 'dir' or 'file', falling back to a per-entry
 * fs.stat() ONLY when the dirent's own type is ambiguous (Pitfall 4: some
 * filesystems -- notably network shares -- do not populate d_type, so
 * isFile()/isDirectory() can both report false for a real, existing entry).
 * Never performs a blanket stat sweep -- that would defeat the point of
 * lazy expansion.
 */
async function classifyDirent (dirent, entryPath) {
  if (dirent.isDirectory()) return 'dir'
  if (dirent.isFile()) return 'file'

  try {
    const stat = await fsPromises.stat(entryPath)
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
  } catch {
    // Entry vanished between readdir and stat, or is some other special
    // file (socket, device, etc.) -- treat as neither, drop it below.
  }
  return null
}

/**
 * Lists the immediate children of `dirPath`: directories (except
 * node_modules/.git/dot-directories) and .md/.markdown files (dotfiles and
 * every other extension excluded). Never recurses into a child directory's
 * own contents -- each call reads exactly one directory level.
 *
 * Returns {entries: [{name, type: 'dir'|'file'}, ...]} sorted
 * directories-first, then case-insensitive alphabetical within each group.
 * Returns {error: {message, code}} on an unsafe path or any thrown fs
 * error -- never throws.
 */
async function listWorkspaceDir (dirPath) {
  if (!isSafeFilePath(dirPath)) {
    return { error: { message: `Refusing to list unsafe path: ${dirPath}`, code: 'EINVALIDPATH' } }
  }

  let dirents
  try {
    dirents = await fsPromises.readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    // Intentional catch: converts a thrown fs error into a returned error
    // object rather than an unhandled rejection -- same discipline as
    // text-file.js's readTextFile.
    return { error: { message: err.message, code: err.code } }
  }

  const entries = []
  for (const dirent of dirents) {
    if (isIgnoredName(dirent.name)) continue

    const entryPath = path.join(dirPath, dirent.name)
    const type = await classifyDirent(dirent, entryPath)

    if (type === 'dir') {
      entries.push({ name: dirent.name, type: 'dir' })
    } else if (type === 'file') {
      const ext = path.extname(dirent.name).toLowerCase()
      if (ALLOWED_FILE_EXTENSIONS.has(ext)) {
        entries.push({ name: dirent.name, type: 'file' })
      }
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return { entries }
}

function registerWorkspaceTreeIpc () {
  ipcMain.handle('workspace:list-dir', (_event, dirPath) => listWorkspaceDir(dirPath))
}

export { listWorkspaceDir, registerWorkspaceTreeIpc }
