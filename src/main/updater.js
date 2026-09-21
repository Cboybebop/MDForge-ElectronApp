// DIST-02/DIST-03/DIST-04: the real auto-update runtime mechanism. Checked on
// launch, downloaded silently, installed only on quit -- entirely by wiring
// electron-updater's own defaults, not by adding new coordination code.
//
// 08-RESEARCH.md Architecture Pattern 2 (verified directly against the
// installed electron-updater@6.8.9 source in node_modules/electron-updater/
// out/BaseUpdater.js + ElectronAppAdapter.js): autoInstallOnAppQuit's
// internal listener is registered lazily -- only after a download
// completes -- and binds solely to Electron's 'quit' event via
// `app.once("quit", ...)`, never 'before-quit'. Electron's 'quit' event
// fires only after 'before-quit' -> 'window-all-closed' -> 'will-quit' have
// all already resolved without a preventDefault(). This project's
// src/main/before-quit.js (Phases 4-6) intercepts and resolves its own
// save/discard/cancel handshake entirely on 'before-quit', synchronously
// calling event.preventDefault() until the renderer answers, and only
// calling app.quit() for real once quitConfirmed is true. By construction,
// electron-updater's quit-triggered install cannot fire before that
// handshake has resolved -- there is no race here, and no new listener is
// added anywhere in this file or in before-quit.js. tests/updater-quit-
// binding.test.js (Task 3) is the regression guard against a future
// electron-updater major bump silently changing this binding.
import { app, ipcMain, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'
import semver from 'semver'

// registerXIpc(win) shape, matching src/main/theme-store.js/window.js's
// established convention -- `win` passed explicitly, never captured as a
// module-level global.
function registerUpdaterIpc (win) {
  autoUpdater.logger = log
  log.transports.file.level = 'info'

  // 08-RESEARCH.md Code Example 1 / Common Pitfall 4: already the library
  // default (autoDownload: true, autoInstallOnAppQuit: true) -- set
  // explicitly anyway, matching this codebase's explicitness convention
  // (src/main/window.js's security-flags comment: "even though they match
  // ... defaults, explicitness is a phase success criterion").
  autoUpdater.autoInstallOnAppQuit = true

  // Rule 1 fix (discovered building 08-03-PLAN.md Task 3's e2e spec):
  // isUpdaterActive() gates checkForUpdates()/checkForUpdatesAndNotify() on
  // `app.isPackaged || this.forceDevUpdateConfig` UNCONDITIONALLY -- it has
  // no awareness of setFeedURL() having been called. Without this line
  // hoisted above the branch below, an unpackaged run (every `npm run dev`
  // launch, and every Playwright e2e launch, including 08-03's own
  // updater.spec.js) with MDFORGE_UPDATE_FEED_URL set would still resolve
  // checkForUpdates() to `null` immediately -- silently skipping the check
  // against the very fake feed this env var exists to point at
  // [VERIFIED: node_modules/electron-updater/out/AppUpdater.js
  // isUpdaterActive()/getUpdateInfoAndProvider()]. setFeedURL() below
  // already makes getUpdateInfoAndProvider() bypass configOnDisk (and thus
  // dev-app-update.yml) entirely for provider selection once clientPromise
  // is non-null, so forcing this here does not make dev-app-update.yml get
  // read a second time in that branch.
  autoUpdater.forceDevUpdateConfig = !app.isPackaged

  // 08-03-PLAN.md's e2e spec points this at a local fake feed server via
  // MDFORGE_UPDATE_FEED_URL, bypassing both the real GitHub provider and
  // dev-app-update.yml -- the deterministic hook for driving a real
  // update-available/update-downloaded cycle without a real GitHub release.
  //
  // [18-02, CR-01-class fix] Gated on `!app.isPackaged`, mirroring
  // src/main/index.js's own `!app.isPackaged && process.env.MDFORGE_TEST_APPDATA_DIR`
  // gate (10-REVIEW.md CR-01). Without this guard, a PACKAGED, installed copy
  // of MD Forge launched with this env var set (a tampered shortcut, a
  // wrapper script, a persistent user-level environment variable) could
  // redirect the auto-update feed itself to an attacker- or
  // misconfiguration-controlled URL -- a larger blast radius than the
  // sibling MDFORGE_TEST_APPDATA_DIR seam, since the update feed controls
  // what binary the app later downloads and installs. See
  // .planning/todos/resolved/mdforge-update-feed-url-ungated-in-packaged-build.md
  // and tests/packaging-config.test.js's matching static regression lock.
  if (!app.isPackaged && process.env.MDFORGE_UPDATE_FEED_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MDFORGE_UPDATE_FEED_URL })
  }
  // else: 08-RESEARCH.md Common Pitfall 5 -- dev-app-update.yml is only
  // actually consulted (not just present-but-unused) when
  // forceDevUpdateConfig is set for an unpackaged run, which the line above
  // now covers unconditionally.

  // Safe to call unconditionally, packaged or dev, forced or not --
  // AppUpdater.js's own isUpdaterActive() guard
  // (`app.isPackaged || this.forceDevUpdateConfig`) already gates this
  // internally [VERIFIED: node_modules/electron-updater/out/AppUpdater.js].
  autoUpdater.checkForUpdatesAndNotify()

  ipcMain.handle('updater:check-now', () => autoUpdater.checkForUpdates())
  ipcMain.handle('updater:get-version', () => app.getVersion())

  // 08-03-PLAN.md Task 1: test-only escape hatch for tests/e2e/updater.spec.js,
  // gated strictly behind an env var no packaging config in this project ever
  // sets (electron-builder.yml has no env/extraMetadata entry setting it --
  // confirmed absent; T-8-09's mitigation). checkNow()/setFeedURL() give the
  // e2e spec a deterministic way to drive a real check against a local fake
  // feed via Playwright's electronApp.evaluate(), instead of racing the
  // automatic on-launch checkForUpdatesAndNotify() call above.
  // lastDialogMessage is written by triggerManualCheck() below (same env
  // guard) so the spec can read back what the manual-check dialog would have
  // shown, without trying to intercept a real native dialog.
  if (process.env.MDFORGE_E2E_TEST_HOOKS === '1') {
    globalThis.__mdforgeUpdaterTestHooks = {
      checkNow: () => autoUpdater.checkForUpdates(),
      setFeedURL: (opts) => autoUpdater.setFeedURL(opts),
      lastDialogMessage: null
    }
  }
}

// Records the dialog message triggerManualCheck() is about to show onto the
// test-only hook object, when (and only when) registerUpdaterIpc() attached
// one -- see that function's env-guard comment above. A no-op call in every
// packaged build.
function recordTestDialogMessage (message) {
  if (process.env.MDFORGE_E2E_TEST_HOOKS === '1' && globalThis.__mdforgeUpdaterTestHooks) {
    globalThis.__mdforgeUpdaterTestHooks.lastDialogMessage = message
  }
}

// 08-03-PLAN.md (DIST-03): the manual-check escape hatch -- must work even
// when the automatic checker is broken, per 08-CONTEXT.md's locked decision.
// Reports the installed version either way: "update available" (with the
// version that will install on next quit, matching DIST-04's install-on-quit
// mechanism -- never implies an immediate install) or "up to date", using the
// SAME autoUpdater.checkForUpdates() call the automatic path uses, so this
// dialog can never diverge from what the real updater actually found.
function triggerManualCheck (win) {
  return autoUpdater.checkForUpdates().then(
    (result) => {
      const updateInfo = result && result.updateInfo
      let message
      if (!updateInfo) {
        // AppUpdater.js's own isUpdaterActive() guard returned false (not
        // packaged, no forceDevUpdateConfig, no MDFORGE_UPDATE_FEED_URL) --
        // checkForUpdates() resolves null rather than rejecting. Honest,
        // not an error.
        message = 'Update check is unavailable in this environment.'
      } else if (semver.gt(updateInfo.version, app.getVersion())) {
        message = `Update available: v${updateInfo.version} — it will install automatically the next time you quit.`
      } else {
        message = `You're up to date (v${app.getVersion()}).`
      }
      recordTestDialogMessage(message)
      dialog.showMessageBox(win, { message })
      return result
    },
    (error) => {
      const message = `Update check failed: ${error && error.message ? error.message : String(error)}`
      recordTestDialogMessage(message)
      dialog.showMessageBox(win, { type: 'error', message })
      throw error
    }
  )
}

export { registerUpdaterIpc, triggerManualCheck }
