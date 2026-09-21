// Main-process net.fetch-backed image-to-data-URL bridge.
//
// This is a genuine security boundary. The renderer hands it a URL taken from
// an `<img src>` in a document the user opened, and the fetch runs with full
// main-process network privileges. In the browser version the equivalent fetch
// ran in the renderer, constrained by CORS; moving it to main to satisfy the
// `connect-src 'self'` CSP removed that constraint, so every restriction is
// now ours to enforce explicitly.
//
// See 01-CONTEXT.md "Remote-image embedding for Confluence copy moves to a
// main-process fetch bridge", threat T-1-07 in 01-02-PLAN.md, and finding
// CR-01 in 01-REVIEW.md (the SSRF this file defends against).
//
// Defense layers, in order of application:
//   1. Scheme allowlist   -- http/https only; rejects file:, app:, data:, etc.
//   2. No URL credentials -- `user:pass@host` forms are rejected outright.
//   3. Host validation    -- the host must resolve exclusively to publicly
//                            routable addresses (see url-guard.js). This is
//                            the layer that stops SSRF: cloud metadata
//                            (169.254.169.254), loopback, RFC1918, CGNAT and
//                            their IPv6 equivalents are all unreachable.
//   4. No redirects       -- `redirect: 'error'`. Without it a public URL could
//                            302 to http://169.254.169.254 and bypass layer 3.
//   5. Content-type gate  -- only `image/*` responses are encoded, bounding the
//                            blast radius of any bypass.
//   6. Size cap           -- bounds memory and clipboard payload size.
//
// Residual risk, stated honestly: DNS rebinding. Layer 3 resolves the hostname
// and `net.fetch` resolves it again independently, so a hostile resolver could
// in principle answer differently between the two. Closing that fully requires
// pinning the validated IP and connecting to it directly, which breaks TLS SNI
// and certificate validation for https -- a worse trade. Layers 4, 5 and the
// 250ms deadline make the remaining window impractical: an attacker must win a
// sub-250ms race AND return `image/*` content.
//
// Known behaviour change from the browser version: images served from loopback
// or private network addresses are no longer embedded. That is the intended
// cost of closing CR-01; such images keep their original `src` in the copied
// HTML rather than being inlined.
import { ipcMain, net } from 'electron'
import dns from 'node:dns/promises'
import { isPubliclyRoutableHost, toImageDataUrl } from './url-guard.js'

// Per-image budget. Ported parity behaviour: index.html:760 used the same
// 250ms bound, sized so `getConfluenceClipboardPayload`'s 450ms total budget
// keeps the clipboard write inside the browser's click activation window.
// The deadline covers DNS *and* fetch, matching the browser `fetch()` timeout
// semantics it replaces, which also included resolution.
const PER_IMAGE_TIMEOUT_MS = 250

async function fetchImageAsDataUrl (url) {
  if (typeof url !== 'string') return null

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  // Layer 1: positive scheme allowlist.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  // Layer 2: embedded credentials are never legitimate on an image URL, and
  // are a common way to confuse host parsing.
  if (parsed.username || parsed.password) return null

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS)

  try {
    // Layer 3: host must resolve exclusively to public addresses. Inside the
    // deadline, so a slow resolver cannot stall the clipboard write.
    if (!(await isPubliclyRoutableHost(parsed.hostname, dns.lookup))) return null
    if (controller.signal.aborted) return null

    // Layer 4: refuse redirects rather than re-validating each hop.
    const response = await net.fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })
    if (!response.ok) return null

    const arrayBuffer = await response.arrayBuffer()

    // Layers 5 and 6.
    return toImageDataUrl(Buffer.from(arrayBuffer), response.headers.get('content-type'))
  } catch {
    // Any failure -- abort, DNS, TLS, blocked redirect, parse -- resolves to
    // null. The caller treats null as "leave the original src alone", which is
    // the ported graceful-degradation contract.
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

function registerImageFetchIpc () {
  ipcMain.handle('image:fetch-as-data-url', (_event, url) => fetchImageAsDataUrl(url))
}

export { registerImageFetchIpc }
