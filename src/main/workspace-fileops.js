// Create/rename/delete file-operations surface for the sidebar tree
// (WORK-03) -- the one and only path through which the tree can mutate the
// filesystem. Every operation validates BOTH axes before any path.join():
// the parent-directory/target path via path-guard.js's isSafeFilePath (an
// existing, established validator) and, for create/rename, the bare
// filename via this file's own new isSafeFileName validator.
//
// isSafeFileName is a genuinely new validation surface (07-RESEARCH.md
// Pitfall 6): every prior phase's path-crossing-IPC case was already a full
// path validated by isSafeFilePath, which validates a full path for
// traversal/NUL bytes and deliberately does NOT reject a bare filename like
// `con.md`, `a/b.md`, or `file<>.md` -- that is not its job. This is the
// first phase to accept an untrusted bare filename (New File / Rename
// input), so it needs its own, narrower validator. Reproduces
// 07-RESEARCH.md's Code Examples section verbatim -- there is no existing
// in-repo analog to adapt (07-PATTERNS.md "No Analog Found").
//
// Delete delegates directly to trash.js's trashWorkspaceFile -- this file
// contains NO other filesystem-mutating call for delete, and
// scripts/check-trash-not-unlink.mjs (Task 3) structurally enforces that
// no permanent-delete filesystem call ever appears in this file.
//
// "New File" writes use atomic-write.js's atomicWrite, never a bare
// fs.writeFile (07-RESEARCH.md Don't Hand-Roll table) -- the same
// OneDrive/Defender-lock hazard atomic-write.js exists to close applies
// equally to a brand-new empty file.
//
// Mirrors drafts-store.js's validate-before-path.join discipline and
// text-file.js's/dialogs.js's never-throw structured {ok, error} result
// shape (07-PATTERNS.md pattern assignment for this file).
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { ipcMain } from 'electron'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from './atomic-write.js'
import { isSafeFilePath } from './path-guard.js'
import { trashWorkspaceFile } from './trash.js'
import { recordStat } from './text-file.js'

// Source: NTFS reserved-name list per longstanding, stable Windows
// filesystem behavior -- 07-RESEARCH.md's own Code Examples section,
// reproduced verbatim (no prior equivalent exists in this codebase).
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
])

/**
 * True only when `name` is safe to use as a bare filename for a New
 * File/Rename operation -- a non-empty string containing no path separator
 * (`/` or `\`), none of the NTFS-illegal characters `<>:"|?*`, no trailing
 * space or period, and not a case-insensitive match (with or without an
 * extension) against an NTFS-reserved device name. Distinct from, and used
 * IN ADDITION TO (never instead of), isSafeFilePath -- see this file's
 * header comment.
 */
export function isSafeFileName (name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (/[\\/<>:"|?*]/.test(name)) return false
  if (/[ .]$/.test(name)) return false // trailing space/period -- illegal on NTFS
  const stem = name.split('.')[0].toUpperCase()
  if (RESERVED_NAMES.has(stem)) return false
  return true
}

/**
 * Returns true if `targetPath` already exists (file or directory), false if
 * it does not. Any other stat failure is treated as "does not exist" -- this
 * is a pure existence probe, not a general-purpose stat call.
 */
async function pathExists (targetPath) {
  try {
    await fsPromises.stat(targetPath)
    return true
  } catch {
    return false
  }
}

// 07-12, data-loss finding from the v1.0 milestone integration audit,
// confirmed reproducible: WORK-07's self-write-suppression mechanism
// (workspace-watcher.js's classifyWatcherEvent, comparing a fresh stat
// against text-file.js's recorded-stat map) only ever discards a watcher
// event when a stat has been RECORDED for that exact path. Every prior
// writer of a workspace path recorded one -- text-file.js's own save path
// (writeTextFileChecked) and dialogs.js's Keep Mine handshake
// (workspace:acknowledge-external-change) both call text-file.js's
// recordStat after their write -- but this file's create/rename never did,
// for either the brand-new path (createWorkspaceFile) or the renamed
// destination path (renameWorkspaceEntry). The gap: an OS rename produces
// unlink(old) + add(new); tree-edit.js's commit() already re-points the
// open document's filePath to the NEW path before that 'add' event's async
// classification runs, so classifyWatcherEvent finds no recorded stat,
// classifies it 'external-change', and reconcile.js's handleExternalChange
// finds -- and, for a dirty tab, banners -- the very document whose own
// in-app rename produced the event. Reproduced end to end in
// tests/e2e/workspace-rename-dirty-tab.spec.js before this fix landed.
//
// Fixed at this layer (shape (a) of the two the audit proposed), not in
// tree-edit.js calling acknowledgeExternalChange after the fact: this is
// where the write happens and the stat is authoritative, it covers BOTH
// callers (create and rename) instead of duplicating the ack call at every
// renderer-side success handler, and it is the exact pattern already
// established by writeTextFileChecked/dialogs.js above -- no new module
// boundary or shared-state pattern is introduced.
//
// Deliberately best-effort and NEVER allowed to turn a successful
// create/rename into a reported failure: the file operation has already
// succeeded by the time this runs, and a failed post-write re-stat (a
// separate, wildly unlikely race) recording nothing is strictly better than
// misreporting a real create/rename as failed. This must never suppress a
// GENUINE external change -- it only ever seeds the baseline for the write
// this same call just performed, at the exact path it just wrote, which is
// precisely WORK-07's own established contract.
async function recordStatBestEffort (targetPath) {
  try {
    const stat = await fsPromises.stat(targetPath)
    recordStat(targetPath, stat)
  } catch {
    // Best-effort only -- see this function's own header comment.
  }
}

/**
 * Creates a new, empty file named `name` inside `parentDirPath`. Validates
 * `parentDirPath` via isSafeFilePath and `name` via isSafeFileName BEFORE
 * any path.join() -- either failure returns a structured error and performs
 * no filesystem write. Refuses to overwrite an existing entry (EEXISTS).
 * Writes via atomicWrite, never a bare fs.writeFile.
 */
export async function createWorkspaceFile (parentDirPath, name) {
  if (!isSafeFilePath(parentDirPath)) {
    return { ok: false, error: { message: `Refusing to create a file under unsafe path: ${parentDirPath}`, code: 'EINVALIDPATH' } }
  }
  if (!isSafeFileName(name)) {
    return { ok: false, error: { message: `"${name}" is not a valid filename.`, code: 'EINVALIDNAME' } }
  }

  const targetPath = path.join(parentDirPath, name)

  if (await pathExists(targetPath)) {
    return { ok: false, error: { message: `"${name}" already exists in this folder.`, code: 'EEXISTS' } }
  }

  try {
    await atomicWrite(targetPath, '')
    await recordStatBestEffort(targetPath)
    return { ok: true, path: targetPath }
  } catch (err) {
    // Intentional catch: converts an atomicWrite rejection into a returned
    // error object rather than an unhandled rejection -- text-file.js's own
    // established discipline, never a bare `catch {}`.
    return { ok: false, error: { message: err.message, code: err.code } }
  }
}

/**
 * Renames the entry at `oldPath` to `newName` (a bare filename, resolved
 * against oldPath's own parent directory). Validates `oldPath` via
 * isSafeFilePath and `newName` via isSafeFileName BEFORE any path.join().
 * Refuses to rename onto an existing different entry (EEXISTS) -- a newPath
 * that case-insensitively equals oldPath itself is not a collision (a
 * case-only rename on a case-insensitive filesystem).
 */
export async function renameWorkspaceEntry (oldPath, newName) {
  if (!isSafeFilePath(oldPath)) {
    return { ok: false, error: { message: `Refusing to rename unsafe path: ${oldPath}`, code: 'EINVALIDPATH' } }
  }
  if (!isSafeFileName(newName)) {
    return { ok: false, error: { message: `"${newName}" is not a valid filename.`, code: 'EINVALIDNAME' } }
  }

  const newPath = path.join(path.dirname(oldPath), newName)
  const isSamePath = newPath.toLowerCase() === oldPath.toLowerCase()

  if (!isSamePath && await pathExists(newPath)) {
    return { ok: false, error: { message: `"${newName}" already exists in this folder.`, code: 'EEXISTS' } }
  }

  try {
    await fsPromises.rename(oldPath, newPath)
    await recordStatBestEffort(newPath)
    return { ok: true, path: newPath }
  } catch (err) {
    return { ok: false, error: { message: err.message, code: err.code } }
  }
}

/**
 * Deletes the entry at `targetPath` by delegating directly to trash.js's
 * trashWorkspaceFile -- the ONE function in this codebase permitted to
 * delete a workspace file. This function contains no other
 * filesystem-mutating call; scripts/check-trash-not-unlink.mjs enforces
 * that structurally.
 */
export async function deleteWorkspaceEntry (targetPath) {
  if (!isSafeFilePath(targetPath)) {
    return { ok: false, error: { message: `Refusing to delete unsafe path: ${targetPath}`, code: 'EINVALIDPATH' } }
  }
  return trashWorkspaceFile(targetPath)
}

/**
 * Registers the renderer-facing IPC surface for create/rename. (Delete is
 * wired into its own IPC entry point by a later plan, 07-08 -- this plan
 * builds the function it will call; see this plan's own threat_model note.)
 */
export function registerWorkspaceFileopsIpc () {
  ipcMain.handle('workspace:create-file', (_event, parentDirPath, name) => createWorkspaceFile(parentDirPath, name))
  ipcMain.handle('workspace:rename', (_event, oldPath, newName) => renameWorkspaceEntry(oldPath, newName))
}
