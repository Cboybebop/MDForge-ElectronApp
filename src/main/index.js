// Main process entry point.
//
// `./protocol.js` MUST be imported before app.whenReady() fires — it registers
// the `app://` scheme as privileged at module-load time (see protocol.js and
// 01-RESEARCH.md Pitfall 1). Importing it here, before any other main-process
// code runs, guarantees that ordering.
//
// Written as ESM import/export — see protocol.js's top-of-file comment for why
// (Rollup only bundles relative local modules that use static import syntax).
import { app, session, ipcMain } from 'electron'
import path from 'node:path'
import fsPromises from 'node:fs/promises'
import { registerAppProtocol } from './protocol.js'
import { shouldPinDevUserData, resolveDevUserDataPath } from './dev-userdata.js'
import { createWindow, registerWindowTitleIpc } from './window.js'
import { hardenWindow } from './security.js'
import { registerThemeIpc, store } from './theme-store.js'
import { registerImageFetchIpc } from './image-fetch.js'
import { registerTextFileIpc } from './text-file.js'
import { registerDialogsIpc } from './dialogs.js'
import { registerBeforeQuit } from './before-quit.js'
import { registerUpdaterIpc } from './updater.js'
import { maybeShowDefaultAppPrompt } from './default-app-prompt.js'
import { validatedBoundsForRestore, registerWindowStatePersistence } from './window-state.js'
import { buildMenu } from './menu.js'
import { registerExportIpc } from './export.js'
import { ensureDraftsDirExists, scanDraftsDir, registerDraftsIpc } from './drafts-store.js'
import { getSessionState, registerSessionIpc } from './session-store.js'
import { composeRestorePlan } from './restore-plan.js'
import { isSafeFilePath } from './path-guard.js'
import { getRecents, clearAll as clearAllRecents, registerRecentsIpc } from './recents-store.js'
import { registerWorkspaceTreeIpc } from './workspace-tree.js'
import { registerWorkspaceFileopsIpc } from './workspace-fileops.js'
import { registerWorkspaceRootIpc, setWorkspaceRootChangeListener } from './workspace-root.js'
import { stopWorkspaceWatcher } from './workspace-watcher.js'
import { registerWorkspaceContextMenuIpc } from './workspace-context-menu.js'
import { registerSpellcheckMenu } from './spellcheck-menu.js'
import log from 'electron-log'

// Shared by both the second-instance handler below and this process's own
// FIRST-launch argv resolution (06-04) -- one relevance filter ("is this
// even a markdown file?"), reused rather than reimplemented. The real
// security boundary is isSafeFilePath, applied downstream in both cases.
const MD_FILE_RE = /\.(md|markdown)$/i

// Module-scope so the second-instance handler below (registered before
// app.whenReady() resolves, see the requestSingleInstanceLock block) can
// reach the real window once app.whenReady() has assigned it.
let win

// BRAND-02 (10-03-PLAN.md Task 2, Rule 2 auto-fix): 10-RESEARCH.md Area 2
// already documented that "the taskbar hover name comes from two places and
// both must agree: productName in electron-builder.yml covers the packaged
// executable; app.setName() plus the existing
// app.setAppUserModelId('com.markey.mdforge') covers the dev run" -- but
// 10-02-PLAN.md Task 1 only ever wired package.json's productName field,
// never the app.setName() call itself. That gap was invisible until this
// plan's own e2e proof: package.json's productName IS read by Electron for
// a directory-based launch (`electron .`, and a packaged app's asar, whose
// embedded package.json's "main" field triggers the same directory-based
// discovery) -- but Playwright's `_electron.launch({ args:
// ['out/main/index.js'] })`, and this suite's entire helpers/launch.js
// convention, launches via a direct SCRIPT PATH, which Electron treats as a
// standalone entry point with no package.json/productName discovery at
// all, defaulting app.getName() to the literal string "Electron" --
// confirmed empirically (a real launch returned "Electron", not
// "MD Forge", before this fix). Call app.setName() explicitly and
// unconditionally (harmless in the packaged case, where it merely
// re-affirms the same value productName already provides) so
// app.getName() is correct in EVERY launch shape, not only the ones that
// happen to trigger package.json discovery. Placed before the dev-userdata
// pin below since Electron's default (unpinned) userData path is derived
// from app.getName() the first time it is read, and this call must win
// that race for the SAME reason the pin itself must run early
// (10-RESEARCH.md Pitfall 5).
app.setName('MD Forge')

// [10-03-PLAN.md Task 2, Rule 3 auto-fix] Test-only seam, narrowly scoped:
// the e2e suite's one test that must exercise the dev-userdata pin's own
// POSITIVE path (tests/e2e/app-identity.spec.js's third test) needs a real,
// isolated appData root that is neither the shared default nor an explicit
// --user-data-dir override (which would exercise the OVERRIDE path
// instead, already covered by a separate test). The plan's originally
// specified technique -- redirecting the child process's APPDATA
// environment variable -- does NOT work: confirmed empirically that
// Windows resolves app.getPath('appData') via SHGetKnownFolderPath, which
// ignores process.env.APPDATA entirely for a spawned child process (see
// 10-03-SUMMARY.md for the proof). app.setPath('appData', ...) called from
// within THIS process, before app.getPath('appData') is ever read, DOES
// work (confirmed empirically) and is the only mechanism that actually
// achieves real isolation here. This follows the SAME established
// test-seam convention already used elsewhere in this exact file's module
// graph (MDFORGE_SKIP_FIRST_RUN_PROMPT in default-app-prompt.js,
// MDFORGE_UPDATE_FEED_URL / MDFORGE_E2E_TEST_HOOKS in updater.js): inert
// unless the env var is explicitly set, and only ever set by this one e2e
// test -- never by a normal dev run or a packaged build.
//
// [10-REVIEW.md CR-01 fix] Gated on `!app.isPackaged`, exactly like the
// dev-userdata pin three lines below -- without this guard, a PACKAGED,
// installed copy of MD Forge launched with this env var set (e.g. via a
// tampered shortcut/LNK target, a wrapper script, or a persistent
// user-level environment variable) would silently redirect its entire
// persisted-data root (drafts, session state, settings, recents), since
// Electron derives the default `userData` path from `appData` lazily and
// the packaged code path never calls app.setPath('userData', ...) itself.
// See tests/packaging-config.test.js's source-order guard for the static
// regression lock and tests/e2e/app-identity.spec.js for the live proof
// this seam is inert once `isPackaged` is true.
if (!app.isPackaged && process.env.MDFORGE_TEST_APPDATA_DIR) {
  app.setPath('appData', process.env.MDFORGE_TEST_APPDATA_DIR)
}

// BRAND-02 (10-02-PLAN.md Task 2): pin the dev-mode userData directory
// BEFORE requestSingleInstanceLock() below -- and therefore before anything
// else in this file that might read app.getPath('userData')/'appData'
// (e.g. this same block's own draftsDir computation further down).
// app.setPath('userData', ...) must run before the FIRST read of
// app.getPath('userData')/'appData' anywhere in Electron's own startup
// sequence, or that earlier read locks in the old, unpinned value first
// (10-RESEARCH.md Pitfall 5). See dev-userdata.js's own header comment for
// the full data-safety hazard this closes: without this pin, package.json's
// new productName ("MD Forge", added in Task 1) would make an unpackaged
// dev run resolve to the SAME userData directory the packaged app uses,
// silently sharing drafts/session/settings storage with the user's real
// installed app.
if (shouldPinDevUserData(app)) {
  app.setPath('userData', resolveDevUserDataPath(app.getPath('appData')))
}

// SHELL-06: single-instance enforcement. This is the ONE *lifecycle*
// registration in this entire file that must run BEFORE app.whenReady(),
// unlike every other registration below -- a second launch can fire
// 'second-instance' on this process before this process's own whenReady()
// has resolved, and Electron's own docs specify the lock must be requested
// as early as possible to avoid that race. requestSingleInstanceLock()
// itself is synchronous and safe to call at module top level. (The
// userData pin immediately above it is not a lifecycle registration -- it
// is a setPath() call that must precede this block for the unrelated
// reason documented there.)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // This process lost the race for the lock -- another instance is already
  // running. Quit immediately; nothing below (including app.whenReady())
  // should do meaningful work for this process.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    // argv shape differs between a packaged app (argv[0] is the exe path)
    // and `electron .` in dev (extra leading args before the app path) --
    // filter by suffix rather than a fixed index so both shapes work. The
    // full traversal/NUL-byte validation happens downstream via
    // isSafeFilePath when the renderer's openFileAtPath round-trips this
    // through the file:open-path IPC handler (04-02) -- this filter is a
    // relevance check (is this even a markdown file?), not the security
    // boundary.
    const candidate = argv.find((arg) => MD_FILE_RE.test(arg))
    if (!candidate) return

    // WR-04 (04-REVIEW.md): Electron's second-instance signature is
    // (event, argv, workingDirectory, additionalData) -- workingDirectory is
    // the SECOND instance's cwd, not this (primary) process's own. A
    // relative candidate must be resolved against that launch's working
    // directory, or it silently resolves against this process's own cwd
    // instead (ENOENT, or worse, a same-named file in the wrong directory).
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(workingDirectory, candidate)
    win.webContents.send('file:external-open-path', resolved)
  })
}

app.whenReady().then(async () => {
  // Must run before any Jump-List/recent-documents-touching code (06-02's
  // recents-store.js). PERS-07's locked decision: setAppUserModelId MUST
  // equal the eventual electron-builder.yml appId, or both the Windows
  // Jump List and the recent-documents list silently fail (06-RESEARCH.md
  // Pitfall 5). Phase 8's production config MUST use this exact string,
  // distinct from the current throwaway spike config's
  // 'com.markey.mdforge.spike'.
  app.setAppUserModelId('com.markey.mdforge')

  // EDIT-03 (18-03, spellcheck-default-language-not-forced): Electron/Chromium's
  // spellchecker is enabled by default, but its SESSION LANGUAGE, left
  // unconfigured, is whatever Chromium derives from the OS locale -- and
  // that derived default is not documented to be guaranteed for every OS
  // locale. Explicitly resolving and setting a language closes that gap
  // unconditionally, on every launch, rather than trusting an unconfigured
  // default -- explicit over implicit, matching this codebase's existing
  // convention (updater.js's autoUpdater.autoInstallOnAppQuit = true
  // comment: "even though [it matches] ... defaults, explicitness is a
  // phase success criterion"). Prefers a candidate derived from
  // app.getLocale() when Chromium's own dictionary list recognises it;
  // falls back to 'en-US' -- the one value Phase 9's own measurement proved
  // reliably triggers a dictionary download in this project's environment,
  // for the case where the OS locale is NOT in that list at all.
  //
  // [18-03 Task 2 CORRECTION, 2026-09-16] Phase 9's own spike claimed this
  // machine's OS-derived default ('en-GB') "never even attempted a
  // dictionary download across 25 real attempts", implying spellcheck could
  // not work at all without an explicit language override. Phase 18's own
  // re-verification (tests/e2e/spellcheck-spike.spec.js's new "cold profile"
  // test, using the ALREADY-CORRECTED rig -- realistic typing cadence, a
  // settle wait, no dblclick -- that Phase 9 itself later applied to fix an
  // unrelated false negative) found this claim does NOT hold today: 6 real
  // runs against a genuinely cold, never-launched-before profile, with this
  // very call REMOVED (a canary), still resolved 'en-GB' via Chromium's own
  // internal default and passed 6/6, with ZERO network requests observed in
  // every run. The most likely explanation is that Phase 9's original
  // "0/25" finding was itself an instance of the SAME rig defect (rapid
  // synthetic typing outrunning Chromium's async spellcheck pass) that Phase
  // 9's own later correction fixed for the CM6-vs-textarea question -- not a
  // genuine absence of a downloadable dictionary for en-GB. This call is
  // KEPT regardless: it remains a real, defensible correctness improvement
  // (explicit configuration, a diagnosable log line, and a genuine
  // 'en-US' safety net for any OS locale that is NOT already in Chromium's
  // own availableSpellCheckerLanguages list, a case this machine's own
  // locale does not exercise) -- but its demonstrated necessity on THIS
  // machine's own locale is weaker than originally believed, and that
  // correction is recorded here rather than left as a stale, disproven claim.
  // Must run before any window shows (this is the earliest point in the
  // ready handler, immediately after setAppUserModelId) so the session's
  // spellchecker is configured before the renderer's first paint.
  const availableSpellCheckerLanguages = session.defaultSession.availableSpellCheckerLanguages
  const localeCandidate = app.getLocale()
  const resolvedSpellCheckerLanguage = availableSpellCheckerLanguages.includes(localeCandidate)
    ? localeCandidate
    : 'en-US'
  session.defaultSession.spellCheckerEnabled = true
  session.defaultSession.setSpellCheckerLanguages([resolvedSpellCheckerLanguage])
  log.info(
    `[spellcheck] resolved session language: ${resolvedSpellCheckerLanguage} ` +
    `(app.getLocale()="${localeCandidate}", ` +
    `matched available: ${availableSpellCheckerLanguages.includes(localeCandidate)})`
  )

  registerAppProtocol()

  // --- 06-04: startup restore-plan composition, resolved BEFORE
  // createWindow so the window can be held hidden (window.js's show-gate)
  // until the renderer has consumed a plan that already existed the
  // instant its synchronous restore:get-plan sendSync call fires.
  const draftsDir = path.join(app.getPath('userData'), 'drafts')
  await ensureDraftsDirExists(draftsDir)
  const { valid: validDrafts, corruptCount } = await scanDraftsDir(draftsDir)

  // Conflict check (PERS-02): a recovered draft whose original file
  // changed on disk since the crash is flagged, never silently resolved
  // either way.
  const recoveryEntries = []
  for (const entry of validDrafts) {
    let conflicted = false
    if (entry.filePath) {
      if (entry.originalStat === null) {
        // Untitled document, or the original file didn't exist/wasn't
        // readable at journal-write time -- nothing to compare against.
        conflicted = false
      } else {
        try {
          const stat = await fsPromises.stat(entry.filePath)
          conflicted = stat.mtimeMs !== entry.originalStat.mtimeMs || stat.size !== entry.originalStat.size
        } catch {
          // File vanished since the crash.
          conflicted = true
        }
      }
    }
    recoveryEntries.push({
      filePath: entry.filePath,
      draftUuid: entry.uuid,
      name: entry.name,
      content: entry.content,
      dirty: true,
      scrollTop: 0,
      conflicted,
      active: false,
      source: 'recovery'
    })
  }

  let skippedCount = 0

  // FIRST launch's own argv (distinct from the 'second-instance' handler
  // above, which has its own separately-resolved workingDirectory) --
  // relative candidates resolve against this process's own cwd.
  const argvEntries = []
  for (const candidate of process.argv.filter((arg) => MD_FILE_RE.test(arg))) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate)
    if (!isSafeFilePath(resolved)) {
      skippedCount++
      continue
    }
    try {
      await fsPromises.stat(resolved)
      const content = await fsPromises.readFile(resolved, 'utf8')
      argvEntries.push({
        filePath: resolved,
        draftUuid: null,
        name: path.basename(resolved),
        content,
        dirty: false,
        scrollTop: 0,
        conflicted: false,
        active: false,
        source: 'argv'
      })
    } catch {
      skippedCount++
    }
  }

  // Remaining session tabs (PERS-04/06) -- a tab with only a draftUuid (an
  // untitled document dirty at last session save) is skipped here, not
  // counted as skipped/failed: if its draft still exists it is already
  // present via recoveryEntries, and composeRestorePlan's own draftUuid
  // dedup handles that naturally; if the draft is gone, there is nothing
  // left to restore for it, which is not a failure either.
  const sessionState = getSessionState()
  const sessionEntries = []
  for (let i = 0; i < sessionState.tabs.length; i++) {
    const tab = sessionState.tabs[i]
    if (!tab || typeof tab !== 'object') continue
    if (typeof tab.filePath === 'string') {
      if (!isSafeFilePath(tab.filePath)) {
        skippedCount++
        continue
      }
      try {
        await fsPromises.stat(tab.filePath)
        const content = await fsPromises.readFile(tab.filePath, 'utf8')
        sessionEntries.push({
          filePath: tab.filePath,
          draftUuid: null,
          name: path.basename(tab.filePath),
          content,
          dirty: false,
          scrollTop: typeof tab.scrollTop === 'number' ? tab.scrollTop : 0,
          // [15-02, PERS-11] Pure pass-through -- main's own "read/write
          // electron-store faithfully" responsibility (per restore-plan.js's
          // header comment) means no deeper validation belongs here;
          // restoreHistoryState (Plan 15-01, renderer side) already owns
          // every correctness check (parse/shape/doc-match/bounds/version-
          // mismatch). A type guard here only prevents a non-string value
          // (e.g. a hand-edited object/number in config.json) from ever
          // reaching the IPC boundary as `history` -- coerced to `null`,
          // which createDocument's existing default already treats as "no
          // history."
          history: typeof tab.history === 'string' ? tab.history : null,
          conflicted: false,
          active: i === sessionState.activeIndex,
          source: 'session'
        })
      } catch {
        skippedCount++
      }
    }
    // else: no filePath -- either only a draftUuid (handled via
    // recoveryEntries's own dedup, see comment above) or a malformed entry
    // with neither; both are silently skipped without incrementing
    // skippedCount, since neither is a resolvable-but-failed restore.
  }

  const plan = composeRestorePlan(recoveryEntries, argvEntries, sessionEntries)

  // Registered BEFORE createWindow so it is ready the instant the
  // renderer's synchronous sendSync fires during page load.
  ipcMain.on('restore:get-plan', (event) => {
    event.returnValue = {
      plan,
      recoveredCount: recoveryEntries.length,
      skippedCount,
      corruptCount,
      conflictedCount: recoveryEntries.filter((e) => e.conflicted).length
    }
  })
  registerDraftsIpc(draftsDir)
  registerSessionIpc()
  // --- end 06-04 startup sequencing ---

  const restoredBounds = validatedBoundsForRestore()
  win = createWindow(store.get('theme'), restoredBounds)
  hardenWindow(win)
  registerThemeIpc(win)
  registerImageFetchIpc()
  registerTextFileIpc()
  registerDialogsIpc(win)
  registerWindowTitleIpc(win)
  // EDIT-03's right-click half. Chromium underlines misspellings on its own,
  // but suggestions only reach the app via the 'context-menu' event -- without
  // a listener the underline appears and right-clicking does nothing (v1.0 UAT).
  registerSpellcheckMenu(win)

  // PERS-05 seed-timing fix (11-02): restoredBounds.maximized is the
  // INTENDED restore-time value, already computed above by
  // validatedBoundsForRestore() -- independent of whatever a live
  // win.isMaximized() read on `win` reports at this exact registration
  // moment (createWindow() may have already attempted, and per
  // electron/electron#834 possibly failed, to apply it while hidden).
  registerWindowStatePersistence(win, restoredBounds.maximized)
  registerExportIpc(win)
  registerBeforeQuit(win, draftsDir)

  // 08-03 (SHELL-05): honest, one-time first-run nudge toward becoming the
  // default .md handler -- shown at most once per userData profile
  // (default-app-prompt.js's own electron-store flag).
  //
  // [08 regression fix, PERS-05] Deferred to 'show' rather than fired here.
  // The previous comment claimed a message box against a not-yet-visible
  // window was harmless; it is not. It is MODAL and parented to `win`, so
  // while it is up the window cannot change state -- win.maximize() is
  // silently ignored, which broke maximized-state persistence outright.
  // It is also poor first-run UX: a modal that lands before the user has
  // even seen the app. Waiting for 'show' costs nothing and removes both
  // problems. Still not awaited -- nothing downstream depends on the answer.
  win.once('show', () => { maybeShowDefaultAppPrompt(win) })

  // 08-02 (DIST-02/03/04): checkForUpdatesAndNotify's own internal
  // isUpdaterActive() guard makes this safe to call unconditionally here;
  // no functional ordering requirement relative to the other registerXIpc
  // calls, since electron-updater's own quit-install listener attaches
  // lazily only after a download completes (see updater.js's header
  // comment for the full 'quit'-vs-'before-quit' proof).
  registerUpdaterIpc(win)

  // 07-06 (WORK-01): the three Wave-1/2 workspace services (lazy directory
  // listing, create/rename/delete mechanism, root open/close + watcher
  // orchestration), registered alongside every other registerXIpc(win)
  // call above. registerWorkspaceTreeIpc/registerWorkspaceFileopsIpc take
  // no `win` argument -- neither sends unsolicited renderer notifications,
  // unlike registerWorkspaceRootIpc which does (root-opened/closed,
  // external-change/vanish).
  registerWorkspaceTreeIpc()
  registerWorkspaceFileopsIpc()
  registerWorkspaceRootIpc(win)
  // 07-08 (WORK-03): the tree's native context menu (New File/Rename/Delete)
  // + the one confirm-and-delete function shared by the menu's Delete item
  // and the renderer's own Delete-key path.
  registerWorkspaceContextMenuIpc(win)

  // 06-06 (PERS-07): every mutation to the recents list (add-document,
  // report-open-failure, clear) must rebuild the live application menu so
  // File > Open Recent never shows a stale snapshot -- Pattern 4 (rebuild,
  // not mutate). rebuildMenu is passed to registerRecentsIpc as its
  // onChanged callback and also used for Clear Recently Opened's own click
  // handler and this plan's initial call, so all three routes share the
  // exact same recents-store.getRecents() read.
  // 07-06 (WORK-01): threads getRecents().folders as buildMenu's fourth
  // argument so File > Recent Folders never shows a stale snapshot either.
  function rebuildMenu () {
    buildMenu(win, getRecents().documents, () => {
      clearAllRecents()
      rebuildMenu()
    }, getRecents().folders)
  }
  rebuildMenu()
  registerRecentsIpc(win, rebuildMenu)
  // 07-06 (WORK-01, Rule 2 auto-fix): opening/closing a workspace root
  // (dialog, Recent Folders click, or the workspace:open-folder/
  // close-folder IPC handlers) must also rebuild the menu, or "Close
  // Folder"'s presence and "Recent Folders"'s contents go stale until an
  // unrelated recents-document change happens to rebuild it. Same
  // rebuildMenu function as registerRecentsIpc's onChanged callback above
  // -- one menu-rebuild trigger, not two independently-typed ones.
  setWorkspaceRootChangeListener(rebuildMenu)

  // Dev-only zero-network diagnostic (SHELL-10). Consistent with the locked
  // decision not to add @electron-toolkit/utils' `is.dev` — presence of
  // ELECTRON_RENDERER_URL is electron-vite's own dev-mode indicator. This is
  // observational only (never blocks a request) so devtools itself keeps
  // working; the CI-facing proof is tests/e2e/no-network.spec.js, which is
  // scoped to the renderer's own webContents requests and therefore never
  // sees main-process-initiated net.fetch calls (e.g. the image-fetch bridge
  // added in Task 3) in the first place.
  if (process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const isAppResource = details.url.startsWith('app://') || details.url.startsWith('devtools://')
      if (!isAppResource) {
        console.error('[SHELL-10 VIOLATION] Unexpected network request:', details.method, details.url)
      }
      callback({})
    })
  }
})

// Without this, closing the only window leaves the main process alive with no
// UI and no way to reach it -- an orphaned background process the user can
// only kill via Task Manager, and one that keeps holding the single-instance
// lock and the electron-store file handle (01-REVIEW.md WR-01).
//
// The usual Electron boilerplate guards this with `process.platform !==
// 'darwin'`, because macOS convention is for an app to stay running when its
// last window closes. That guard is deliberately omitted: macOS is explicitly
// out of scope for this project (PROJECT.md "Out of Scope" -- notarisation
// requires a paid Apple developer account), so the branch could never be
// false and would be dead code pretending to be portable. If macOS is ever
// added, restore the platform guard here and add the matching `activate`
// handler that recreates a window when the dock icon is clicked.
app.on('window-all-closed', async () => {
  // 07-06 (WORK-01): a running chokidar watcher (workspace-watcher.js) must
  // not hold the process open or leak a handle past the last window
  // closing. Safe to call even when no watcher is running (stopWorkspace
  // Watcher() is a no-op in that case).
  await stopWorkspaceWatcher()
  app.quit()
})
