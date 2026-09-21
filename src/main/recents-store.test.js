// Regression tests for recents-store.js (PERS-07's data layer): capped
// dedup for both documents and folders, the real Windows-list reconciliation
// on prune, and the Windows Jump List custom "Recent Folders" category
// (06-RESEARCH.md Pitfall 5 -- task-type items only, never file-type; the
// call itself must exist even with zero folders).
//
// `electron`'s `app`/`ipcMain` are faked as plain objects exposing
// vi.fn()-backed methods, mirroring window-state.test.js's own
// `vi.mock('electron', ...)` shape for its `screen` dependency.
// `electron-store`'s `Store` is faked with a plain in-memory object,
// identical to window-state.test.js's FakeStore.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    addRecentDocument: vi.fn(),
    clearRecentDocuments: vi.fn(),
    setJumpList: vi.fn()
  },
  ipcMain: { handle: vi.fn() }
}))

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
  addRecentDocument,
  addRecentFolder,
  pruneDocument,
  pruneFolder,
  clearAll,
  getRecents,
  registerRecentsIpc,
  store
} = await import('./recents-store.js')
const { app, ipcMain } = await import('electron')

function resetStore () {
  store.data = { documents: [], folders: [] }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe('addRecentDocument', () => {
  it('adds a new document to the front of the list and calls app.addRecentDocument', () => {
    addRecentDocument('C:\\docs\\a.md')
    expect(getRecents().documents).toEqual(['C:\\docs\\a.md'])
    expect(app.addRecentDocument).toHaveBeenCalledWith('C:\\docs\\a.md')
  })

  it('caps documents at 10, evicting the OLDEST once an 11th distinct document is pushed', () => {
    for (let i = 1; i <= 11; i++) {
      addRecentDocument(`C:\\docs\\doc-${i}.md`)
    }
    const { documents } = getRecents()
    expect(documents).toHaveLength(10)
    expect(documents).not.toContain('C:\\docs\\doc-1.md')
    expect(documents[0]).toBe('C:\\docs\\doc-11.md')
  })

  it('moves an already-present path (different case) to index 0 without duplicating', () => {
    addRecentDocument('C:\\Docs\\A.md')
    addRecentDocument('C:\\docs\\b.md')
    addRecentDocument('c:\\docs\\a.md')

    const { documents } = getRecents()
    expect(documents).toHaveLength(2)
    expect(documents[0]).toBe('c:\\docs\\a.md')
  })
})

describe('addRecentFolder', () => {
  it('adds a new folder to the front of the list and rebuilds the jump list', () => {
    addRecentFolder('C:\\Users\\me\\Documents\\Notes')
    expect(getRecents().folders).toEqual(['C:\\Users\\me\\Documents\\Notes'])
    expect(app.setJumpList).toHaveBeenCalled()
  })

  it('caps folders at 10, evicting the OLDEST once an 11th distinct folder is pushed', () => {
    for (let i = 1; i <= 11; i++) {
      addRecentFolder(`C:\\folders\\folder-${i}`)
    }
    const { folders } = getRecents()
    expect(folders).toHaveLength(10)
    expect(folders).not.toContain('C:\\folders\\folder-1')
  })

  it('moves an already-present folder path (different case) to index 0 without duplicating', () => {
    addRecentFolder('C:\\Folders\\One')
    addRecentFolder('C:\\folders\\two')
    addRecentFolder('c:\\folders\\one')

    const { folders } = getRecents()
    expect(folders).toHaveLength(2)
    expect(folders[0]).toBe('c:\\folders\\one')
  })

  it('the LAST app.setJumpList call reflects exactly one Recent Folders category whose item is type: task with the folder basename as title', () => {
    addRecentFolder('C:\\Users\\me\\Documents\\Notes')

    const lastCallArg = app.setJumpList.mock.calls.at(-1)[0]
    expect(lastCallArg).toHaveLength(1)
    expect(lastCallArg[0]).toMatchObject({ type: 'custom', name: 'Recent Folders' })
    expect(lastCallArg[0].items).toHaveLength(1)
    expect(lastCallArg[0].items[0].type).toBe('task')
    expect(lastCallArg[0].items[0].title).toBe('Notes')
  })
})

describe('pruneDocument', () => {
  it('removes exactly one entry and reconciles the real Windows list via clearRecentDocuments + re-add', () => {
    addRecentDocument('C:\\docs\\a.md')
    addRecentDocument('C:\\docs\\b.md')
    addRecentDocument('C:\\docs\\c.md')
    vi.clearAllMocks()

    pruneDocument('C:\\docs\\b.md')

    expect(getRecents().documents).toEqual(['C:\\docs\\c.md', 'C:\\docs\\a.md'])
    expect(app.clearRecentDocuments).toHaveBeenCalledTimes(1)
    expect(app.addRecentDocument).toHaveBeenCalledTimes(2)
    expect(app.addRecentDocument).toHaveBeenNthCalledWith(1, 'C:\\docs\\c.md')
    expect(app.addRecentDocument).toHaveBeenNthCalledWith(2, 'C:\\docs\\a.md')
  })

  it('is a no-op on a path that is not present', () => {
    addRecentDocument('C:\\docs\\a.md')
    vi.clearAllMocks()

    pruneDocument('C:\\docs\\nonexistent.md')

    expect(getRecents().documents).toEqual(['C:\\docs\\a.md'])
    expect(app.clearRecentDocuments).toHaveBeenCalledTimes(1)
    expect(app.addRecentDocument).toHaveBeenCalledTimes(1)
  })
})

describe('pruneFolder', () => {
  it('removes exactly one folder entry and rebuilds the jump list', () => {
    addRecentFolder('C:\\folders\\one')
    addRecentFolder('C:\\folders\\two')
    vi.clearAllMocks()

    pruneFolder('C:\\folders\\one')

    expect(getRecents().folders).toEqual(['C:\\folders\\two'])
    expect(app.setJumpList).toHaveBeenCalledTimes(1)
    const lastCallArg = app.setJumpList.mock.calls.at(-1)[0]
    expect(lastCallArg[0].items).toHaveLength(1)
    expect(lastCallArg[0].items[0].title).toBe('two')
  })
})

describe('clearAll', () => {
  it('empties both lists and clears/rebuilds the native and jump-list state', () => {
    addRecentDocument('C:\\docs\\a.md')
    addRecentFolder('C:\\folders\\one')
    vi.clearAllMocks()

    clearAll()

    expect(getRecents()).toEqual({ documents: [], folders: [] })
    expect(app.clearRecentDocuments).toHaveBeenCalledTimes(1)
    expect(app.setJumpList).toHaveBeenCalledTimes(1)
    const lastCallArg = app.setJumpList.mock.calls.at(-1)[0]
    expect(lastCallArg[0].items).toEqual([])
  })
})

describe('registerRecentsIpc', () => {
  it('calls app.setJumpList exactly once at registration time, even with zero folders, with an items: [] array (not skipped)', () => {
    const onChanged = vi.fn()
    registerRecentsIpc({}, onChanged)

    expect(app.setJumpList).toHaveBeenCalledTimes(1)
    const arg = app.setJumpList.mock.calls[0][0]
    expect(arg[0]).toMatchObject({ type: 'custom', name: 'Recent Folders', items: [] })
  })

  it('registers recents:add-document and recents:report-open-failure handlers that invoke onChanged', () => {
    const onChanged = vi.fn()
    registerRecentsIpc({}, onChanged)

    expect(ipcMain.handle).toHaveBeenCalledWith('recents:add-document', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('recents:report-open-failure', expect.any(Function))

    const addHandler = ipcMain.handle.mock.calls.find((c) => c[0] === 'recents:add-document')[1]
    const failureHandler = ipcMain.handle.mock.calls.find((c) => c[0] === 'recents:report-open-failure')[1]

    addHandler(null, 'C:\\docs\\a.md')
    expect(getRecents().documents).toEqual(['C:\\docs\\a.md'])
    expect(onChanged).toHaveBeenCalledTimes(1)

    failureHandler(null, 'C:\\docs\\a.md')
    expect(getRecents().documents).toEqual([])
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  // [WR-02, 06-REVIEW.md] Neither handler had ANY type/length check before
  // this fix -- a malformed or oversized renderer-supplied filePath would
  // reach the store, app.addRecentDocument(), and (via menu.js's own label
  // rendering) path.basename() unchecked.
  describe('WR-02: filePath re-validation', () => {
    it.each([
      ['a non-string (number)', 42],
      ['a non-string (object)', { not: 'a path' }],
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['a string over the 4096-char cap', 'C:\\' + 'a'.repeat(4100) + '.md'],
    ])('recents:add-document is a no-op for %s -- does not mutate the store or call onChanged', (_label, badValue) => {
      const onChanged = vi.fn()
      registerRecentsIpc({}, onChanged)
      const addHandler = ipcMain.handle.mock.calls.find((c) => c[0] === 'recents:add-document')[1]

      addHandler(null, badValue)

      expect(getRecents().documents).toEqual([])
      expect(onChanged).not.toHaveBeenCalled()
      expect(app.addRecentDocument).not.toHaveBeenCalled()
    })

    it('recents:report-open-failure is a no-op for a malformed filePath -- does not mutate the store or call onChanged', () => {
      addRecentDocument('C:\\docs\\a.md')
      const onChanged = vi.fn()
      registerRecentsIpc({}, onChanged)
      const failureHandler = ipcMain.handle.mock.calls.find((c) => c[0] === 'recents:report-open-failure')[1]

      failureHandler(null, { not: 'a path' })

      expect(getRecents().documents).toEqual(['C:\\docs\\a.md'])
      expect(onChanged).not.toHaveBeenCalled()
    })

    it('a well-formed filePath at exactly the 4096-char cap is still accepted', () => {
      const onChanged = vi.fn()
      registerRecentsIpc({}, onChanged)
      const addHandler = ipcMain.handle.mock.calls.find((c) => c[0] === 'recents:add-document')[1]
      const longPath = 'C:\\' + 'a'.repeat(4090) + '.md' // 4096 chars total
      expect(longPath).toHaveLength(4096)

      addHandler(null, longPath)

      expect(getRecents().documents).toEqual([longPath])
      expect(onChanged).toHaveBeenCalledTimes(1)
    })
  })
})
