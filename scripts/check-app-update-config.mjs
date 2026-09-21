#!/usr/bin/env node
// DIST-01/criterion-5 self-enforcing check -- the 6th fail-closed gate.
// Modeled on scripts/check-no-fsa.mjs's structure and philosophy: a missing
// build artifact is a hard error, never a silent pass; the violation is
// named explicitly; the gate is proven by construction (see
// 08-01-SUMMARY.md), not trusted on convention alone.
//
// Asserts the CORRECT thing (08-RESEARCH.md Common Pitfall 3): the packaged
// app-update.yml must NOT contain a publisherName key. A gate asserting the
// literal string "verifyUpdateCodeSignature: false" would fail forever --
// traced through node_modules/app-builder-lib/out/publish/PublishManager.js's
// getAppUpdatePublishConfiguration(), that key is never serialized into this
// file for an unsigned build, regardless of the source config's
// win.verifyUpdateCodeSignature value. publisherName's absence is what
// actually governs whether electron-updater's NsisUpdater.verifySignature()
// fails open at runtime -- assert that instead. Do not "fix" this back to a
// literal verifyUpdateCodeSignature match; a future reader who does will
// make the gate permanently unpassable.
//
// Requires a FULL NSIS build first (`npx electron-builder --win`), NOT
// `--win --dir`. Empirically confirmed this plan (08-01): a `--dir` build
// resolves to app-builder-lib's DIR_TARGET ("dir"), and
// PublishManager.js's isSuitableWindowsTarget() only allows "nsis"/"nsis-*"/
// electronUpdaterAware "appx" targets through the onAfterPack hook that
// writes app-update.yml -- so a --dir build never produces this file at all
// for this project's target config. 08-RESEARCH.md Code Example 5 assumed
// --dir would suffice; that assumption did not hold and was corrected here.
import { readFileSync, existsSync } from 'node:fs'
import { load } from 'js-yaml' // already a transitive dep via electron-updater

const APP_UPDATE_YML = 'dist/win-unpacked/resources/app-update.yml'

if (!existsSync(APP_UPDATE_YML)) {
  console.error(`Gate FAILED: ${APP_UPDATE_YML} not found.`)
  console.error('Run `npm run build && npx electron-builder --win` first -- a FULL NSIS')
  console.error('build, not `--win --dir`. A --dir build resolves to the "dir" pseudo-target,')
  console.error('which electron-builder\'s PublishManager.js excludes from the app-update.yml')
  console.error('write step (isSuitableWindowsTarget only allows nsis/nsis-*/appx).')
  process.exit(1)
}

const config = load(readFileSync(APP_UPDATE_YML, 'utf8'))

if (config.publisherName != null) {
  console.error(`Gate FAILED: ${APP_UPDATE_YML} has a publisherName set ("${config.publisherName}").`)
  console.error('Unsigned-update verification will NOT fail open as intended -- see')
  console.error('08-RESEARCH.md Common Pitfall 3 and this file\'s header comment.')
  process.exit(1)
}

console.log(`Gate passed: ${APP_UPDATE_YML} has no publisherName -- unsigned auto-update will fail open as designed.`)
