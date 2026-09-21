// Text-file read/write service with mtime/size conflict detection (SHELL-02,
// SHELL-03, SHELL-04). This module is the only consumer of `path-guard.js`'s
// `isSafeFilePath` and `atomic-write.js`'s `atomicWrite` that also performs
// filesystem reads -- see 04-01-SUMMARY.md's "Next Phase Readiness" note:
// path-guard.js deliberately does NOT validate file-vs-directory (that
// requires an fs.stat round trip a pure guard module must not perform), so
// this file calls fs.stat and checks isFile() itself before treating a
// validated path as readable/writable.
//
// Conflict semantics (PITFALLS.md Pitfall 4, 04-CONTEXT.md "Atomic Write &
// Failure Semantics"): record mtimeMs + size on open AND after every
// successful save; stat and compare before every write. On mismatch, do NOT
// write -- return a structured conflict result and let the caller (the
// renderer, via dialogs.js/save.js in a later plan) present Keep Mine /
// Reload Theirs / Save As Copy, defaulting to the non-destructive option.
// This module's job stops at "detect and report the conflict, never write
// through it" -- the three-way choice UI is explicitly out of scope here.
//
// WR-02 (04-REVIEW.md), stated honestly: the upfront stat comparison below
// cannot alone close the window between "no conflict at check time" and the
// rename actually landing inside atomicWrite -- the file could still be
// deleted or replaced by another process while atomicWrite is busy writing
// and fsyncing the temp file. writeTextFileChecked NARROWS that window (does
// not fully close it) by also passing atomicWrite a `precheck` that re-stats
// the target immediately before the rename is attempted -- the latest
// possible moment this module can check. A change landing in the remaining
// gap between that precheck and the rename call itself is still possible
// and undetected; fully closing it would require a real filesystem lock,
// which is out of scope here.
//
// Every failure path returns a structured `{error: {message, code}}` or
// `{ok: false, ...}` result. Never an empty/swallowing catch block, never an
// unhandled rejection, never a swallowed null -- see PITFALLS.md line 154 /
// 04-PATTERNS.md's "never discard the error object" shared pattern, naming
// the exact anti-pattern this file must not repeat.
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import { ipcMain } from 'electron'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { isSafeFilePath } from './path-guard.js'
import { atomicWrite } from './atomic-write.js'

// Recorded stat map, keyed by absolute file path. Exposed only via
// recordStat/getRecordedStat getter/setter functions -- never export the Map
// itself, per the codebase's established shared-mutable-state convention
// (documents.js, sync-controller.js; restated for main-process modules by
// 04-PATTERNS.md's text-file.js section).
let openFileStats = new Map()

/**
 * Records the last-known {mtimeMs, size} for `filePath`, overwriting any
 * previously recorded stat for the same path.
 */
function recordStat (filePath, stat) {
  openFileStats.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size })
}

/**
 * Returns the last-known {mtimeMs, size} recorded for `filePath`, or
 * undefined if this path has never been read/written by this process.
 */
function getRecordedStat (filePath) {
  return openFileStats.get(filePath)
}

/**
 * Reads `filePath` and returns {path, text, name, mtimeMs, size} on success,
 * recording its stat for future conflict comparisons. Returns
 * {error: {message, code}} on any failure -- an unsafe path, a non-file
 * target, or a thrown fs error -- and never throws.
 */
async function readTextFile (filePath) {
  if (!isSafeFilePath(filePath)) {
    return { error: { message: `Refusing to open unsafe path: ${filePath}`, code: 'EINVALIDPATH' } }
  }

  try {
    const stat = await fsPromises.stat(filePath)
    if (!stat.isFile()) {
      return { error: { message: 'Not a file', code: 'ENOTAFILE' } }
    }

    const text = await fsPromises.readFile(filePath, 'utf8')
    recordStat(filePath, stat)

    return {
      path: filePath,
      text,
      name: path.basename(filePath),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    }
  } catch (err) {
    // Intentional catch: converts a thrown fs error into a returned error
    // object rather than an unhandled rejection or a UI-string-only message.
    // The underlying err.code (e.g. ENOENT) is preserved, never discarded.
    return { error: { message: err.message, code: err.code } }
  }
}

/**
 * Writes `content` to `filePath` via atomicWrite, after checking for an
 * external change since the last recorded stat (unless `force` is true).
 *
 * - No recorded stat for this path -- writes immediately.
 * - Recorded stat present and the current on-disk stat differs (mtimeMs or
 *   size) -- returns {ok:false, conflict:true, actual:{mtimeMs, size}}
 *   WITHOUT calling atomicWrite. If the file has been deleted since open,
 *   the re-stat itself throws -- treated as {ok:false, conflict:true,
 *   actual:null} rather than silently recreating the file (PITFALLS.md
 *   Pitfall 4 item 5).
 * - force === true bypasses the comparison entirely and always writes.
 * - Any atomicWrite rejection returns {ok:false, conflict:false,
 *   error:{message, code}} -- never throws, never an empty swallowing catch.
 */
async function writeTextFileChecked (filePath, content, force = false) {
  if (!isSafeFilePath(filePath)) {
    return { ok: false, conflict: false, error: { message: `Refusing to save unsafe path: ${filePath}`, code: 'EINVALIDPATH' } }
  }

  const recorded = force ? undefined : getRecordedStat(filePath)

  if (recorded) {
    let currentStat
    try {
      currentStat = await fsPromises.stat(filePath)
    } catch {
      // The file vanished (deleted/renamed) since it was opened. Do not
      // silently recreate it -- surface as a conflict with no known actual
      // stat, per PITFALLS.md Pitfall 4 item 5.
      return { ok: false, conflict: true, actual: null }
    }

    const changed = currentStat.mtimeMs !== recorded.mtimeMs || currentStat.size !== recorded.size
    if (changed) {
      return { ok: false, conflict: true, actual: { mtimeMs: currentStat.mtimeMs, size: currentStat.size } }
    }
  }

  // WR-02: re-stat again immediately before the rename is attempted (inside
  // atomicWrite, after the temp file is already written and fsynced) --
  // narrows, but does not fully close, the window above. See this module's
  // header comment for the honest statement of the residual risk.
  const precheck = recorded
    ? async () => {
        let latestStat
        try {
          latestStat = await fsPromises.stat(filePath)
        } catch {
          return { actual: null }
        }
        const changed = latestStat.mtimeMs !== recorded.mtimeMs || latestStat.size !== recorded.size
        return changed ? { actual: { mtimeMs: latestStat.mtimeMs, size: latestStat.size } } : null
      }
    : undefined

  try {
    await atomicWrite(filePath, content, { precheck })
    const stat = await fsPromises.stat(filePath)
    recordStat(filePath, stat)
    return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (err) {
    if (err.code === 'ECONFLICT') {
      return { ok: false, conflict: true, actual: err.conflict ? err.conflict.actual : null }
    }
    // Intentional catch: atomicWrite already guarantees the original file is
    // untouched on failure and carries an errno-carrying error -- this
    // converts that rejection into a structured, non-throwing result.
    return { ok: false, conflict: false, error: { message: err.message, code: err.code } }
  }
}

function registerTextFileIpc () {
  ipcMain.handle('file:open-path', (_event, filePath) => readTextFile(filePath))
  ipcMain.handle('file:save', (_event, filePath, content, options) =>
    writeTextFileChecked(filePath, content, Boolean(options && options.force))
  )
}

export { readTextFile, writeTextFileChecked, registerTextFileIpc, recordStat, getRecordedStat }
