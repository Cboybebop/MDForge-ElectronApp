// Atomic, Windows-safe text-file write primitive (SHELL-03, SHELL-04).
//
// `fs.writeFile(path, content)` truncates then writes; a crash or exception
// between those two steps leaves a zero-length or half-written file -- the
// user's document is gone, not "reverted." The standard fix (write-temp-then-
// rename) is itself unreliable on Windows: Defender's real-time scanner opens
// files as they are written, so a rename firing immediately after the write
// hits a held handle, and OneDrive -- exactly where a Windows user's Documents
// folder usually lives -- does the same. This module exists to end the
// browser app's `catch (e) { showStatus('Save failed', 'error') }` habit
// (index.html:1086), which discards `e` entirely and makes every Windows lock
// failure unattributable. See PITFALLS.md Pitfall 3 and 04-CONTEXT.md's
// "Atomic Write & Failure Semantics" section -- both lock the same algorithm:
//
//   1. Write to a temp file in the SAME directory as the target (a
//      cross-volume rename is not atomic and silently degrades to
//      copy+delete, reintroducing the corruption window the temp file exists
//      to close). Name it `<basename>.<pid>.<random>.tmp` -- the random
//      suffix (IN-01, 04-REVIEW.md) exists because `<pid>` alone is unique
//      per process+target-file but NOT per call: today only one write is
//      ever in flight per file (no autosave yet), but once autosave lands
//      (Phase 6) a manual Ctrl+S firing while a debounced autosave write to
//      the SAME path is still in flight would otherwise race on an
//      identical temp filename and could stomp each other's temp file
//      mid-write.
//   2. fsync the temp file's descriptor before closing. Without this the
//      rename can be durable while the contents are not -- a correctly-named
//      *empty* file, which is worse than a failed save because it presents
//      as success.
//   3. fs.rename temp -> target (atomic at the filesystem level, same
//      directory only).
//   4. Wrap the rename in retry-with-backoff on EPERM/EBUSY/EACCES: 5
//      attempts, 50ms doubling to ~800ms. Non-optional on Windows.
//   5. On exhaustion (or a non-retryable code), leave the original untouched,
//      clean up the temp file, and throw a real, errno-carrying error. Never
//      `catch {}` a save.
//
// WR-02 residual risk, stated honestly (04-REVIEW.md): a caller-supplied
// `precheck` (see atomicWrite's own doc comment) narrows, but cannot fully
// close, the window between a conflict check and the rename actually
// landing -- a change arriving between the precheck call and the rename
// itself is still possible and is not detected. Fully closing this would
// require a real filesystem lock, which this module deliberately does not
// take (see 04-CONTEXT.md; not attempted here).
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX_ATTEMPTS = 5
const INITIAL_DELAY_MS = 50
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Renames `tempPath` to `targetPath`, retrying on EPERM/EBUSY/EACCES up to
 * MAX_ATTEMPTS times with a doubling delay (50ms, 100ms, 200ms, 400ms between
 * attempts). A non-retryable code fails immediately without exhausting the
 * remaining attempts. Cleans up the temp file and throws an errno-carrying
 * error on failure; never swallows the original error.
 */
async function renameWithRetry (tempPath, targetPath) {
  let lastError
  let delayMs = INITIAL_DELAY_MS

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await fsPromises.rename(tempPath, targetPath)
      return
    } catch (err) {
      lastError = err
      const isRetryable = RETRYABLE_CODES.has(err.code)
      const attemptsRemain = attempt < MAX_ATTEMPTS
      if (!isRetryable || !attemptsRemain) break
      await delay(delayMs)
      delayMs *= 2
    }
  }

  // Cleanup only -- a failed unlink must not mask the real error above.
  await fsPromises.unlink(tempPath).catch(() => {})

  const surfaced = new Error(
    `Could not save "${targetPath}": locked by another process; OneDrive or ` +
    `antivirus may be scanning it (${lastError.code}: ${lastError.message})`
  )
  surfaced.code = lastError.code
  surfaced.cause = lastError
  throw surfaced
}

/**
 * Atomically writes `data` (string | Buffer) to `filePath`. Writes to a
 * same-directory temp file, fsyncs its descriptor before closing, then
 * renames it into place with retry-with-backoff on transient Windows lock
 * errors. On any unrecoverable failure the original file is left untouched
 * and an errno-carrying error is thrown -- never a bare `catch {}`.
 *
 * WR-02 (04-REVIEW.md): an optional `precheck` function may be passed via
 * `options`. If provided, it is invoked once, immediately before the rename
 * is attempted -- as late as this module can call it, after the temp file is
 * already written and fsynced. If it resolves to a truthy value, the temp
 * file is cleaned up and an error with `err.code = 'ECONFLICT'` and
 * `err.conflict` set to that value is thrown instead of renaming. This
 * NARROWS the conflict-check-to-rename window (a caller with its own
 * recorded-stat semantics, e.g. text-file.js, can catch a change that landed
 * after its own upfront check but before the write+fsync completed) -- it
 * does NOT fully close it. A change landing between this precheck call and
 * the rename call a few lines below remains a real, accepted residual risk
 * that only a genuine file lock could close; see text-file.js's header
 * comment for the honest statement of that residual.
 */
export async function atomicWrite (filePath, data, options = {}) {
  const { precheck } = options
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  )

  const handle = await fsPromises.open(tempPath, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync() // fsync -- must happen before close, and before rename
  } catch (err) {
    // WR-01 (04-REVIEW.md): if writeFile/sync throws (e.g. ENOSPC mid-write),
    // control must not reach renameWithRetry's own cleanup -- the temp file
    // would otherwise be left behind forever. Close and unlink here too,
    // then re-throw the ORIGINAL error untouched.
    await handle.close().catch(() => {})
    await fsPromises.unlink(tempPath).catch(() => {})
    throw err
  }
  await handle.close()

  if (precheck) {
    const conflict = await precheck()
    if (conflict) {
      await fsPromises.unlink(tempPath).catch(() => {})
      const err = new Error('Write aborted: target changed on disk immediately before rename')
      err.code = 'ECONFLICT'
      err.conflict = conflict
      throw err
    }
  }

  await renameWithRetry(tempPath, filePath)
}
