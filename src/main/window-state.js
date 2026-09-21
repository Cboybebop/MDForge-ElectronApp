// Hand-rolled window-geometry persistence over `electron-store` -- never
// `electron-window-state` (docs/ARCHITECTURE.md explicitly excludes it as unmaintained
// since 2022, predating multiple Electron display-API changes). See
// 04-CONTEXT.md "Menu, Shell Integration & Window State (SHELL-06/07/08/09,
// PERS-05)" and src/main/theme-store.js, the exact analog this file mirrors.
import { screen, ipcMain } from 'electron'
import Store from 'electron-store'

const store = new Store({
  defaults: {
    x: undefined,
    y: undefined,
    width: 1200,
    height: 800,
    maximized: false,
    // 07-07 (WORK-01/02 UI): sidebar width/collapsed persistence reuses
    // THIS store instance rather than a third one, per 07-PATTERNS.md.
    sidebarWidth: 240,
    sidebarCollapsed: false
  }
})

function getStoredBounds () {
  return {
    x: store.get('x'),
    y: store.get('y'),
    width: store.get('width'),
    height: store.get('height'),
    maximized: store.get('maximized')
  }
}

// Pure predicate: does the top-left corner of `bounds` land inside any
// display's current workArea? T-4-08 (window-state.js's stored bounds are
// user-writable/tamperable) -- treat anything that doesn't resolve to a real,
// currently-connected display as untrusted and reject it, rather than trying
// to fully contain the whole rectangle (a partially-off-screen window that is
// still reachable is fine; a window anchored entirely off every display is
// not).
//
// `bounds.x == null || bounds.y == null` covers both `undefined` (first-ever
// launch, before anything has been persisted) and a hand-edited `null` in the
// store file -- both are "no trustworthy position recorded", not "position
// recorded at (0,0)".
function boundsFitOnADisplay (bounds, displays) {
  if (bounds.x == null || bounds.y == null) return false
  return displays.some((display) => {
    const area = display.workArea
    return (
      bounds.x >= area.x &&
      bounds.y >= area.y &&
      bounds.x < area.x + area.width &&
      bounds.y < area.y + area.height
    )
  })
}

// Reads the stored bounds and validates them against the CURRENT display set
// (defaulting to a real `screen.getAllDisplays()` call, injectable for tests).
// The "external monitor unplugged" case: bounds that fit a 2-display layout
// yesterday no longer fit the 1-display layout today -- boundsFitOnADisplay
// returns false and this falls back to a centered default, deliberately
// omitting x/y so BrowserWindow centers the window itself rather than
// reopening it somewhere unreachable.
function validatedBoundsForRestore (displays = screen.getAllDisplays()) {
  const stored = getStoredBounds()
  if (!boundsFitOnADisplay(stored, displays)) {
    return { width: stored.width, height: stored.height, maximized: false }
  }
  return stored
}

// Guarded per WR-04's documented reason (see theme-store.js): a listener
// closing over `win` can fire after the window is destroyed (e.g. during
// quit), and reading `win.getBounds()`/`win.isMaximized()` on a destroyed
// window throws.
//
// While maximized, `win.getBounds()` on Windows reports the maximized
// window's own bounds, which can carry small negative x/y offsets from the
// OS window-shadow/chrome insets (observed: {x:-7, y:-7} on a single-display
// Windows box). Storing THOSE as the "restore position" would make every
// maximized session fail `boundsFitOnADisplay` on the very next launch --
// wrongly triggering the vanished-monitor fallback and silently discarding
// `maximized:true` even though no monitor ever vanished. So x/y/width/height
// are only updated while NOT maximized (the last known good, unmaximized
// bounds); the `maximized` flag itself is always kept current.
// [08 regression fix, PERS-05] `knownMaximized` exists because
// `win.isMaximized()` cannot be trusted from the 'close' handler: while the
// window is tearing down Windows reports it as NOT maximized, so the close
// firing would overwrite the correct `maximized: true` (already stored by
// the 'maximize' event) with false, and the next launch would restore an
// unmaximized window. The 'maximize'/'unmaximize' events ARE authoritative,
// so registerWindowStatePersistence tracks their value and passes it in.
// Defaults to a live query so existing direct callers keep their behaviour.
function persistBounds (win, knownMaximized = undefined) {
  if (win.isDestroyed()) return
  const isMax = knownMaximized === undefined ? win.isMaximized() : knownMaximized
  if (isMax) {
    store.set('maximized', true)
    return
  }
  const { x, y, width, height } = win.getBounds()
  store.set({ x, y, width, height, maximized: false })
}

// Same listener-attach + `win.once('closed', cleanup)` lifecycle discipline
// as theme-store.js's `registerThemeIpc`: attach resize/move/maximize/
// unmaximize/close listeners, remove them once the window is gone so they
// cannot leak or fire against a destroyed window later.
//
// `initialMaximized` (PERS-05 seed-timing fix, 11-RESEARCH.md "A previously-
// unexamined, codebase-specific compounding bug"): OPTIONAL, second
// parameter. Previously this function always seeded `lastMaximized` from a
// live `win.isMaximized()` read at REGISTRATION time -- but index.js calls
// this AFTER createWindow() has already called `win.maximize()` on a still-
// hidden window, and per electron/electron#834 that maximize() does not
// take effect while hidden. The live read therefore always saw `false` even
// when the intended restore value was `true`, and no 'maximize' event ever
// fired afterward to correct it (Windows never entered a real maximized
// state to notify about). Threading the INTENDED restore-time value in
// explicitly decouples the seed from window.js's own maximize() timing
// entirely -- correct regardless of whether the show-gate/maximize()
// sequencing fix below (window.js's maybeShow()) ever gets Windows to
// genuinely enter the maximized state. Falls back to a live read when
// omitted so every other existing call site keeps its current behaviour.
function registerWindowStatePersistence (win, initialMaximized) {
  // The authoritative maximized state, kept current by the events that
  // genuinely know it. Every other trigger reuses this rather than querying
  // a window that may already be tearing down (see persistBounds above).
  let lastMaximized = initialMaximized !== undefined ? initialMaximized : win.isMaximized()

  // 'close' fires during teardown, where win.isMaximized() is documented
  // (above, and in persistBounds' own comment) to lie -- it always keeps
  // using the cached lastMaximized, never a live read.
  const onCloseChange = () => persistBounds(win, lastMaximized)

  // PERS-05 Warning 2 (gsd-plan-checker review, addressed in 11-02-PLAN.md's
  // revision note): the explicit `initialMaximized` seed above closes the
  // original registration-time bug, but on its own opens a NEW, narrower
  // gap -- if the relocated `maximize()` call in window.js's `maybeShow()`
  // silently fails to take effect (the platform-ceiling outcome), no
  // 'maximize'/'unmaximize' event ever fires to correct a seed threaded in
  // as `true`, because Windows never genuinely entered or exited a
  // maximized state to notify about. `lastMaximized` would then stay
  // wrongly `true` FOREVER, silently dropping every subsequent resize/move
  // persistence write (persistBounds no-ops on geometry whenever it
  // believes the window is maximized). Unlike 'close', 'resize'/'move'
  // never fire during teardown, so a live win.isMaximized() re-read here is
  // safe and bounds the seed's possible divergence from reality to AT MOST
  // one resize/move -- never permanent.
  const onResizeOrMove = () => {
    lastMaximized = win.isMaximized()
    persistBounds(win, lastMaximized)
  }
  const onMaximize = () => { lastMaximized = true; persistBounds(win, true) }
  const onUnmaximize = () => { lastMaximized = false; persistBounds(win, false) }

  win.on('resize', onResizeOrMove)
  win.on('move', onResizeOrMove)
  win.on('maximize', onMaximize)
  win.on('unmaximize', onUnmaximize)
  win.on('close', onCloseChange)

  win.once('closed', () => {
    win.removeListener('resize', onResizeOrMove)
    win.removeListener('move', onResizeOrMove)
    win.removeListener('maximize', onMaximize)
    win.removeListener('unmaximize', onUnmaximize)
  })

  // 07-07 (WORK-01/02 UI): sidebar-resize.js's width/collapsed persistence,
  // registered alongside this window's own bounds listeners rather than as
  // a separate registerXIpc(win) call -- both read/write the same store
  // instance this file already owns. get-state is sendSync (sidebar-
  // resize.js applies it at module-load time, before first paint, same
  // discipline as theme:get-initial).
  ipcMain.on('sidebar:get-state', (event) => {
    event.returnValue = { width: store.get('sidebarWidth'), collapsed: store.get('sidebarCollapsed') }
  })
  ipcMain.on('sidebar:set-state', (_event, state) => {
    store.set({ sidebarWidth: state.width, sidebarCollapsed: state.collapsed })
  })
}

export {
  getStoredBounds,
  boundsFitOnADisplay,
  validatedBoundsForRestore,
  registerWindowStatePersistence,
  persistBounds,
  store
}
