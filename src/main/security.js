// Navigation hardening: deny all window.open()/target=_blank attempts, and
// route any non-same-origin `will-navigate` to the system browser instead of
// letting it navigate in-app. See 01-CONTEXT.md "Loading, Protocol & Security
// Posture (O7)" and threat T-1-02.
import { shell } from 'electron'

const PROD_ORIGIN = 'app://renderer'

/**
 * Origins the renderer is allowed to navigate within.
 *
 * In production that is only `app://renderer`. In dev, electron-vite serves the
 * renderer from a Vite dev server, so its origin must be allowed too — 01-REVIEW.md
 * WR-03: with `app://renderer` hardcoded as the only origin, every in-app dev
 * navigation (including an HMR full reload) failed the same-origin test and was
 * handed to the system browser, which both broke the dev loop and could pop a
 * real browser window at a localhost URL.
 *
 * `ELECTRON_RENDERER_URL` is electron-vite's own dev-mode indicator and is the
 * signal already used in main/index.js, kept consistent here rather than adding
 * `@electron-toolkit/utils`' `is.dev` (a locked decision — see index.js).
 *
 * Computed per call rather than once at module load so it cannot capture a
 * stale value if the dev server address changes between restarts.
 */
function allowedOrigins () {
  const origins = [PROD_ORIGIN]

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      const parsed = new URL(devUrl)
      origins.push(`${parsed.protocol}//${parsed.host}`)
    } catch {
      // Malformed dev URL: fall through with production origin only. Failing
      // closed here degrades the dev loop rather than widening what a packaged
      // build will navigate to.
    }
  }

  return origins
}

function hardenWindow (win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.on('will-navigate', (event, url) => {
    let origin = null
    try {
      const parsed = new URL(url)
      origin = `${parsed.protocol}//${parsed.host}`
    } catch {
      origin = null // unparseable -> treated as foreign, handled below
    }

    if (origin === null || !allowedOrigins().includes(origin)) {
      event.preventDefault()

      // Only hand http/https to the OS. `shell.openExternal` will happily
      // launch other schemes, and a document containing e.g. a `file:` or
      // custom-protocol link should not be able to invoke an arbitrary
      // registered handler just by being opened.
      if (origin !== null && (url.startsWith('http://') || url.startsWith('https://'))) {
        shell.openExternal(url)
      }
    }
  })
}

// `allowedOrigins` is exported for unit testing — it is the branching part of
// this module and the piece WR-03 got wrong.
export { hardenWindow, allowedOrigins }
