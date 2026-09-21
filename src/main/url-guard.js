// SSRF guard for the main-process image-fetch bridge.
//
// Deliberately free of any `electron` import so the security-critical range
// arithmetic can be unit-tested under plain Node/vitest without launching an
// Electron process. `image-fetch.js` is the only consumer.
//
// Context: the renderer hands the bridge a URL taken from an `<img src>` in a
// document the user opened, and the fetch runs with full main-process network
// privileges. The browser version's equivalent fetch ran in the renderer under
// CORS; moving it to main removed that constraint, so these checks replace it.
// See finding CR-01 in 01-REVIEW.md.
import { isIP } from 'node:net'

// 5 MiB. A larger image yields a ~6.7MB base64 data URL, already past what
// clipboard targets handle well.
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

// IPv4 ranges that must never be reachable from the bridge, as [base, prefix].
// From the IANA IPv4 Special-Purpose Address Registry. 169.254.0.0/16 is the
// critical one for SSRF: it contains 169.254.169.254, the cloud metadata
// endpoint AWS/Azure/GCP use to serve instance credentials.
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8], //          "this network"
  ['10.0.0.0', 8], //         RFC1918 private
  ['100.64.0.0', 10], //      RFC6598 carrier-grade NAT
  ['127.0.0.0', 8], //        loopback
  ['169.254.0.0', 16], //     link-local -- includes cloud metadata
  ['172.16.0.0', 12], //      RFC1918 private
  ['192.0.0.0', 24], //       IETF protocol assignments
  ['192.0.2.0', 24], //       TEST-NET-1
  ['192.168.0.0', 16], //     RFC1918 private
  ['198.18.0.0', 15], //      benchmarking
  ['198.51.100.0', 24], //    TEST-NET-2
  ['203.0.113.0', 24], //     TEST-NET-3
  ['224.0.0.0', 4], //        multicast
  ['240.0.0.0', 4] //         reserved, includes the 255.255.255.255 broadcast
]

function ipv4ToInt (address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    // Reject empty, non-numeric, and zero-padded octets. "010" is octal to
    // some resolvers, which is a classic filter-bypass trick.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function isBlockedIpv4 (address) {
  const value = ipv4ToInt(address)
  if (value === null) return true // unparseable -> fail closed
  for (const [base, prefix] of BLOCKED_IPV4_RANGES) {
    const baseValue = ipv4ToInt(base)
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    if (((value & mask) >>> 0) === ((baseValue & mask) >>> 0)) return true
  }
  return false
}

export function isBlockedIpv6 (address) {
  // Strip any zone index ("fe80::1%eth0") before matching.
  const normalized = address.toLowerCase().split('%')[0]

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible (::1.2.3.4) forms embed a
  // v4 address; validate the embedded address, or ::ffff:169.254.169.254 would
  // sail straight through.
  const dottedTail = normalized.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dottedTail) return isBlockedIpv4(dottedTail[1])

  // The same mapping in hex (::ffff:a9fe:a9fe). Treat every non-dotted ::ffff:
  // form as untrusted rather than decoding each variant -- there is no
  // legitimate reason to reference an image by one.
  if (normalized.startsWith('::ffff:')) return true

  if (normalized === '::' || normalized === '::1') return true
  if (/^f[cd]/.test(normalized)) return true //       fc00::/7  unique local
  if (/^fe[89ab]/.test(normalized)) return true //    fe80::/10 link-local
  if (/^ff/.test(normalized)) return true //          ff00::/8  multicast
  if (normalized.startsWith('64:ff9b:')) return true // NAT64 translation
  if (normalized.startsWith('2002:')) return true //   6to4, can encode v4
  return false
}

/**
 * True only when every address `hostname` resolves to is publicly routable.
 *
 * `lookup` is injected so tests can exercise the resolution path deterministically
 * and offline; production passes Node's `dns/promises` lookup.
 */
export async function isPubliclyRoutableHost (hostname, lookup) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false

  // Literal IP in the URL -- no resolution needed.
  const literalFamily = isIP(hostname)
  if (literalFamily === 4) return !isBlockedIpv4(hostname)
  if (literalFamily === 6) return !isBlockedIpv6(hostname)

  // Bracketed IPv6 literal, as it appears in a URL host component.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1)
    return isIP(inner) === 6 ? !isBlockedIpv6(inner) : false
  }

  if (typeof lookup !== 'function') return false

  let addresses
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    return false // resolution failure -> fail closed
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return false

  // `every`, not `some`: a name resolving to both a public and a private
  // address must be denied, since we cannot control which one net.fetch picks.
  return addresses.every((entry) =>
    entry.family === 4 ? !isBlockedIpv4(entry.address) : !isBlockedIpv6(entry.address)
  )
}

/**
 * Encode fetched bytes as an image data URL, or null if the response is not a
 * usable image.
 *
 * The `image/*` gate is what bounds the blast radius of any bypass of the host
 * checks: an internal service's JSON or HTML body cannot be laundered into the
 * user's clipboard even if it were somehow reached.
 */
export function toImageDataUrl (buffer, contentTypeHeader) {
  if (!buffer || buffer.length === 0) return null
  if (buffer.length > MAX_RESPONSE_BYTES) return null

  const contentType = String(contentTypeHeader || '').split(';')[0].trim().toLowerCase()
  if (!contentType.startsWith('image/')) return null

  return `data:${contentType};base64,${buffer.toString('base64')}`
}
