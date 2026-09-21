// Security regression tests for the image-fetch SSRF guard (01-REVIEW.md CR-01).
//
// These run under plain Node -- no jsdom, no Electron -- because url-guard.js
// deliberately has no `electron` import. Resolution is injected so the whole
// suite is offline and deterministic, which SHELL-10 requires.
import { describe, it, expect } from 'vitest'
import {
  isBlockedIpv4,
  isBlockedIpv6,
  isPubliclyRoutableHost,
  toImageDataUrl,
  MAX_RESPONSE_BYTES
} from './url-guard.js'

// Stand-in for dns.lookup that resolves any name to the supplied addresses.
const lookupTo = (...addresses) => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

const lookupFails = async () => {
  throw new Error('ENOTFOUND')
}

describe('isBlockedIpv4', () => {
  it('blocks the cloud metadata endpoint', () => {
    // The single most important case: AWS/Azure/GCP serve instance
    // credentials here. This is the address CR-01 was really about.
    expect(isBlockedIpv4('169.254.169.254')).toBe(true)
  })

  it.each([
    ['0.0.0.0', 'this-network'],
    ['10.0.0.1', 'RFC1918 /8'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['169.254.1.1', 'link-local'],
    ['172.16.0.1', 'RFC1918 /12 lower bound'],
    ['172.31.255.254', 'RFC1918 /12 upper bound'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.168.1.1', 'RFC1918 /16'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast']
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedIpv4(address)).toBe(true)
  })

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['93.184.216.34'],
    ['172.15.255.255'], // just below the RFC1918 /12 range
    ['172.32.0.1'], //    just above the RFC1918 /12 range
    ['11.0.0.1'], //      just above 10/8
    ['9.255.255.255'] //  just below 10/8
  ])('allows public address %s', (address) => {
    expect(isBlockedIpv4(address)).toBe(false)
  })

  it('fails closed on zero-padded octets that some resolvers read as octal', () => {
    // 010.0.0.1 would be 8.0.0.1 if parsed as octal -- a classic bypass.
    expect(isBlockedIpv4('010.0.0.1')).toBe(true)
    expect(isBlockedIpv4('0177.0.0.1')).toBe(true)
  })

  it.each([['not-an-ip'], [''], ['1.2.3'], ['1.2.3.4.5'], ['256.1.1.1'], ['1.-2.3.4']])(
    'fails closed on malformed input %s',
    (address) => {
      expect(isBlockedIpv4(address)).toBe(true)
    }
  )
})

describe('isBlockedIpv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['64:ff9b::1', 'NAT64'],
    ['2002::1', '6to4']
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedIpv6(address)).toBe(true)
  })

  it('blocks IPv4-mapped forms wrapping a private address', () => {
    expect(isBlockedIpv6('::ffff:169.254.169.254')).toBe(true)
    expect(isBlockedIpv6('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIpv6('::127.0.0.1')).toBe(true)
    // Hex-encoded ::ffff: forms are refused wholesale rather than decoded.
    expect(isBlockedIpv6('::ffff:a9fe:a9fe')).toBe(true)
  })

  it('strips the zone index before matching', () => {
    expect(isBlockedIpv6('fe80::1%eth0')).toBe(true)
  })

  it('allows a public IPv6 address', () => {
    expect(isBlockedIpv6('2606:4700:4700::1111')).toBe(false)
  })
})

describe('isPubliclyRoutableHost', () => {
  it('allows a hostname resolving only to public addresses', async () => {
    await expect(isPubliclyRoutableHost('example.com', lookupTo('93.184.216.34'))).resolves.toBe(true)
  })

  it('blocks a hostname resolving to the metadata endpoint', async () => {
    // DNS-based SSRF: an attacker-controlled name pointing at link-local.
    await expect(isPubliclyRoutableHost('evil.example', lookupTo('169.254.169.254'))).resolves.toBe(false)
  })

  it('blocks when ANY resolved address is private, not just all of them', async () => {
    // We cannot control which address net.fetch picks, so a mixed result
    // must be denied outright.
    await expect(
      isPubliclyRoutableHost('mixed.example', lookupTo('93.184.216.34', '10.0.0.5'))
    ).resolves.toBe(false)
  })

  it('fails closed when resolution throws', async () => {
    await expect(isPubliclyRoutableHost('nx.example', lookupFails)).resolves.toBe(false)
  })

  it('fails closed on an empty resolution result', async () => {
    await expect(isPubliclyRoutableHost('empty.example', async () => [])).resolves.toBe(false)
  })

  it('short-circuits literal IPs without consulting the resolver', async () => {
    const never = async () => {
      throw new Error('resolver must not be called for a literal IP')
    }
    await expect(isPubliclyRoutableHost('127.0.0.1', never)).resolves.toBe(false)
    await expect(isPubliclyRoutableHost('8.8.8.8', never)).resolves.toBe(true)
  })

  it('handles bracketed IPv6 URL hosts', async () => {
    await expect(isPubliclyRoutableHost('[::1]', lookupFails)).resolves.toBe(false)
    await expect(isPubliclyRoutableHost('[2606:4700:4700::1111]', lookupFails)).resolves.toBe(true)
  })

  it.each([[''], [null], [undefined], [42]])('fails closed on invalid hostname %s', async (hostname) => {
    await expect(isPubliclyRoutableHost(hostname, lookupTo('8.8.8.8'))).resolves.toBe(false)
  })
})

describe('toImageDataUrl', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')

  it('encodes an image response', () => {
    expect(toImageDataUrl(png, 'image/png')).toMatch(/^data:image\/png;base64,/)
  })

  it('normalizes content-type parameters and casing', () => {
    expect(toImageDataUrl(png, 'IMAGE/PNG; charset=binary')).toMatch(/^data:image\/png;base64,/)
  })

  it.each([
    ['application/json'],
    ['text/html'],
    ['text/plain'],
    ['application/octet-stream'],
    [''],
    [null]
  ])('refuses non-image content-type %s', (contentType) => {
    // The gate that stops an internal service's body reaching the clipboard
    // even if the host checks were somehow bypassed.
    expect(toImageDataUrl(png, contentType)).toBeNull()
  })

  it('refuses an empty body', () => {
    expect(toImageDataUrl(Buffer.alloc(0), 'image/png')).toBeNull()
  })

  it('refuses a body over the size cap', () => {
    const oversized = Buffer.alloc(MAX_RESPONSE_BYTES + 1)
    expect(toImageDataUrl(oversized, 'image/png')).toBeNull()
  })
})
