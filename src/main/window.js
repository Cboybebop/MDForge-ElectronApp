// BrowserWindow factory with all four security flags written out explicitly
// (contextIsolation, nodeIntegration, sandbox, webSecurity) — even though they
// match Electron 43 defaults, explicitness is a phase success criterion.
// See 01-CONTEXT.md "Loading, Protocol & Security Posture (O7)".
import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

// `restoredBounds` comes from window-state.js's `validatedBoundsForRestore()`
// -- x/y are only ever present when they already passed the vanished-monitor
// check, so they are spread in unconditionally when present and omitted
// (letting BrowserWindow center itself) otherwise.
// 06-RESEARCH.md Pattern 1's literal show-gate timeout: long enough that a
// normal restore (drafts scan + session read + tab build) always finishes
// well within it, short enough that a genuine renderer-side restore bug
// cannot leave the user staring at an invisible window for more than a few
// seconds. win.show() on an already-visible window is a documented-harmless
// no-op, so this fallback never double-shows anything.
const SHOW_GATE_TIMEOUT_MS = 5000

// 06-CONTEXT.md "restore before first paint": literal --bg token values
// from tokens.css (main.js cannot read a CSS custom property), selected by
// the same initialThemeArg createWindow already threads through to preload
// via additionalArguments. Defaults to the dark value for 'system'/undefined
// since dark is this app's :root fallback (tokens.css header comment).
const BG_DARK = '#0f1117'
const BG_LIGHT = '#faf8f5'

function createWindow (initialThemeArg, restoredBounds = {}) {
  const { x, y, width, height, maximized } = restoredBounds
  const backgroundColor = initialThemeArg === 'light' ? BG_LIGHT : BG_DARK
  const win = new BrowserWindow({
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    show: false,
    backgroundColor,
    // BRAND-01 (10-02-PLAN.md Task 3): dev-mode-only window/taskbar icon.
    // In a packaged build there is no build/ directory shipped (electron-
    // builder.yml's files: list only ships out/**/*), so this path would
    // not resolve there -- and it doesn't need to: the packaged app already
    // gets its correct icon from the PE resource electron-builder embeds at
    // build time (win.icon, wired in Task 1). Gated on the same
    // ELECTRON_RENDERER_URL dev-mode indicator this function already
    // branches on two lines below for loadURL, and index.js's SHELL-10
    // diagnostic (10-RESEARCH.md Pitfall 4).
    ...(process.env.ELECTRON_RENDERER_URL
      ? { icon: path.join(__dirname, '../../build/icon.ico') }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Delivers the persisted theme to preload with zero IPC round-trip.
      // Not the primary pre-paint mechanism (see theme-store.js / preload
      // index.js), but wired here now so Task 3's documented fallback path
      // (01-RESEARCH.md Open Question 1) costs nothing extra if ever needed.
      additionalArguments: initialThemeArg ? [`--initial-theme=${initialThemeArg}`] : []
    }
  })

  // 05-UI-SPEC.md Surface 4 mechanism note: without this, Chromium
  // re-asserts index.html's static `<title>MD Forge</title>` on its own
  // 'page-title-updated' event and silently overwrites every win.setTitle()
  // call registerWindowTitleIpc() below makes.
  win.on('page-title-updated', (e) => e.preventDefault())

  // 06-RESEARCH.md Pattern 1 / Pitfall 4: `ready-to-show` alone only proves
  // Chromium painted A frame -- it says nothing about whether THIS app's own
  // restore JS has finished building tabs from the composed restore plan.
  // Relying on it alone reproduces exactly the "empty editor flash, then
  // repopulate" bug 06-CONTEXT.md forbids. win.show() is gated on BOTH this
  // signal AND the renderer's own 'app:restore-complete' signal, whichever
  // fires later, with a bounded timeout fallback so a renderer-side restore
  // bug can never leave the window permanently hidden.
  //
  // Registered on THIS win's own creation (not module-load time) so a
  // future multi-window scenario would not collide -- today there is only
  // ever one window, so this distinction has no observable effect yet.
  let readyToShow = false
  let restoreComplete = false
  const maybeShow = () => {
    if (!readyToShow || !restoreComplete) return
    win.show()
    // PERS-05 (11-02): the 4th, previously-untried maximize() sequencing
    // variant (11-RESEARCH.md "Honest assessment for the planner", item 2).
    // STATE.md records three prior attempts, all producing identical
    // failure: (1) maximize() in the constructor, before this window is
    // ever shown (the code this replaces, and what electron/electron#834
    // documents directly -- maximize() does not take effect on Windows
    // while hidden); (2) on Electron's own asynchronous 'show' event
    // (win.on('show', () => win.maximize())); (3) one tick after that. This
    // is the 4th: a direct SYNCHRONOUS continuation of THIS app's own
    // win.show() call above, inside the two-signal gate itself, once both
    // readyToShow && restoreComplete are true -- not a reaction to
    // Electron's own 'show' event (which fires asynchronously relative to
    // the actual OS-level show and was already tried as variant 2). No
    // BrowserWindow constructor option exists to start a window already
    // maximized (electron/electron#34368, open, unresolved) and
    // maximize()/unmaximize() have the documented side effect of
    // force-showing a hidden window (electron/electron#2262) -- both facts
    // rule out any alternative ordering relative to show:false other than
    // "show, then maximize". Task 3 records this variant's real, observed
    // outcome (fixed vs. platform ceiling) rather than assuming it.
    if (maximized) win.maximize()
  }

  win.once('ready-to-show', () => {
    readyToShow = true
    maybeShow()
  })
  ipcMain.once('app:restore-complete', () => {
    restoreComplete = true
    maybeShow()
  })
  // [WR-01, 06-REVIEW.md] This timer is armed unconditionally on every
  // createWindow() call and is NOT cleared once maybeShow() above has
  // already shown the window through the normal two-signal gate --
  // win.show() on an already-visible window is a documented-harmless
  // no-op, so that half was always fine. What was NOT fine: calling almost
  // any BrowserWindow method, including .show(), on a window the user has
  // since CLOSED (destroyed) throws "Object has been destroyed" in
  // Electron -- a user who launches and quits within SHOW_GATE_TIMEOUT_MS
  // would trigger an uncaught main-process exception from this exact
  // dangling timer. Guarded with isDestroyed() and cleared on 'closed' so
  // neither half of that failure mode can happen.
  //
  // [WR-02, 11-REVIEW.md] Routed through the SAME maybeShow() path the
  // normal two-signal gate uses, rather than calling win.show() directly.
  // Previously this timer called win.show() directly, which silently
  // dropped the maximize() call (relocated into maybeShow() by this phase)
  // whenever one of the two normal gate signals -- 'ready-to-show' or the
  // renderer's own 'app:restore-complete' IPC -- never fired AT ALL, in
  // which case a genuinely maximized restore would ship de-maximized with
  // no diagnostic. Forcing both flags true before calling maybeShow() makes
  // this fallback maximize whenever `maximized` is true, exactly like the
  // normal gate. If maybeShow() already ran via the normal gate before this
  // timer ever fires, forcing the flags again and re-calling it is a
  // documented-harmless no-op (win.show() on an already-visible window;
  // win.maximize() on an already-maximized window). The console.warn is
  // deliberate: this path only runs when one of the two gate signals never
  // fired at all -- an already-serious restore failure -- so it should be
  // diagnosable, not silent.
  const showGateTimer = setTimeout(() => {
    if (win.isDestroyed()) return
    if (!readyToShow || !restoreComplete) {
      console.warn('[window] show-gate timeout fired before both signals resolved -- forcing show via maybeShow() so a pending maximize() is not silently dropped')
    }
    readyToShow = true
    restoreComplete = true
    maybeShow()
  }, SHOW_GATE_TIMEOUT_MS)
  win.once('closed', () => clearTimeout(showGateTimer))

  if (process.env.ELECTRON_RENDERER_URL) {
    // Dev mode: electron-vite's Vite dev server, not the app:// protocol.
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadURL('app://renderer/index.html')
  }

  return win
}

// Surface 4 (05-UI-SPEC.md): the renderer sends the active document's
// display name + dirty state over this one-way channel every time either
// changes (documents.js's setActiveDocId/markDocumentDirty/
// markDocumentClean); main.js applies win.setTitle() directly. Follows the
// registerXIpc(win) shape established by dialogs.js/theme-store.js -- `win`
// is passed explicitly as a parameter, never captured as a module-level
// global.
//
// T-5-04 (this plan's threat model, accept): `name` is renderer-controlled
// but win.setTitle() truncates gracefully at the OS/taskbar level and never
// touches the filesystem -- an oversized or malformed string cannot crash
// or hang the main process.
function registerWindowTitleIpc (win) {
  ipcMain.on('window:set-title-info', (_event, name, dirty) => {
    win.setTitle(`${dirty ? '● ' : ''}${name} — MD Forge`)
  })
}

export { createWindow, registerWindowTitleIpc }
