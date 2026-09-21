// Regression tests for the dev-mode userData pin (BRAND-02 / 10-RESEARCH.md
// Open Question 2, RESOLVED: PIN, do not accept the relocation -- see
// dev-userdata.js's own header comment for the full data-safety hazard this
// closes).
//
// These run under plain Node -- no jsdom, no Electron -- because
// dev-userdata.js deliberately has no `electron` import. Mirrors
// path-guard.test.js's shape: a fake `app`-shaped object stands in for the
// real Electron `app`, since these functions only read isPackaged and call
// commandLine.hasSwitch().
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { shouldPinDevUserData, resolveDevUserDataPath } from './dev-userdata.js'

describe('resolveDevUserDataPath', () => {
  it('returns a path whose basename is "MD Forge (dev)" -- NOT "MD Forge"', () => {
    const result = resolveDevUserDataPath('C:\\fake\\AppData\\Roaming')
    expect(path.basename(result)).toBe('MD Forge (dev)')
    // The literal collision-safety proof: the pinned dev basename can never
    // equal the packaged app's own productName-derived userData directory
    // name ('MD Forge', read live from package.json's productName added in
    // 10-02-PLAN.md Task 1 / electron-builder.yml's own productName).
    expect(path.basename(result)).not.toBe('MD Forge')
  })

  it('joins onto the supplied appData directory (does not hardcode a platform path)', () => {
    const result = resolveDevUserDataPath('/fake/home/.config')
    expect(result).toBe(path.join('/fake/home/.config', 'MD Forge (dev)'))
  })
})

describe('shouldPinDevUserData', () => {
  it('returns true for an unpackaged app with no --user-data-dir override', () => {
    const app = { isPackaged: false, commandLine: { hasSwitch: () => false } }
    expect(shouldPinDevUserData(app)).toBe(true)
  })

  it('returns false for a packaged app (never pin the real installed app)', () => {
    const app = { isPackaged: true, commandLine: { hasSwitch: () => false } }
    expect(shouldPinDevUserData(app)).toBe(false)
  })

  it('returns false when an explicit --user-data-dir is present -- the literal collision-safety proof: e2e isolation always wins over the dev pin', () => {
    // Mirrors the exact flag every real e2e launch in this suite already
    // passes (tests/e2e/helpers/launch.js's `--user-data-dir=${dir}`).
    const app = { isPackaged: false, commandLine: { hasSwitch: (s) => s === 'user-data-dir' } }
    expect(shouldPinDevUserData(app)).toBe(false)
  })

  it('returns false when both packaged AND an explicit --user-data-dir are present', () => {
    const app = { isPackaged: true, commandLine: { hasSwitch: (s) => s === 'user-data-dir' } }
    expect(shouldPinDevUserData(app)).toBe(false)
  })
})
