// Regression tests for window-geometry persistence and the monitor-vanished
// rejection (PERS-05). `boundsFitOnADisplay`/`validatedBoundsForRestore` are
// tested as pure functions over a synthetic display list -- no real
// multi-monitor Electron instance is launched, per 04-PATTERNS.md's
// window-state.js pattern assignment and security.test.js's `vi.mock`
// shape for pure-decision-function coverage.
//
// `electron-store`'s `Store` is faked with a plain in-memory object so tests
// can seed/reset stored bounds directly, mirroring how atomic-write.test.js
// fakes `node:fs/promises` via vi.hoisted().
import { describe, it, expect, beforeEach, vi } from 'vitest'

// [07-07, Rule 3 - Blocking] ipcMain is now imported by window-state.js
// (registerWindowStatePersistence registers the sidebar:get-state/
// sidebar:set-state handlers) -- without it in this mock,
// registerWindowStatePersistence(win) below throws
// "Cannot read properties of undefined (reading 'on')".
vi.mock('electron', () => ({ screen: { getAllDisplays: vi.fn() }, ipcMain: { on: vi.fn() } }))

vi.mock('electron-store', () => {
  class FakeStore {
    constructor ({ defaults }) {
      this.data = { ...defaults }
    }

    get (key) {
      return this.data[key]
    }

    set (keyOrObject, value) {
      if (typeof keyOrObject === 'object' && keyOrObject !== null) {
        Object.assign(this.data, keyOrObject)
      } else {
        this.data[keyOrObject] = value
      }
    }
  }
  return { default: FakeStore }
})

const {
  getStoredBounds,
  boundsFitOnADisplay,
  validatedBoundsForRestore,
  registerWindowStatePersistence,
  persistBounds,
  store
} = await import('./window-state.js')

const DEFAULTS = { x: undefined, y: undefined, width: 1200, height: 800, maximized: false }

function resetStore () {
  store.data = { ...DEFAULTS }
}

beforeEach(() => {
  resetStore()
})

describe('boundsFitOnADisplay', () => {
  it('fits inside the one display', () => {
    const bounds = { x: 100, y: 100, width: 800, height: 600 }
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    expect(boundsFitOnADisplay(bounds, displays)).toBe(true)
  })

  it('rejects a position off the only display (external monitor unplugged)', () => {
    const bounds = { x: 3000, y: 100, width: 800, height: 600 }
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    expect(boundsFitOnADisplay(bounds, displays)).toBe(false)
  })

  it('treats an unrecorded position (null x/y, first-ever launch) as not fitting', () => {
    const bounds = { x: null, y: null, width: 1200, height: 800 }
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    expect(boundsFitOnADisplay(bounds, displays)).toBe(false)
  })

  it('treats an undefined position (electron-store default, never persisted) as not fitting', () => {
    const bounds = { x: undefined, y: undefined, width: 1200, height: 800 }
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    expect(boundsFitOnADisplay(bounds, displays)).toBe(false)
  })

  it('fits when it lands on the second of two displays', () => {
    const bounds = { x: 2000, y: 100, width: 800, height: 600 }
    const displays = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }
    ]
    expect(boundsFitOnADisplay(bounds, displays)).toBe(true)
  })

  it('the external-monitor-unplugged scenario: fits a 2-display layout but not the resulting 1-display layout', () => {
    // A laptop docked to an external monitor to its right. The window was
    // last positioned on that external monitor (x: 2000). The external
    // monitor is then undocked, leaving only the laptop's own display.
    const bounds = { x: 2000, y: 100, width: 800, height: 600 }
    const twoDisplays = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }
    ]
    const oneDisplayAfterUndocking = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

    expect(boundsFitOnADisplay(bounds, twoDisplays)).toBe(true)
    expect(boundsFitOnADisplay(bounds, oneDisplayAfterUndocking)).toBe(false)
  })
})

describe('getStoredBounds', () => {
  it('reads the current store values', () => {
    store.set({ x: 50, y: 60, width: 1000, height: 700, maximized: true })
    expect(getStoredBounds()).toEqual({ x: 50, y: 60, width: 1000, height: 700, maximized: true })
  })

  it('returns the declared defaults before anything is ever persisted', () => {
    expect(getStoredBounds()).toEqual(DEFAULTS)
  })
})

describe('validatedBoundsForRestore', () => {
  it('returns the stored bounds including x/y when they fit a synthetic 2-display list', () => {
    store.set({ x: 100, y: 100, width: 900, height: 650, maximized: false })
    const displays = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }
    ]
    expect(validatedBoundsForRestore(displays)).toEqual({
      x: 100, y: 100, width: 900, height: 650, maximized: false
    })
  })

  it('falls back to a centered default (no x/y keys) when the stored position fits neither display', () => {
    store.set({ x: 5000, y: 100, width: 900, height: 650, maximized: true })
    const displays = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }
    ]
    const result = validatedBoundsForRestore(displays)
    expect(result).toEqual({ width: 900, height: 650, maximized: false })
    expect(result).not.toHaveProperty('x')
    expect(result).not.toHaveProperty('y')
  })

  it('falls back to the centered default on first-ever launch (no stored position at all)', () => {
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    const result = validatedBoundsForRestore(displays)
    expect(result).toEqual({ width: 1200, height: 800, maximized: false })
    expect(result).not.toHaveProperty('x')
    expect(result).not.toHaveProperty('y')
  })

  it('rejects a maximized window whose stored top-left has vanished, still forcing maximized:false', () => {
    // Even if the window was maximized on the vanished monitor, we cannot
    // trust that state either -- the safe default always starts unmaximized.
    store.set({ x: 5000, y: 100, width: 900, height: 650, maximized: true })
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    expect(validatedBoundsForRestore(displays)).toEqual({ width: 900, height: 650, maximized: false })
  })
})

describe('persistBounds', () => {
  function makeFakeWin ({ destroyed = false, bounds, maximized = false } = {}) {
    return {
      isDestroyed: () => destroyed,
      getBounds: () => bounds,
      isMaximized: () => maximized
    }
  }

  it('writes the window bounds and maximized:false to the store when not maximized', () => {
    const win = makeFakeWin({ bounds: { x: 10, y: 20, width: 500, height: 400 }, maximized: false })
    persistBounds(win)
    expect(getStoredBounds()).toEqual({ x: 10, y: 20, width: 500, height: 400, maximized: false })
  })

  it('is a no-op guard on a destroyed window (WR-04: a listener closing over win can outlive it)', () => {
    const win = makeFakeWin({ destroyed: true, bounds: { x: 1, y: 1, width: 1, height: 1 } })
    expect(() => persistBounds(win)).not.toThrow()
    expect(getStoredBounds()).toEqual(DEFAULTS)
  })

  it('leaves x/y/width/height untouched while maximized, only flipping maximized:true', () => {
    // Regression: Windows reports small negative x/y offsets (window-shadow
    // insets) via getBounds() while maximized. Persisting those as the
    // restore position would fail boundsFitOnADisplay on the next launch
    // and silently drop maximized:true even though no monitor vanished.
    store.set({ x: 200, y: 150, width: 1000, height: 700, maximized: false })
    const win = makeFakeWin({ bounds: { x: -7, y: -7, width: 1934, height: 1094 }, maximized: true })
    persistBounds(win)
    expect(getStoredBounds()).toEqual({ x: 200, y: 150, width: 1000, height: 700, maximized: true })
  })

  it('resumes writing real bounds once unmaximized', () => {
    store.set({ x: 200, y: 150, width: 1000, height: 700, maximized: true })
    const win = makeFakeWin({ bounds: { x: 210, y: 160, width: 1000, height: 700 }, maximized: false })
    persistBounds(win)
    expect(getStoredBounds()).toEqual({ x: 210, y: 160, width: 1000, height: 700, maximized: false })
  })
})

describe('registerWindowStatePersistence', () => {
  function makeFakeWin () {
    const listeners = {}
    return {
      isDestroyed: () => false,
      getBounds: () => ({ x: 5, y: 5, width: 640, height: 480 }),
      isMaximized: () => false,
      on (event, handler) {
        listeners[event] = listeners[event] || []
        listeners[event].push(handler)
      },
      once (event, handler) {
        listeners[event] = listeners[event] || []
        listeners[event].push(handler)
      },
      removeListener (event, handler) {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler)
      },
      emit (event) {
        for (const handler of listeners[event] || []) handler()
      },
      _listeners: listeners
    }
  }

  it('persists bounds on resize, move and close', () => {
    const win = makeFakeWin()
    registerWindowStatePersistence(win)

    win.emit('resize')
    expect(getStoredBounds()).toMatchObject({ x: 5, y: 5, width: 640, height: 480 })

    resetStore()
    win.emit('move')
    expect(getStoredBounds()).toMatchObject({ x: 5, y: 5, width: 640, height: 480 })

    resetStore()
    win.emit('close')
    expect(getStoredBounds()).toMatchObject({ x: 5, y: 5, width: 640, height: 480 })
  })

  it('removes the resize/move listeners once the window is closed, mirroring theme-store.js cleanup-on-closed', () => {
    const win = makeFakeWin()
    registerWindowStatePersistence(win)

    expect(win._listeners.resize.length).toBe(1)
    expect(win._listeners.move.length).toBe(1)

    win.emit('closed')

    expect(win._listeners.resize.length).toBe(0)
    expect(win._listeners.move.length).toBe(0)
  })

  // PERS-05 seed-timing bug (11-RESEARCH.md "A previously-unexamined,
  // codebase-specific compounding bug"): index.js calls
  // registerWindowStatePersistence(win) AFTER createWindow() already called
  // win.maximize() on a still-hidden window. Per electron/electron#834,
  // that maximize() never actually takes effect on Windows while hidden, so
  // a live `win.isMaximized()` read at registration time reads false even
  // though the INTENDED restore-time value was true -- and no 'maximize'
  // event ever fires afterward to correct it, since Windows never entered a
  // real maximized state to notify about. Threading the intended value in
  // explicitly, decoupled from window.js's own maximize() timing, closes
  // this regardless of whether the harder show-gate/maximize() sequencing
  // problem (Task 2's second half) is ever fully solved.
  it('seeds lastMaximized from an explicit initialMaximized parameter, not a live isMaximized() read (PERS-05 seed-timing fix)', () => {
    const win = makeFakeWin()
    // Simulates the real Electron hidden-window quirk: a just-restored
    // maximized window legitimately reads false here (electron/electron#834).
    win.isMaximized = () => false

    registerWindowStatePersistence(win, true)
    win.emit('close')

    expect(getStoredBounds().maximized).toBe(true)
  })

  // PERS-05 Warning 2 (gsd-plan-checker review): the initialMaximized seed
  // above, on its own, could stay wrongly true forever if the show-gate's
  // maximize() attempt silently fails to take effect (no 'maximize' event
  // ever arrives to correct it). A live win.isMaximized() re-read on the
  // FIRST resize/move must self-correct it instead of trusting the seed
  // forever.
  it('a resize/move event self-corrects a seed that diverged from live reality (PERS-05 Warning 2 fix)', () => {
    const win = makeFakeWin()
    // isMaximized hardcodes false -- as if the show-gate's maximize()
    // attempt was INTENDED to succeed (seeded true) but never genuinely
    // took effect (the platform-ceiling outcome).
    registerWindowStatePersistence(win, true)

    win.emit('resize')

    expect(getStoredBounds().maximized).toBe(false)
  })
})
