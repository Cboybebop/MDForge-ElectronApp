// Pure composition of the three restore-input sources into one ordered,
// deduplicated restore plan (PERS-06). Deliberately free of any `electron`
// or `node:*` import -- mirrors `window-state.js`'s `boundsFitOnADisplay`/
// `validatedBoundsForRestore` shape (a pure predicate/composition function
// taking already-resolved data as a parameter, never fetching it itself) so
// this module is unit-testable under plain Node/vitest, with zero Electron
// process required.
//
// This file performs NO filesystem/Electron/store I/O. Every fs-existence
// check ("a session entry whose file no longer exists is skipped silently")
// and every recovery-draft/argv-path resolution happens at the CALLER's
// boundary (06-04's main/index.js, which does have fs access) -- this
// function receives three already-resolved entry lists and returns the
// ordered, deduped plan. Composing correctly here is the entirety of what
// makes PERS-06 ("recovery + session restore never produce duplicate tabs")
// a provable guarantee rather than a hopeful one.
//
// Entry shape (unified across all three input arrays):
//   { filePath: string|null, draftUuid: string|null, name, content, dirty,
//     scrollTop, conflicted, source }
//
// Ordering (06-CONTEXT.md, locked by ROADMAP criterion 4): recovery entries
// first, then argv/file-association entries (skipping any whose dedup key
// already appeared in recovery), then remaining session entries (skipping
// any whose dedup key already appeared in recovery OR argv).
//
// Dedup key: normalizeForDedup(entry.filePath) when filePath is a non-null
// string; otherwise entry.draftUuid. Two entries with BOTH filePath === null
// AND draftUuid === null are never considered duplicates of each other --
// each represents a distinct untitled document with no other identity, so
// neither is added to (nor matched against) the `seen` set.
//
// This function's contract is ordering/dedup only, not input validation
// (T-6-04, accepted) -- its caller (06-04's index.js) is responsible for
// producing well-shaped entries from already-validated sources. It still
// must not THROW on a malformed entry, per window-state.js's own read-side
// validation scepticism -- a malformed entry is simply treated as having no
// dedup key (always included, never matched) rather than crashing restore.

// Windows-first (06-CONTEXT.md): lowercases the string and collapses every
// run of `/` or `\` into a single `\`, so `C:\Foo\Bar.md` and
// `c:/foo/bar.md` normalize identically. Deliberately NOT `path.resolve`/
// `path.normalize` -- this file has no filesystem access and must not
// pretend to (contrast with `path-guard.js`'s own header comment on why IT
// avoids normalization, for the opposite reason: traversal-detection). This
// helper exists only for dedup and is intentionally NOT shared with
// `recents-store.js`'s own separate copy (06-02) -- see that plan's note on
// why these two small pure helpers stay independent rather than a fake
// cross-plan dependency.
function normalizeForDedup (filePath) {
  return filePath.toLowerCase().replace(/[/\\]+/g, '\\')
}

// Returns the dedup key for a single entry, or `null` if the entry has
// neither a usable filePath nor a usable draftUuid (or is malformed) -- a
// `null` key is never matched against anything, including another `null`
// key, so it is never added to the `seen` set.
function dedupKeyFor (entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.filePath === 'string') return normalizeForDedup(entry.filePath)
  if (typeof entry.draftUuid === 'string') return entry.draftUuid
  return null
}

/**
 * Composes the single ordered, deduplicated restore plan from three
 * already-resolved entry lists: crash-recovered drafts, argv/file-
 * association paths, and the last saved session's tabs.
 *
 * @param {Array<object>} recoveryEntries - assumed already internally
 *   deduped by the caller; always placed first, in given order.
 * @param {Array<object>} argvEntries - placed after recovery, in given
 *   order, skipping any whose dedup key already appeared in recovery.
 * @param {Array<object>} sessionEntries - placed last, in given order,
 *   skipping any whose dedup key already appeared in recovery OR argv.
 * @returns {Array<object>} the ordered, deduplicated restore plan.
 */
export function composeRestorePlan (recoveryEntries, argvEntries, sessionEntries) {
  const seen = new Set()
  const plan = []

  const addAll = (entries) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const key = dedupKeyFor(entry)
      if (key !== null) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      plan.push(entry)
    }
  }

  addAll(recoveryEntries)
  addAll(argvEntries)
  addAll(sessionEntries)

  return plan
}
