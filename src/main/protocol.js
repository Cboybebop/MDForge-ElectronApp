// Privileged `app://` scheme registration + path-traversal-guarded request handler
// + CSP header injection. See 01-RESEARCH.md Pattern 1.
//
// This module MUST be imported before app.whenReady() fires, because
// registerSchemesAsPrivileged() only takes effect if called before the
// 'ready' event — it silently no-ops otherwise (01-RESEARCH.md Pitfall 1).
//
// NOTE: written as ESM import/export (not require()/module.exports), even
// though the electron-vite main build emits CJS output. Rollup's module
// graph only traverses relative local files that use static ES import
// syntax — a raw require('./foo') to a local (non-node_modules) file is
// left untouched in the bundle rather than inlined, so ./foo.js never gets
// emitted into out/main/ and the built app crashes with "Cannot find
// module './foo'". Writing ESM here lets Rollup bundle all main-process
// modules into the single out/main/index.js file, which the CJS output
// format then wraps in require() calls to *node_modules* packages only.
import { protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

// MUST run before app.whenReady() / app 'ready' event, and only once.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true, // enables relative URL resolution — required for ES module imports
      secure: true, // treated like https:// for mixed-content / secure-context purposes
      supportFetchAPI: true // required for fetch()/dynamic import() to work against this scheme
      // bypassCSP intentionally omitted — CSP must be ENFORCED, not bypassed
    }
  }
])

const RENDERER_ROOT = path.join(__dirname, '../renderer') // out/renderer in production build

// `img-src` deliberately admits remote origins; every other directive stays
// locked down. See 01-REVIEW.md WR-02.
//
// Why this is not a hole in the SSRF work done for CR-01: `img-src` grants
// permission to *display* a resource, not to *read* it. Cross-origin image
// pixels are not scriptable — there is no CORS grant, so canvas readback taints
// and nothing can exfiltrate the bytes. `connect-src` stays `'self'`, which is
// what actually stops a document from reading arbitrary URLs; that remains the
// sole job of the audited main-process bridge in image-fetch.js.
//
// Why it is needed: without it, remote images silently fail to render in the
// preview — a regression from the browser version (success criterion 1,
// parity), and an incoherent one, since the Confluence copy path *does* fetch
// those same images. The user would be copying images they cannot see.
//
// Residual risk, accepted knowingly: a hostile `.md` can embed a tracking pixel
// and learn that the document was opened, plus the reader's IP. That was
// equally true of the browser version, which had no CSP at all. The adjacent
// worry — probing internal hosts via `<img src="http://192.168.1.1/">` — yields
// nothing usable, because observing load/error requires an inline handler or
// script: DOMPurify strips `onerror`/`onload`, and `script-src 'self'` with no
// `unsafe-inline` blocks the rest. There is no channel back to the attacker.
//
// `http:` is admitted alongside `https:` because intranet-hosted images are a
// normal case for this app's audience; restricting to TLS would break them for
// no security gain, given the bytes are unreadable to script either way.
//
// Offline behaviour (SHELL-10) is unaffected: with no network the images simply
// fail to load, exactly as any editor behaves. The zero-network E2E assertions
// cover launch and interaction, neither of which loads remote content.
//
// CM6_STYLE_NONCE (12-01-PLAN.md): CodeMirror 6's @codemirror/view
// unconditionally injects its own base-layout `<style>` tag at mount time
// (the style-mod package's StyleModule.mount()) -- with a bare `style-src
// 'self'` and no 'unsafe-inline', that injected tag is silently blocked by
// this app's own CSP, and CM6 renders with no layout at all. A CSP nonce is
// the standard fix (EditorView.cspNonce, see cm-view.js), but the nonce MUST
// be unpredictable -- a static, build-time-visible literal checked into
// source would defeat the entire point of a nonce (an attacker who can read
// the shipped bundle could forge the same token). So this is generated ONCE
// per app launch, at MODULE SCOPE (evaluated when this module first loads at
// app boot, NOT inside the per-request handler below and NOT regenerated per
// request) via node:crypto's randomUUID() -- a Node builtin, no new
// dependency. Threaded to the renderer purely via a same-response <meta> tag
// injected server-side into index.html at serve time (see
// registerAppProtocol() below) -- never a value the renderer could forge or
// a value visible anywhere in the committed source tree (T-12-01).
const CM6_STYLE_NONCE = randomUUID()

const PROD_CSP =
  `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${CM6_STYLE_NONCE}'; ` +
  "img-src 'self' data: https: http:; font-src 'self'; connect-src 'self'"

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

function registerAppProtocol () {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    // host is 'renderer' by convention: app://renderer/index.html, app://renderer/assets/x.js
    const relativePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)

    // Path-traversal guard — mirrors electron/electron's own documented example.
    const resolved = path.resolve(RENDERER_ROOT, '.' + relativePath)
    const relativeToRoot = path.relative(RENDERER_ROOT, resolved)
    const isSafe = relativeToRoot !== '' && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)
    if (!isSafe) {
      return new Response('Forbidden', { status: 403 })
    }

    const ext = path.extname(resolved)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    // Fetch bytes via net.fetch (handles the file read), but do NOT trust its
    // auto-detected content-type — set it explicitly (Pitfall: MIME detection).
    let fileResponse
    try {
      fileResponse = await net.fetch(pathToFileURL(resolved).toString())
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!fileResponse.ok) return new Response('Not Found', { status: 404 })

    const headers = new Headers(fileResponse.headers)
    headers.set('content-type', contentType)
    headers.set('content-security-policy', PROD_CSP)

    // index.html specifically: thread CM6_STYLE_NONCE to the renderer via a
    // same-response <meta> tag, injected server-side by a single exact-string
    // replacement. Every other asset (.js/.css/.svg/etc.) keeps passing
    // fileResponse.body through as a stream, unmodified, exactly as before
    // this plan (12-01-PLAN.md Task 2). No edit to index.html on disk is
    // needed or correct -- this injection is serve-time only, and dev mode
    // (electron-vite's own Vite dev server) never goes through this handler
    // at all, so it needs no meta tag (its own DEV_CSP already permits
    // 'unsafe-inline' for style-src).
    if (relativePath === '/index.html') {
      const text = await fileResponse.text()
      // [17-02] Phase 13's test-only extension seam (window.__cmLineWrapping/
      // window.__cmAppendExtension) and the dedicated meta tag that gated it
      // are deleted outright now that soft wrap ships as a permanent,
      // unconditional production extension (cm-view.js sharedExtensions())
      // -- reconciled, not left dormant alongside it. The <head> replacement
      // below now carries ONLY the cm6-csp-nonce meta tag, unconditionally,
      // exactly as it always has.
      const modifiedText = text.replace(
        '<head>',
        `<head>\n  <meta name="cm6-csp-nonce" content="${CM6_STYLE_NONCE}">`
      )
      // The copied `headers` above still carries the ORIGINAL file's
      // content-length (from fileResponse.headers) -- stale now that the
      // body text has grown by the injected <meta> tag. Drop it so
      // Chromium's net stack computes/derives the length from the actual
      // (modified) body instead of a mismatched value that could truncate
      // or reject the response.
      headers.delete('content-length')
      return new Response(modifiedText, { status: 200, headers })
    }

    return new Response(fileResponse.body, {
      status: 200,
      headers
    })
  })
}

export { registerAppProtocol }
