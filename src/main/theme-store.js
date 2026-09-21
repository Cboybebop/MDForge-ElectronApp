// electron-store-backed theme preference + nativeTheme IPC bridge.
// See 01-RESEARCH.md Pattern 4 and 01-CONTEXT.md "Theme System (EDIT-02)".
import { ipcMain, nativeTheme } from 'electron'
import Store from 'electron-store'

const store = new Store({ defaults: { theme: 'system' } })

function registerThemeIpc (win) {
  ipcMain.on('theme:get-initial', (event) => {
    event.returnValue = store.get('theme') // synchronous reply required for sendSync
  })

  ipcMain.handle('theme:set', (_event, value) => {
    store.set('theme', value)
    nativeTheme.themeSource = value // 'light' | 'dark' | 'system' — Electron applies to native UI too
  })

  // 01-REVIEW.md WR-04. Two problems, one cause: `nativeTheme` is a global
  // whose lifetime exceeds any window's, so a listener closing over `win`
  // outlives the thing it targets.
  //
  //   1. Sending to a destroyed webContents throws. An OS theme change after
  //      the window closed — plausible while the app is quitting — would raise
  //      an unhandled error from a global event handler.
  //   2. The listener was never removed, so it leaked. Harmless with one
  //      window today, but this file will be reused when multiple windows
  //      arrive, and a per-window leak on a global emitter compounds.
  //
  // The guard covers the race (window destroyed between emit and send);
  // removing the listener on 'closed' stops the leak.
  const onNativeThemeUpdated = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors)
  }

  nativeTheme.on('updated', onNativeThemeUpdated)
  win.once('closed', () => {
    nativeTheme.removeListener('updated', onNativeThemeUpdated)
  })
}

export { registerThemeIpc, store }
