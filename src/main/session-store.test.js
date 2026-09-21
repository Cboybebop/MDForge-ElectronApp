// Regression tests for session-state persistence (PERS-04, PERS-06's data
// layer). `electron-store`'s `Store` is faked with a plain in-memory object,
// mirroring window-state.test.js's FakeStore shape exactly. `electron`'s
// `ipcMain` is faked as a plain object with a `vi.fn()` `on` method so
// registerSessionIpc's wiring can be asserted without a real Electron
// process.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

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

const { getSessionState, setSessionState, registerSessionIpc, store } = await import('./session-store.js')
const { ipcMain } = await import('electron')

const DEFAULTS = { tabs: [], activeIndex: 0 }

function resetStore () {
  store.data = { tabs: [], activeIndex: 0 }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe('getSessionState', () => {
  it('returns the declared defaults before anything is ever persisted', () => {
    expect(getSessionState()).toEqual(DEFAULTS)
  })

  it('reads back a previously written tabs list and active index', () => {
    const tabs = [
      { filePath: 'C:\\docs\\a.md', draftUuid: null, scrollTop: 120 },
      { filePath: null, draftUuid: 'abc-123', scrollTop: 0 }
    ]
    store.set({ tabs, activeIndex: 1 })
    expect(getSessionState()).toEqual({ tabs, activeIndex: 1 })
  })

  it('falls back to an empty session when the stored tabs value is not an array (hand-edited/corrupt store file)', () => {
    store.set({ tabs: 'not-an-array', activeIndex: 5 })
    expect(getSessionState()).toEqual({ tabs: [], activeIndex: 0 })
  })

  it('falls back to an empty session when tabs is null', () => {
    store.set({ tabs: null, activeIndex: 2 })
    expect(getSessionState()).toEqual({ tabs: [], activeIndex: 0 })
  })

  it('falls back to an empty session when tabs is an object, not an array', () => {
    store.set({ tabs: { 0: 'sneaky' }, activeIndex: 0 })
    expect(getSessionState()).toEqual({ tabs: [], activeIndex: 0 })
  })
})

describe('setSessionState', () => {
  it('persists a well-shaped tabs array and activeIndex', () => {
    const tabs = [{ filePath: 'C:\\docs\\b.md', draftUuid: null, scrollTop: 42 }]
    setSessionState({ tabs, activeIndex: 0 })
    expect(getSessionState()).toEqual({ tabs, activeIndex: 0 })
  })

  it('falls back to [] rather than persisting a non-array tabs value', () => {
    setSessionState({ tabs: 'garbage', activeIndex: 3 })
    expect(getSessionState()).toEqual({ tabs: [], activeIndex: 3 })
  })

  it('falls back to [] when tabs is undefined', () => {
    setSessionState({ activeIndex: 1 })
    expect(getSessionState()).toEqual({ tabs: [], activeIndex: 1 })
  })
})

describe('registerSessionIpc', () => {
  it('registers a one-way session:save listener that calls setSessionState', () => {
    registerSessionIpc()
    expect(ipcMain.on).toHaveBeenCalledWith('session:save', expect.any(Function))

    const handler = ipcMain.on.mock.calls[0][1]
    const tabs = [{ filePath: 'C:\\docs\\c.md', draftUuid: null, scrollTop: 7 }]
    handler(null, { tabs, activeIndex: 0 })

    expect(getSessionState()).toEqual({ tabs, activeIndex: 0 })
  })
})
