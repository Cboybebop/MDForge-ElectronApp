// Chokidar-backed workspace watcher -- the entire mechanism behind WORK-04
// (clean tab + external change -> silent reload), WORK-05 (dirty tab +
// external change -> conflict banner), WORK-06 (external delete -> tab stays
// open, marked missing, content intact) and WORK-07 (the app's own saves
// never trigger a spurious external-change prompt). See 07-RESEARCH.md
// Architecture Pattern 1/3/4, Pitfalls 1/5/7, and 07-PATTERNS.md's pattern
// assignment for this file.
//
// SCOPE OF THIS FILE: a single, bounded, EAGER watch of the whole open
// workspace root (07-RESEARCH.md Pattern 3) -- never a per-expanded-
// directory watch. WORK-04/05/06 must be able to reconcile any file
// currently open in a tab, and a tab can be open on a file whose containing
// directory the user never expanded in the sidebar tree. Watching only
// expanded directories would silently break reconciliation for exactly the
// files a user is most likely to have open. The tree's own lazy
// `fs.readdir` calls (workspace-tree.js) are a wholly separate, UI-only
// concern from this file's watch scope.
//
// SELF-WRITE SUPPRESSION -- THE RACE, STATED HONESTLY (07-RESEARCH.md
// Architecture Pattern 1 / Pitfall 1): `classifyWatcherEvent` compares a
// watcher event's freshly re-stat'd {mtimeMs, size} against text-file.js's
// recorded-stat map (`getRecordedStat`, imported directly -- no second map
// is built here, per 07-RESEARCH.md's Don't Hand-Roll table). That recorded
// value is written by `writeTextFileChecked` AFTER `atomicWrite`'s rename
// resolves, while chokidar's own event delivery runs on a wholly separate
// OS-notification path (`ReadDirectoryChangesW` on Windows) with its own,
// uncorrelated latency. There is no language-level guarantee that the
// in-process `recordStat()` call completes before chokidar's own delayed
// event-processing pipeline invokes this file's handler. This is a real,
// theoretical gap -- NOT claimed impossible.
//
// Why it holds in practice, not by luck: `awaitWriteFinish` is configured
// below with a non-zero `stabilityThreshold` (chokidar deliberately delays
// emitting `add`/`change` until the target's size has been stable across at
// least one full poll interval). Even a deliberately-shortened threshold is
// enormously longer than the single `await atomicWrite() -> await
// fsPromises.stat() -> Map.set()` sequence that updates the recorded-stat
// map, which completes in low-single-digit milliseconds on local disk. The
// recorded value will, in every realistic case, already be current by the
// time chokidar's delayed event reaches this file's handler. This is an
// accepted, measured design property (mirroring atomic-write.js's own WR-02
// residual-risk documentation style) -- disabling or zeroing
// `awaitWriteFinish` would remove the practical guarantee that makes this
// hold, and must never be done "for responsiveness."
//
// DEVIATION (Rule 1 -- bug avoided before it shipped): the canary sentinel
// filename deliberately does NOT start with a leading dot. `isIgnoredPath`
// below filters any dotfile/dot-directory by design (07-CONTEXT.md's locked
// "hidden always" rule) -- a dot-prefixed sentinel would be invisible to
// this file's own watcher, causing the health canary to time out on every
// single folder-open regardless of whether native watching actually works,
// permanently and silently forcing the polling fallback. The sentinel is
// named `mdforge-canary-<random>.tmp` (no leading dot) specifically to stay
// outside isIgnoredPath's own filter.
//
// NOTE: written as ESM import/export, not require()/module.exports -- the
// electron-vite main build's Rollup bundling only traverses relative local
// files that use static ES import syntax (Phase 1 decision).
import chokidar from 'chokidar'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { getRecordedStat } from './text-file.js'

const IGNORED_NAMES = new Set(['node_modules', '.git'])

// Starting points, not final values -- 07-RESEARCH.md's Open Question 1
// explicitly defers exact tuning to real-fixture measurement. Tests may
// override each of these via startWorkspaceWatcher's options object; callers
// in production code should not need to.
const DEFAULT_DEPTH = 8
const DEFAULT_STABILITY_THRESHOLD_MS = 400
const DEFAULT_CANARY_TIMEOUT_MS = 3000

// Grace period after the sentinel's own unlink call during which its
// resulting 'unlink' chokidar event is still suppressed. This is bookkeeping
// for this file's own synthetic marker file, NOT the WORK-07 self-write
// suppression mechanism (which is a stat comparison, never a timer, per
// 07-CONTEXT.md's locked decision) -- without it, deleting the sentinel
// would itself produce a spurious 'vanished' event for a path the tree/tabs
// never knew existed.
const SENTINEL_CLEANUP_GRACE_MS = 2000

/**
 * True when `watchedPath`'s basename should be excluded from the watch: any
 * dotfile/dot-directory, or an exact match on `node_modules`/`.git`
 * (07-CONTEXT.md's locked "hidden always" rule). A function predicate, never
 * a glob string -- chokidar v4+ removed glob support (07-RESEARCH.md State of
 * the Art).
 */
export function isIgnoredPath (watchedPath) {
  const base = path.basename(watchedPath)
  return base.startsWith('.') || IGNORED_NAMES.has(base)
}

/**
 * Classifies a single chokidar event into exactly one of:
 *   - {kind:'vanished', path, isDirectory} -- unlink/unlinkDir (isDirectory
 *     carries chokidar's own already-known distinction), or an 'add'/'change'
 *     that raced with a delete between the event firing and this function's
 *     own fs.stat call (isDirectory always false in that case -- chokidar
 *     never emits 'add'/'change' for a directory path).
 *   - {kind:'own-write', path} -- a fresh, independently-verified stat
 *     matches text-file.js's recorded stat for this path (WORK-07: discard,
 *     no outbound event).
 *   - {kind:'external-change', path, stat} -- everything else.
 *
 * Never trusts chokidar's own passed-through stat argument (07-RESEARCH.md
 * Pitfall 5 -- present only "when available" and not a freshness guarantee);
 * always independently calls fsPromises.stat.
 */
export async function classifyWatcherEvent (eventType, targetPath) {
  if (eventType === 'unlink') return { kind: 'vanished', path: targetPath, isDirectory: false }
  if (eventType === 'unlinkDir') return { kind: 'vanished', path: targetPath, isDirectory: true }

  let stat
  try {
    stat = await fsPromises.stat(targetPath)
  } catch {
    // Raced with a delete between the event firing and this stat call. Only
    // a file can race this way -- chokidar never emits 'add'/'change' for a
    // directory path.
    return { kind: 'vanished', path: targetPath, isDirectory: false }
  }

  const recorded = getRecordedStat(targetPath)
  if (recorded && stat.mtimeMs === recorded.mtimeMs && stat.size === recorded.size) {
    return { kind: 'own-write', path: targetPath }
  }
  return { kind: 'external-change', path: targetPath, stat }
}

// Single-owner state, never bare-exported -- same discipline as
// text-file.js's openFileStats Map / documents.js's documents Map
// (07-PATTERNS.md "Single-owner state behind getter/setter").
let currentWatcher = null

// Paths currently in flight as a canary sentinel -- suppressed from
// onEvent entirely (not merely from being classified as own-write) so a
// health-check's own temp file never produces a spurious reconciliation
// event for the tree/tabs.
const suppressedPaths = new Set()

function buildWatchOptions ({ depth, stabilityThresholdMs, usePolling } = {}) {
  return {
    depth: depth ?? DEFAULT_DEPTH,
    ignored: isIgnoredPath,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: stabilityThresholdMs ?? DEFAULT_STABILITY_THRESHOLD_MS,
      pollInterval: 100
    },
    atomic: true,
    ...(usePolling ? { usePolling: true } : {})
  }
}

function waitForReady (watcher) {
  return new Promise((resolve) => {
    watcher.once('ready', resolve)
  })
}

/**
 * Wires all FOUR chokidar events this app reconciles on -- 'add', 'change',
 * 'unlink', AND 'unlinkDir'. Omitting 'unlinkDir' is the exact regression
 * this task exists to prevent: a bulk external directory delete must be a
 * classified, wired event, not a silently-dropped chokidar event.
 * 'own-write' classifications are discarded silently (WORK-07); everything
 * else is handed to onEvent.
 */
function wireEvents (watcher, onEvent) {
  const handle = (eventType) => (eventPath) => {
    if (suppressedPaths.has(eventPath)) return
    classifyWatcherEvent(eventType, eventPath).then((result) => {
      if (result.kind !== 'own-write') onEvent(result)
    })
  }
  watcher.on('add', handle('add'))
  watcher.on('change', handle('change'))
  watcher.on('unlink', handle('unlink'))
  watcher.on('unlinkDir', handle('unlinkDir'))
}

/**
 * Fire-and-forget cleanup of a canary sentinel: deletes the file, then keeps
 * `sentinelPath` suppressed until either the resulting 'unlink' event is
 * observed or SENTINEL_CLEANUP_GRACE_MS elapses, whichever comes first. Not
 * awaited by runCanary -- the canary's own true/false result must not wait
 * on this.
 */
function scheduleSentinelCleanup (watcher, sentinelPath) {
  fsPromises.unlink(sentinelPath).catch(() => {}).finally(() => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      watcher.removeListener('unlink', onUnlink)
      suppressedPaths.delete(sentinelPath)
    }
    const onUnlink = (removedPath) => {
      if (removedPath === sentinelPath) finish()
    }
    const timer = setTimeout(finish, SENTINEL_CLEANUP_GRACE_MS)
    watcher.on('unlink', onUnlink)
  })
}

/**
 * Writes a sentinel file inside `root` and races a bounded timeout against
 * an 'add' event for that exact path (07-RESEARCH.md Pitfall 7 -- native
 * watch events can fail SILENTLY on OneDrive/network drives, not via a
 * thrown 'error', so an active canary is required rather than relying on an
 * 'error' listener). Resolves true/false; never rejects. The sentinel is
 * suppressed from `onEvent` throughout, and best-effort deleted regardless
 * of outcome (see scheduleSentinelCleanup) once this function returns.
 */
async function runCanary (watcher, root, { canaryTimeoutMs, writeSentinel } = {}) {
  const sentinelPath = path.join(root, `mdforge-canary-${crypto.randomBytes(4).toString('hex')}.tmp`)
  const timeoutMs = canaryTimeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS
  const write = writeSentinel ?? ((p) => fsPromises.writeFile(p, ''))

  suppressedPaths.add(sentinelPath)
  try {
    return await new Promise((resolve) => {
      let settled = false
      const onAdd = (addedPath) => {
        if (addedPath === sentinelPath && !settled) {
          settled = true
          clearTimeout(timer)
          watcher.removeListener('add', onAdd)
          resolve(true)
        }
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          watcher.removeListener('add', onAdd)
          resolve(false)
        }
      }, timeoutMs)

      watcher.on('add', onAdd)
      // A failed sentinel write does not resolve early -- it is treated the
      // same as a missing event, correctly falling through to the timeout
      // and the polling retry.
      Promise.resolve(write(sentinelPath, watcher)).catch(() => {})
    })
  } finally {
    scheduleSentinelCleanup(watcher, sentinelPath)
  }
}

// Matches this file's own canary sentinel filename shape
// (`mdforge-canary-<random>.tmp`, see runCanary below) -- deliberately no
// leading `.` in the pattern either, mirroring the sentinel's own
// deviation note above.
const SENTINEL_NAME_RE = /^mdforge-canary-.*\.tmp$/

/**
 * Best-effort deletion of any PREVIOUS session's crash-orphaned canary
 * sentinel(s) still sitting directly inside `root` (WR-03, 07-REVIEW.md).
 * runCanary's own scheduleSentinelCleanup only runs to completion inside a
 * live, running app -- a killed/crashed process (or a renderer that dies
 * mid-canary) can leave `mdforge-canary-<random>.tmp` behind in the user's
 * REAL workspace folder permanently, since nothing previously swept for one
 * on the next folder-open. Runs before this root's own watcher is created,
 * so even a sentinel chokidar's `ignoreInitial:true` would otherwise have
 * silently ignored anyway is proactively removed rather than left in place
 * indefinitely. Never throws: an unreadable/missing root (permissions, or a
 * folder that no longer exists) must not block startWorkspaceWatcher from
 * continuing -- a stale sentinel left behind by this one failure mode is
 * strictly better than refusing to open the folder at all.
 */
async function sweepStaleSentinels (root) {
  let entries
  try {
    entries = await fsPromises.readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => SENTINEL_NAME_RE.test(name))
      .map((name) => fsPromises.unlink(path.join(root, name)).catch(() => {}))
  )
}

/**
 * Starts (or replaces) the single workspace watcher for `root`. If a watcher
 * is already running, it is fully `.close()`'d before the new one is
 * created -- no window where two watchers are simultaneously live, and no
 * event from the old root ever reaches `onEvent` after replacement.
 *
 * Runs the canary health-check once against a real (or, in tests,
 * `watchFn`-injected) chokidar instance; on timeout, closes it and restarts
 * once with `usePolling: true`, retrying the canary. Resolves
 * `{healthy: boolean}` -- NEVER throws for an unhealthy watcher. The caller
 * (07-06) must still allow the folder to be browsed/opened even when
 * `healthy` is false; a failed canary is a degrade, not a refusal.
 *
 * `options.watchFn`/`options.writeSentinel` are injection seams for tests
 * only (mirroring atomic-write.js's own `precheck` injection seam) --
 * production callers should omit them and get real chokidar + a real
 * sentinel file write.
 */
export async function startWorkspaceWatcher (root, onEvent, options = {}) {
  const { depth, stabilityThresholdMs, canaryTimeoutMs, watchFn = chokidar.watch, writeSentinel } = options

  if (currentWatcher) {
    await currentWatcher.close()
    currentWatcher = null
  }

  // WR-03: sweep any crash-orphaned sentinel from a PREVIOUS session before
  // this root's own watcher (and this session's own fresh canary) starts.
  await sweepStaleSentinels(root)

  let watcher = watchFn(root, buildWatchOptions({ depth, stabilityThresholdMs }))
  await waitForReady(watcher)
  wireEvents(watcher, onEvent)
  currentWatcher = watcher

  let healthy = await runCanary(watcher, root, { canaryTimeoutMs, writeSentinel })

  if (!healthy) {
    await watcher.close()
    watcher = watchFn(root, buildWatchOptions({ depth, stabilityThresholdMs, usePolling: true }))
    await waitForReady(watcher)
    wireEvents(watcher, onEvent)
    currentWatcher = watcher

    healthy = await runCanary(watcher, root, { canaryTimeoutMs, writeSentinel })
  }

  return { healthy }
}

/**
 * Fully closes and clears the current watcher, if any. Safe to call when
 * nothing is running.
 */
export async function stopWorkspaceWatcher () {
  if (currentWatcher) {
    await currentWatcher.close()
    currentWatcher = null
  }
}
