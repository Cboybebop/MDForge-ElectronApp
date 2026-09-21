// SHELL-05's first-run "become the default .md handler" prompt.
//
// 08-RESEARCH.md Architecture Pattern 1 (the full analysis this file is
// built against): Windows has offered no supported programmatic way to
// claim a default file handler since Windows 8 --
// `IApplicationAssociationRegistration.SetAppAsDefault` is documented
// unsupported, and the actual default lives in the hash-protected
// `HKCU\...\Explorer\FileExts\.md\UserChoice` key, which no installer or app
// can validly write. The Don't-Hand-Roll table names writing `UserChoice`
// directly (or a third-party `SetUserFTA`-style tool) as the explicit
// "malware-adjacent" pattern this project must never implement -- not here,
// not anywhere. This file contains no such write, and never will.
//
// What this file CAN honestly do: point the user at Windows' own Default
// Apps settings page (`ms-settings:defaultapps`) and tell them, truthfully,
// that THEY choose MD Forge there -- MD Forge cannot set this for them. Per
// 08-RESEARCH.md Open Question 5, this deliberately uses the bare
// (non-deep-linked) settings URI rather than attempting the Windows
// 11 21H2+-only `?registeredAppUser=...` deep-link query parameters, so the
// same prompt behaves correctly on every supported Windows version rather
// than needing a second, version-detected code path for a nice-to-have.
//
// shouldPromptForDefaultApp is deliberately its own exported, `electron`-free
// function -- kept trivial today (`!hasAlreadyPrompted`) purely so it stays
// unit-testable with zero mocking. This codebase has no existing precedent
// for mocking the `electron` module in a Vitest test, and this file does not
// introduce one: maybeShowDefaultAppPrompt (the side-effecting half that
// touches `electron-store`/`dialog`/`shell`) is exercised only by e2e, never
// unit-tested directly.
import { dialog, shell } from 'electron'
import Store from 'electron-store'

function shouldPromptForDefaultApp (hasAlreadyPrompted) {
  return !hasAlreadyPrompted
}

// Shown at most once per userData profile. Unconditionally marks the prompt
// as shown regardless of which button the user picks -- this is a genuinely
// one-time nudge, not a nag that reappears until "Open Default Apps
// Settings" is clicked specifically.
//
// The `detail` copy is load-bearing: it describes what the USER must do in
// Settings, and explicitly states MD Forge cannot set this for them. Do not
// reword this into a claim that MD Forge itself sets, changes, or requests
// the default -- that would misstate what is actually happening and drift
// toward the exact "malware-adjacent" framing this file's header warns
// against.
async function maybeShowDefaultAppPrompt (win) {
  // Constructed lazily, inside the function, not at module scope --
  // electron-store's Conf backing requires a real Electron `app` (for
  // `app.getPath('config')`/`app.name`) to resolve its storage path.
  // Instantiating it at module load time would make importing this file at
  // all (e.g. tests/main/default-app-prompt.test.js importing only
  // shouldPromptForDefaultApp) throw outside a running Electron process --
  // confirmed by construction: `new Store(...)` at module scope threw
  // "Please specify the `projectName` option" under Vitest's node
  // environment, since `conf` cannot infer a project name/storage path
  // without `app.getPath`.
  // [08 regression fix] Every e2e spec launches with a pristine
  // --user-data-dir, so EVERY automated launch looks like a first run and
  // would raise this modal. That is an artefact of test isolation, not a
  // behaviour worth re-proving in ~40 specs -- and a modal parented to the
  // window blocks window-state changes while it is up. tests/e2e/helpers/
  // launch.js sets this by default; a spec that wants to exercise the
  // prompt itself simply omits it. Mirrors updater.js's own
  // MDFORGE_UPDATE_FEED_URL test-seam precedent.
  if (process.env.MDFORGE_SKIP_FIRST_RUN_PROMPT === '1') return

  const store = new Store({ defaults: { hasPromptedDefaultApp: false } })
  const hasAlreadyPrompted = store.get('hasPromptedDefaultApp')
  if (!shouldPromptForDefaultApp(hasAlreadyPrompted)) return

  const result = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Open Default Apps Settings', 'Not Now'],
    message: 'Want .md files to open in MD Forge automatically?',
    detail:
      'Windows keeps default-app choices under your control. Click below to open ' +
      'Settings, then choose MD Forge for .md files yourself — MD Forge cannot set ' +
      'this for you.'
  })

  store.set('hasPromptedDefaultApp', true)

  if (result.response === 0) {
    shell.openExternal('ms-settings:defaultapps')
  }
}

export { shouldPromptForDefaultApp, maybeShowDefaultAppPrompt }
