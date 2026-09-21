// The one delete path for a workspace file (WORK-03, criterion 2): every
// tree-initiated delete goes through shell.trashItem (the real OS Recycle
// Bin), never a permanent delete. scripts/check-trash-not-unlink.mjs is the
// fail-closed gate that structurally enforces this file (and
// workspace-fileops.js) never regresses to a permanent delete.
//
// Mirrors dialogs.js's `shell:reveal-in-explorer` handler's isSafeFilePath-
// guard-then-shell.* shape (07-RESEARCH.md Pattern 5) -- but do NOT copy that
// handler's unmodified-path pass-through verbatim: shell.trashItem requires
// the platform's native separator (backslash on Windows) [CITED:
// electronjs.org/docs/latest/api/shell -- "The path must use the default
// path separator for the platform (backslash on Windows)"], while
// path-guard.js's isSafeFilePath deliberately permits either separator and
// never normalizes (its own header comment explains why: normalizing before
// the traversal check could mask a `..\..\` pair). The fix is to normalize
// to backslash strictly AFTER the isSafeFilePath check, immediately before
// the shell.trashItem call, and nowhere else -- path-guard.js itself is not
// touched.
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { shell } from 'electron'
import { isSafeFilePath } from './path-guard.js'

/**
 * Moves `filePath` to the OS Recycle Bin via shell.trashItem. Returns
 * `{ok: true}` on success or `{ok: false, error: {message, code}}` on any
 * failure -- never throws.
 *
 * Validates `filePath` via isSafeFilePath BEFORE shell.trashItem is ever
 * called; a failing path returns `{ok:false, error:{code:'EINVALIDPATH'}}`
 * without touching the filesystem. Only after that check does this function
 * normalize the path to the platform's native separator (backslash on
 * win32; left unmodified elsewhere) -- normalizing any earlier would risk
 * masking a traversal segment before isSafeFilePath ever sees it.
 */
async function trashWorkspaceFile (filePath) {
  if (!isSafeFilePath(filePath)) {
    return { ok: false, error: { message: `Refusing to trash unsafe path: ${filePath}`, code: 'EINVALIDPATH' } }
  }

  const platformPath = process.platform === 'win32' ? filePath.replace(/\//g, '\\') : filePath

  try {
    await shell.trashItem(platformPath) // NEVER a permanent delete -- WORK-03, criterion 2
    return { ok: true }
  } catch (err) {
    // Intentional catch: converts a thrown/rejected shell error into a
    // returned error object rather than an unhandled rejection -- this
    // module's own header comment and text-file.js's established discipline
    // both require never a bare `catch {}`. The underlying err.code is
    // preserved (e.g. EPERM), never discarded.
    return { ok: false, error: { message: err.message, code: err.code } }
  }
}

export { trashWorkspaceFile }
