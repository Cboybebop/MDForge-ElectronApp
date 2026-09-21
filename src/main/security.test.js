// Navigation-origin tests. Regression coverage for 01-REVIEW.md WR-03.
//
// `electron` is mocked because it cannot be imported outside an Electron
// process; only `shell` is touched by this module, and not by the code under
// test here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

const { allowedOrigins } = await import('./security.js')

const ORIGINAL_DEV_URL = process.env.ELECTRON_RENDERER_URL

beforeEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
})

afterEach(() => {
  if (ORIGINAL_DEV_URL === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = ORIGINAL_DEV_URL
})

describe('allowedOrigins', () => {
  it('allows only the app origin in production', () => {
    expect(allowedOrigins()).toEqual(['app://renderer'])
  })

  it('additionally allows the Vite dev server origin in dev', () => {
    // WR-03: previously `app://renderer` was the only permitted origin, so in
    // dev every in-app navigation — including an HMR full reload — failed the
    // same-origin test and was handed to the system browser.
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(allowedOrigins()).toEqual(['app://renderer', 'http://localhost:5173'])
  })

  it('normalizes a dev URL that carries a path down to its origin', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/index.html?foo=1'
    expect(allowedOrigins()).toEqual(['app://renderer', 'http://localhost:5173'])
  })

  it('preserves a non-default dev port', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:9080'
    expect(allowedOrigins()).toContain('http://127.0.0.1:9080')
  })

  it('falls back to production-only when the dev URL is malformed', () => {
    // Fails closed: a broken dev URL degrades the dev loop rather than
    // widening what a packaged build will navigate to.
    process.env.ELECTRON_RENDERER_URL = 'not a url'
    expect(allowedOrigins()).toEqual(['app://renderer'])
  })

  it('never drops the production origin, whatever dev supplies', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(allowedOrigins()).toContain('app://renderer')
  })
})
