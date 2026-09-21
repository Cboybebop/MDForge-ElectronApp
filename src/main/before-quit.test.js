// Unit coverage for src/main/before-quit.js's shared quitDecided latch
// (11-01, DOC-06) -- previously untested (11-RESEARCH.md: "before-quit.js
// has no dedicated unit test file today"), only exercised indirectly via
// tests/e2e/quit-handshake-aggregated.spec.js. `electron` is mocked
// following window.test.js's "instrument the constructor, fake just enough
// of the API" idiom -- `captured[channel]` records whichever handler
// app.on/ipcMain.once/ipcMain.on registered for a given channel name,
// mirroring drafts-store.test.js's own "capture the registered handler,
// invoke it directly" pattern (also used by
// src/renderer/quit-handshake.test.js).
//
// `captured` is declared via vi.hoisted() (atomic-write.test.js's own
// established idiom, cited in window-state.test.js's header) because
// vi.mock() factories are hoisted above this file's own top-level const
// declarations -- referencing a plain `const captured = {}` directly inside
// the factory would hit the temporal dead zone.
//
// `quitDecided`/`pendingProceedAction` are module-level state inside
// before-quit.js -- vi.resetModules() + a fresh dynamic import() of BOTH
// './before-quit.js' AND 'electron' in the same beforeEach (mirroring
// window.test.js's own beforeEach/vi.resetModules()/dynamic-import
// pattern) is required, and both are imported dynamically -- not just
// before-quit.js -- so that whichever `app`/`ipcMain`/`dialog` instance
// before-quit.js's own internal `import { app, ipcMain, dialog } from
// 'electron'` resolves to is GUARANTEED to be the same instance this test
// file asserts against, regardless of whether vi.resetModules() causes the
// mock factory to re-run. `captured` and every mock's call history are
// also cleared explicitly, so this suite's isolation does not depend on
// Vitest's internal mock-factory-rerun behaviour being any particular way.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { captured } = vi.hoisted(() => ({ captured: {} }))

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    on: vi.fn((channel, handler) => { captured[channel] = handler })
  },
  ipcMain: {
    once: vi.fn((channel, handler) => { captured[channel] = handler }),
    on: vi.fn((channel, handler) => { captured[channel] = handler })
  },
  dialog: {
    showMessageBox: vi.fn()
  }
}))

vi.mock('./drafts-store.js', () => ({
  sweepAllDrafts: vi.fn().mockResolvedValue(undefined)
}))

// Mirrors window-state.test.js's registerWindowStatePersistence describe
// block's makeFakeWin() idiom: a hand-rolled listener-array fake, real
// on()/emit() semantics, no real Electron process.
function makeFakeWin () {
  const listeners = {}
  return {
    isDestroyed: () => false,
    destroy: vi.fn(),
    webContents: { send: vi.fn(), isDestroyed: () => false },
    on (event, handler) {
      listeners[event] = listeners[event] || []
      listeners[event].push(handler)
    },
    emit (event, arg) {
      for (const handler of listeners[event] || []) handler(arg)
    }
  }
}

describe('before-quit.js', () => {
  let app, ipcMain, dialog
  let registerBeforeQuit, sanitizeDirtyDocuments, buildAggregatedDialogOptions

  beforeEach(async () => {
    vi.resetModules()
    for (const key of Object.keys(captured)) delete captured[key]
    ;({ app, ipcMain, dialog } = await import('electron'))
    vi.clearAllMocks()
    ;({ registerBeforeQuit, sanitizeDirtyDocuments, buildAggregatedDialogOptions } = await import('./before-quit.js'))
  })

  describe('sanitizeDirtyDocuments', () => {
    it('returns [] for a non-array input', () => {
      expect(sanitizeDirtyDocuments(null)).toEqual([])
      expect(sanitizeDirtyDocuments(undefined)).toEqual([])
      expect(sanitizeDirtyDocuments('not an array')).toEqual([])
      expect(sanitizeDirtyDocuments({})).toEqual([])
    })

    it('coerces a mixed-shape array to the documented { name } shape (T-5-01)', () => {
      const result = sanitizeDirtyDocuments([
        { docId: 'a' }, // missing name -- falls back to 'Untitled'
        'not an object', // non-object entry -- dropped
        { docId: 'b', name: 'real.md' } // valid entry -- passed through
      ])
      expect(result).toEqual([
        { name: 'Untitled' },
        { name: 'real.md' }
      ])
    })
  })

  describe('buildAggregatedDialogOptions', () => {
    it('pluralises the message correctly (singular vs. plural)', () => {
      const singular = buildAggregatedDialogOptions([{ name: 'a.md' }])
      expect(singular.message).toBe('You have unsaved changes in 1 document.')

      const plural = buildAggregatedDialogOptions([{ name: 'a.md' }, { name: 'b.md' }])
      expect(plural.message).toBe('You have unsaved changes in 2 documents.')
    })

    it('caps the detail text at 10 names plus an overflow line for an 11-entry input', () => {
      const docs = Array.from({ length: 11 }, (_, i) => ({ name: `doc-${i + 1}.md` }))
      const options = buildAggregatedDialogOptions(docs)
      const lines = options.detail.split('\n')
      expect(lines).toHaveLength(11) // 10 capped names + 1 overflow line
      expect(lines[10]).toBe('…and 1 more.')
    })

    it('locks the buttons/defaultId/cancelId/noLink contract', () => {
      const options = buildAggregatedDialogOptions([{ name: 'a.md' }])
      expect(options.buttons).toEqual(['Save All', 'Discard All', 'Cancel'])
      expect(options.defaultId).toBe(0)
      expect(options.cancelId).toBe(2)
      expect(options.noLink).toBe(true)
    })
  })

  describe('the shared quitDecided latch', () => {
    it("the close path's own proceedAction runs when nothing is dirty, distinct from the before-quit path's", async () => {
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      const closeEvent = { preventDefault: vi.fn() }
      win.emit('close', closeEvent)
      expect(closeEvent.preventDefault).toHaveBeenCalled()

      const dirtyDocsHandler = captured['app:dirty-documents']
      expect(dirtyDocsHandler).toBeInstanceOf(Function)
      await dirtyDocsHandler(null, [])

      // The close path's own proceedAction (win.destroy()) ran -- not the
      // before-quit path's (app.quit()), proving the two proceedActions
      // are genuinely distinct per entry point.
      expect(win.destroy).toHaveBeenCalled()
      expect(app.quit).not.toHaveBeenCalled()
    })

    it('Cancel is repeatable: the app keeps running and a second close attempt re-arms a fresh app:dirty-documents listener', async () => {
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      win.emit('close', { preventDefault: vi.fn() })
      dialog.showMessageBox.mockResolvedValueOnce({ response: 2 }) // Cancel
      await captured['app:dirty-documents'](null, [{ name: 'Untitled' }])
      await captured['app:quit-decision'](null, 'cancel')

      expect(win.destroy).not.toHaveBeenCalled()

      const onceCallsBefore = ipcMain.once.mock.calls.filter(([channel]) => channel === 'app:dirty-documents').length
      win.emit('close', { preventDefault: vi.fn() })
      const onceCallsAfter = ipcMain.once.mock.calls.filter(([channel]) => channel === 'app:dirty-documents').length

      // A fresh one-shot registration for the second attempt -- not a
      // stale, already-consumed listener from the first attempt.
      expect(onceCallsAfter).toBe(onceCallsBefore + 1)
    })

    it("a decision reached via app.quit()'s before-quit path is NOT re-asked when Electron's own subsequent window close fires", async () => {
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      const beforeQuitHandler = captured['before-quit']
      expect(beforeQuitHandler).toBeInstanceOf(Function)

      const beforeQuitEvent = { preventDefault: vi.fn() }
      beforeQuitHandler(beforeQuitEvent)
      expect(beforeQuitEvent.preventDefault).toHaveBeenCalled()
      expect(ipcMain.once).toHaveBeenCalledWith('app:dirty-documents', expect.any(Function))

      dialog.showMessageBox.mockResolvedValueOnce({ response: 1 }) // Discard All
      await captured['app:dirty-documents'](null, [{ name: 'Untitled' }])
      await captured['app:quit-decision'](null, 'proceed')

      // The before-quit path's own proceedAction ran.
      expect(app.quit).toHaveBeenCalled()

      // Simulate Electron's own internal behaviour: a second app.quit()
      // call proceeding to close the real window fires this module's
      // 'close' handler too. The shared quitDecided latch (already true
      // from the before-quit path's own decision) must stop it from
      // re-running the dirty-document check and showing a second dialog.
      const closeEvent = { preventDefault: vi.fn() }
      win.emit('close', closeEvent)
      expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    })
  })

  // [CR-01, 11-REVIEW.md] The shared quitDecided latch (above) only guards
  // SEQUENTIAL orderings -- it is set true only once a decision is
  // genuinely REACHED. These tests exercise the CONCURRENT case: a second
  // trigger of either entry point arriving DURING the in-flight window
  // between event.preventDefault() and that decision resolving, which
  // win.on('close')'s use of .on() (not .once()) makes genuinely reachable
  // via an ordinary double-click on the window's X or a double Alt+F4.
  // Timing is made deterministic (not relying on real race timing) by
  // manually controlling dialog.showMessageBox's / sweepAllDrafts's own
  // resolution, so the "still pending" window is exercised for certain on
  // every run, not just when the test happens to win a real race.
  describe('CR-01: concurrent quit triggers during the in-flight window', () => {
    it('two close() calls in immediate succession produce exactly ONE dirty-documents round trip, ONE dialog, and the second close() is blocked (preventDefault) rather than re-entering the handshake', async () => {
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      let resolveDialog
      dialog.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { resolveDialog = resolve }))

      const closeEvent1 = { preventDefault: vi.fn() }
      win.emit('close', closeEvent1)
      expect(closeEvent1.preventDefault).toHaveBeenCalled()

      const dirtyDocsCallsAfterFirst = ipcMain.once.mock.calls.filter(([c]) => c === 'app:dirty-documents').length
      expect(dirtyDocsCallsAfterFirst).toBe(1)

      // The first attempt's own listener starts awaiting
      // dialog.showMessageBox (deliberately left unresolved) -- the
      // handshake is now genuinely in flight, not yet decided.
      const dirtyDocsHandler = captured['app:dirty-documents']
      const firstAttemptPromise = dirtyDocsHandler(null, [{ name: 'a.md' }])

      // Second close() call -- the ordinary double-click / double-Alt+F4
      // scenario -- arrives while the first attempt's decision is still
      // pending (checkInFlight true, quitDecided still false).
      const closeEvent2 = { preventDefault: vi.fn() }
      win.emit('close', closeEvent2)

      // Blocked, not re-entered: still preventDefault()'d (the window must
      // not close out from under the still-pending decision), but no
      // second 'app:dirty-documents' registration and no second dialog.
      expect(closeEvent2.preventDefault).toHaveBeenCalled()
      const dirtyDocsCallsAfterSecond = ipcMain.once.mock.calls.filter(([c]) => c === 'app:dirty-documents').length
      expect(dirtyDocsCallsAfterSecond).toBe(1)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)

      // Resolve the ONE dialog with Save All's response -- the first
      // attempt's own decision, and only decision.
      resolveDialog({ response: 0 })
      await firstAttemptPromise
      await captured['app:quit-decision'](null, 'proceed')

      // win.destroy() ran exactly once, even though close() fired twice.
      expect(win.destroy).toHaveBeenCalledTimes(1)
    })

    it('a Save-All proceedAction still awaiting sweepAllDrafts is never interrupted by a concurrent second close() arriving mid-write', async () => {
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      const { sweepAllDrafts } = await import('./drafts-store.js')
      let resolveSweep
      sweepAllDrafts.mockImplementationOnce(() => new Promise((resolve) => { resolveSweep = resolve }))

      win.emit('close', { preventDefault: vi.fn() })
      dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }) // Save All
      await captured['app:dirty-documents'](null, [{ name: 'a.md' }])

      // The renderer answers 'proceed' -- quitDecided flips true and the
      // proceedAction (sweepAllDrafts -> win.destroy()) starts running, but
      // is still mid-await on sweepAllDrafts (deliberately unresolved) --
      // simulating "Save-All is still mid-write" from the review's traced
      // failure mode.
      const decisionPromise = captured['app:quit-decision'](null, 'proceed')

      // A concurrent second close() arrives while that proceedAction is
      // still mid-write. quitDecided is already true by this point, so this
      // is the documented "let it through" case (matches the sequential
      // test above) -- it must NOT re-enter runDirtyDocumentsCheck.
      const dirtyDocsCallsBefore = ipcMain.once.mock.calls.filter(([c]) => c === 'app:dirty-documents').length
      win.emit('close', { preventDefault: vi.fn() })
      const dirtyDocsCallsAfter = ipcMain.once.mock.calls.filter(([c]) => c === 'app:dirty-documents').length
      expect(dirtyDocsCallsAfter).toBe(dirtyDocsCallsBefore)

      // sweepAllDrafts has not resolved yet -- destroy() must not have run
      // early, proving the concurrent close() did not race it forward.
      expect(win.destroy).not.toHaveBeenCalled()

      resolveSweep()
      await decisionPromise

      // Runs exactly once, only after the real sweep genuinely finished.
      expect(win.destroy).toHaveBeenCalledTimes(1)
    })

    it('clicking Cancel on the dialog clears the in-flight guard even though the renderer sends NOTHING back over app:quit-decision for that case, so a later retry is a genuinely fresh attempt, not permanently blocked', async () => {
      // [CR-01 fix-forward] Deliberately does NOT call
      // captured['app:quit-decision'](null, 'cancel') the way the OTHER
      // Cancel-related tests in this file do -- quit-handshake.js's real
      // onQuitDecisionRequest('cancel') branch sends nothing back at all
      // ("nothing further needs sending", its own comment's words). Only
      // the FAILED-Save-All path genuinely replies 'cancel' over that
      // channel. An earlier version of this fix cleared checkInFlight only
      // inside that ipcMain.on('app:quit-decision') handler, which left the
      // app permanently unquittable after an ordinary dialog Cancel -- a
      // regression this test reproduces without relying on end-to-end
      // Playwright timing.
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      win.emit('close', { preventDefault: vi.fn() })
      dialog.showMessageBox.mockResolvedValueOnce({ response: 2 }) // Cancel
      await captured['app:dirty-documents'](null, [{ name: 'Untitled' }])

      // A later retry must reach the dialog again -- not be silently
      // swallowed by a checkInFlight flag left true from the cancelled
      // attempt.
      const closeEvent = { preventDefault: vi.fn() }
      win.emit('close', closeEvent)
      expect(closeEvent.preventDefault).toHaveBeenCalled()

      const dirtyDocsCalls = ipcMain.once.mock.calls.filter(([c]) => c === 'app:dirty-documents').length
      expect(dirtyDocsCalls).toBe(2) // one per attempt
    })

    it('a Save-All attempt that fails partway (the renderer genuinely replies "cancel") also clears the in-flight guard', async () => {
      const win = makeFakeWin()
      registerBeforeQuit(win, 'fake-drafts-dir')

      win.emit('close', { preventDefault: vi.fn() })
      dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }) // Save All
      await captured['app:dirty-documents'](null, [{ name: 'a.md' }])
      // Simulates quit-handshake.js's Save-All loop reporting a failed
      // save/cancelled Save-As back to main over the same channel.
      await captured['app:quit-decision'](null, 'cancel')

      const closeEvent = { preventDefault: vi.fn() }
      win.emit('close', closeEvent)
      expect(closeEvent.preventDefault).toHaveBeenCalled()

      const dirtyDocsCalls = ipcMain.once.mock.calls.filter(([c]) => c === 'app:dirty-documents').length
      expect(dirtyDocsCalls).toBe(2) // one per attempt
    })
  })
})
