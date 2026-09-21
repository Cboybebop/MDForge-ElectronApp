// Dev-mode userData pin (BRAND-02 / 10-RESEARCH.md Open Question 2, RESOLVED:
// PIN, do not accept the relocation).
//
// Deliberately free of any `electron` import, matching this codebase's
// established testable-pure-function convention (src/main/path-guard.js,
// src/main/window-state.js) -- every value this module needs is passed in by
// the caller, so its decision logic can be unit-tested under plain Node
// without launching a real Electron process.
//
// WHY THIS MODULE EXISTS: 10-02-PLAN.md Task 1 added "productName": "MD
// Forge" to package.json (the correct package.json-level fix for the
// dev-run taskbar/app-name problem -- Electron reads productName
// preferentially over name at process boot, before any application code
// runs). But Electron's DEFAULT userData directory is ALSO derived from
// app.getName() the first time app.getPath('userData')/'appData' is read.
// Today, before this module lands, an unpackaged dev run with no
// productName resolves to %APPDATA%\md-forge-desktop; the packaged app
// (electron-builder's own productName: MD Forge, already present in
// electron-builder.yml) resolves to %APPDATA%\MD Forge. Once package.json
// also has productName: "MD Forge", an UNPINNED dev run would resolve to
// the SAME %APPDATA%\MD Forge directory the packaged app uses -- silently
// making a dev session read and write the same drafts/session/settings
// store as the user's real installed app. That is real data loss, not a
// theoretical concern, for an app whose whole job is persisting drafts.
//
// DECISION (stated plainly, not left implicit): PIN the dev-mode userData
// directory to a permanently distinct path ('MD Forge (dev)'), rather than
// accepting the relocation. Any EXISTING dev-mode data currently sitting at
// the OLD, unpinned default path (%APPDATA%\md-forge-desktop on this
// platform, before this module lands) is deliberately left untouched and
// ABANDONED IN PLACE -- it is NOT migrated to the new pinned location. This
// project's own standing constraint ("Autosave never writes to the user's
// .md file. Drafts only.") bounds the blast radius of that abandonment to
// disposable local dev caches, never real user documents.

import path from 'node:path'

/**
 * True only when the dev-mode userData pin should be applied: the app is
 * unpackaged AND no explicit --user-data-dir flag is present on the command
 * line. An explicit --user-data-dir (used by every real e2e launch in this
 * suite -- see tests/e2e/helpers/launch.js) must always win over this pin;
 * this function must never override it.
 *
 * @param {{ isPackaged: boolean, commandLine: { hasSwitch: (name: string) => boolean } }} app
 */
export function shouldPinDevUserData (app) {
  return app.isPackaged === false && app.commandLine.hasSwitch('user-data-dir') === false
}

/**
 * Resolves the pinned dev-mode userData directory: a name deliberately,
 * permanently distinct from the packaged app's own userData directory name
 * ('MD Forge', electron-builder's productName / package.json's productName
 * added in 10-02-PLAN.md Task 1).
 *
 * @param {string} appDataDir - app.getPath('appData')
 */
export function resolveDevUserDataPath (appDataDir) {
  return path.join(appDataDir, 'MD Forge (dev)')
}
