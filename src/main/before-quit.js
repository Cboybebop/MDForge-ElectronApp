// before-quit <-> renderer handshake (SHELL-03/04, DOC-06) -- the LAST plan in the
// phase, per the binding O6 ordering constraint (04-CONTEXT.md): this
// handshake's "Save" action must route through the real atomic-write path
// built in 04-02/04-04, never a stub.
//
// [11-01, DOC-06 REVISION] This module now has TWO real entry points, not
// one: `app.on('before-quit')` (Electron's own app-level quit sequence) AND
// `win.on('close')` (a real window X-click / BrowserWindow.close() call).
// 11-RESEARCH.md's empirical reproduction established that these were
// PREVIOUSLY independent -- a real close never reached this module at all,
// because src/renderer/main.js's legacy DOM `beforeunload` listener
// (Phase 1, predates the styled dialog) intercepted it first with
// Chromium's own generic, unstyled confirm. If that native confirm
// resolved to "leave", the window actually closed, 'window-all-closed'
// fired src/main/index.js's unconditional app.quit(), and THIS module's
// own `before-quit` handler then saw `win.isDestroyed() === true` and
// early-returned -- skipping the aggregated dialog entirely, with zero
// prompt, zero save. If it resolved to "stay", nothing happened at all --
// matching the exact "clicking the window's X does nothing" bug report.
// Both branches meant the styled Save All / Discard All / Cancel dialog was
// structurally unreachable via a real close. See 11-RESEARCH.md for the
// full empirical trace; src/renderer/main.js's own `beforeunload` listener
// is deliberately left unmodified. [WR-03, 11-REVIEW.md] Its role as an
// "OS-shutdown fallback" for quit paths that never go through either entry
// point this module now owns is an UNVERIFIED ASSUMPTION inherited from
// prior phases, not a confirmed fact -- no empirical reproduction (this
// phase's own 11-RESEARCH.md included) has exercised a real OS-shutdown/
// logoff scenario to confirm `beforeunload` is genuinely still reachable
// there once `win.on('close')` unconditionally intercepts via
// preventDefault() on every ordinary close trigger. It is left in place
// specifically BECAUSE this is unverified, not because its fallback role is
// confirmed -- deleting it on a guess could silently remove real OS-
// shutdown-path protection this codebase has not actually tested. See
// .planning/todos/pending/beforeunload-os-shutdown-fallback-unverified.md.
//
// runDirtyDocumentsCheck(win, draftsDir, proceedAction) is the ONE shared
// implementation both entry points call: it does the real two-IPC-round-
// trip handshake with the renderer (query dirty state -> build/show the
// aggregated dialog if anything is dirty -> await the renderer's decision),
// and `proceedAction` is supplied BY THE CALLER, since the two entry points
// must do genuinely different things once the user has decided to proceed
// -- the before-quit path calls `app.quit()` again (letting Electron's own
// quit sequence continue); the close path calls `win.destroy()` (bypassing
// the close/beforeunload sequence entirely, rather than re-entering this
// same module's own `close` handler a second time).
//
// app.on('before-quit') is the one point in the app's lifecycle where a
// quit can still be intercepted before the process actually starts tearing
// down. src/main/index.js's existing 'window-all-closed' handler already
// calls app.quit() unconditionally once the window closes, so this handler
// must call event.preventDefault() synchronously on every firing until the
// renderer has genuinely answered -- otherwise that unconditional call (or
// any other quit trigger) sails straight through. win.on('close') needs the
// exact same discipline, for the exact same reason, on the window's own
// close event.
//
// quitDecided is a SINGLE SHARED one-shot latch (threat_model T-11-07),
// checked by BOTH entry points, and it MUST remain single/shared rather
// than being split into two independent per-entry-point latches (one
// tracking the before-quit path's own decision, a separate one tracking
// the close path's). A two-latch design was tried in an earlier draft of
// this plan and rejected by review after being traced step-by-step:
// consider Discard All via `app.quit()` -- `before-quit` fires (its own
// latch false) -> preventDefault -> dialog -> Discard All -> renderer
// replies 'proceed' -> that latch flips true -> app.quit() fires a SECOND
// time -> before-quit fires again, its own latch now true -> early return
// -> Electron's own quit sequence proceeds to really close the window ->
// the window's real close sequence fires THIS module's `close` handler ->
// with its OWN SEPARATE, still-false latch, the entire dirty-document
// check would run AGAIN for the very same user action, showing the dialog
// a SECOND time (wasted but silent on Save-All, where the second round
// trip finds zero dirty docs; visible and wrong on Discard All, where
// quit-handshake.js's own 'discard-all' branch never marks documents
// clean, so the same dirty documents are still dirty and the dialog
// reappears). A SINGLE shared `quitDecided` latch closes this: once EITHER
// entry point's handshake reaches a genuine 'proceed' decision, the other
// entry point's own guard sees the same flag already true and
// early-returns with no preventDefault, letting the real close/quit
// continue exactly once. Traced in full, both directions, in
// 11-01-PLAN.md Task 2's own acceptance criteria.
//
// quitDecided is set to `true` in exactly two places, both reached only
// once a decision is genuinely final: (1) inside runDirtyDocumentsCheck,
// immediately, when there is nothing dirty to ask about at all; (2) inside
// the shared 'app:quit-decision' handler, but ONLY on `decision ===
// 'proceed'`, before invoking whichever `proceedAction` is currently
// pending. It is deliberately NOT set at the point the dialog's answer is
// first sent to the renderer -- the Save-All branch can still fail partway
// (a document save or Save-As cancelled) and report 'cancel' back
// asynchronously; latching early would wrongly block a legitimate retry.
// On `decision === 'cancel'`, quitDecided stays false, so a later retry via
// either entry point is treated as a fresh attempt -- this is what makes
// Cancel genuinely repeatable, not a one-shot-per-process-lifetime gate.
//
// pendingProceedAction holds whichever caller's `proceedAction` is
// currently awaiting the renderer's answer -- re-set fresh on every
// runDirtyDocumentsCheck call (one per attempt), read and cleared by the
// shared 'app:quit-decision' handler once a 'proceed' decision arrives.
//
// A renderer that never answers at all leaves the app open (the safe
// default -- never losing data) rather than force-quitting over unsaved
// work.
//
// [05-12, DOC-06] Restructured onto TWO IPC round trips per 05-RESEARCH.md
// Architecture Pattern 4: this process cannot build the native AGGREGATED
// dialog's message/detail text without first learning WHICH documents are
// dirty and what their display names are -- exclusively renderer state
// (documents.js).
//
// 'app:quit-decision' is now used BIDIRECTIONALLY, deliberately: this
// module SENDS the user's button choice ('save-all'|'discard-all'|'cancel')
// to the renderer over it (win.webContents.send), and separately RECEIVES
// the renderer's own final outcome ('proceed'|'cancel') over it
// (ipcMain.on), exactly as it always has. This is safe, not a channel
// collision: ipcMain.on() only ever fires for a message the renderer sent
// via ipcRenderer.send(), and a renderer's own ipcRenderer.on() listener
// only ever fires for a message THIS process sent via webContents.send() --
// the two directions never cross-talk even while sharing one channel
// string. This remains true with two possible callers of runDirtyDocuments
// Check: whichever one is currently pending is the one whose proceedAction
// runs, via the single shared pendingProceedAction reference.
//
// T-5-01/T-11-01 (05-12-PLAN.md / 11-01-PLAN.md threat_model): the
// renderer-supplied dirty-document array crosses the IPC trust boundary
// into main, which builds a NATIVE DIALOG'S VISIBLE TEXT from it -- for
// BOTH entry points now, unconditionally, by construction (both call the
// same runDirtyDocumentsCheck). This handler -- not the renderer -- caps
// the list at 10 entries (+ "…and {n} more.") and coerces every entry's
// shape, matching this codebase's established discipline (dialogs.js's own
// header comment; path-guard.js's isSafeFilePath) of re-validating
// renderer-supplied data regardless of caller trust.
import { app, ipcMain, dialog } from 'electron'
import { sweepAllDrafts } from './drafts-store.js'

const MAX_DIRTY_NAMES = 10

let quitDecided = false
let pendingProceedAction = null

// [CR-01, 11-REVIEW.md] A SECOND shared flag, deliberately distinct in
// purpose from quitDecided above: quitDecided only latches once a decision
// has genuinely been REACHED (zero-dirty proceed, or the renderer's final
// 'proceed'), so there is an unguarded async window -- the full
// query-dirty-state/flushAllDrafts round trip, plus however long the user
// takes to answer the dialog -- during which quitDecided is still false.
// win.on('close') is registered with .on(), not .once(), and
// BrowserWindow.close() re-fires 'close' on every call regardless of a
// prior attempt's pending decision -- an ordinary double-click on the
// window's X, or a double Alt+F4, lands a second trigger inside that
// window. Without this flag, that second trigger would register its own
// 'app:dirty-documents' once-listener (line ~215 below), and the renderer's
// single reply would fire BOTH listeners, potentially showing the
// aggregated dialog twice and racing two independent proceedActions --
// including a real path where one instance's 'proceed' calls
// win.destroy()/app.quit() while the other instance's Save-All loop is
// still mid-write. checkInFlight is set synchronously, before any `await`,
// at the very start of runDirtyDocumentsCheck, and is checked by BOTH entry
// points alongside quitDecided: a trigger arriving while a check is already
// in flight is a no-op EXCEPT for event.preventDefault() (the window must
// still not close out from under the pending decision). Unlike quitDecided,
// checkInFlight is cleared on BOTH outcomes -- proceed and cancel -- since
// its only job is to guard the in-flight window of a single attempt, not to
// remember the outcome once that attempt resolves.
let checkInFlight = false

// Defense-in-depth (T-5-01): never trust the renderer's array size or
// shape. A non-array payload, a non-object entry, or a non-string name all
// coerce to a safe fallback rather than letting a malformed payload reach
// dialog.showMessageBox's visible text unchecked.
function sanitizeDirtyDocuments (rawDocs) {
  if (!Array.isArray(rawDocs)) return []
  return rawDocs
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : 'Untitled'
    }))
}

// UI-SPEC Surface 5's exact copy/button contract -- pluralised message,
// one "• {name}" line per document (capped at MAX_DIRTY_NAMES, then a
// final "…and {n} more." line), Save All / Discard All / Cancel in that
// exact order, Save All default, Cancel mapped to both Esc and the window
// X (cancelId).
function buildAggregatedDialogOptions (docs) {
  const n = docs.length
  const message = n === 1
    ? 'You have unsaved changes in 1 document.'
    : `You have unsaved changes in ${n} documents.`

  const shown = docs.slice(0, MAX_DIRTY_NAMES)
  const overflow = n - shown.length
  const lines = shown.map((doc) => `• ${doc.name}`)
  if (overflow > 0) lines.push(`…and ${overflow} more.`)

  return {
    type: 'warning',
    title: 'Unsaved changes',
    message,
    detail: lines.join('\n'),
    buttons: ['Save All', 'Discard All', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
}

// The ONE shared dirty-document check both entry points call. `proceedAction`
// is an async callback supplied by the caller, invoked once the renderer has
// genuinely decided to proceed (immediately, if nothing is dirty; or after
// the user answers the aggregated dialog and the renderer's own Save-All
// loop, if any, completes). Re-registers a FRESH one-shot
// 'app:dirty-documents' listener on every call -- one per quit ATTEMPT, not
// per app lifetime -- so a cancelled attempt followed by a later retry (via
// either entry point) gets its own fresh answer instead of a stale,
// already-consumed listener from an earlier attempt.
function runDirtyDocumentsCheck (win, draftsDir, proceedAction) {
  // [CR-01] Set synchronously, before the first `await` anywhere in this
  // attempt -- this is what closes the concurrency gap. A second trigger
  // arriving between now and this attempt's decision (either branch below)
  // sees checkInFlight already true and never gets here a second time.
  checkInFlight = true
  ipcMain.once('app:dirty-documents', async (_event, rawDocs) => {
    const docs = sanitizeDirtyDocuments(rawDocs)

    if (docs.length === 0) {
      // Nothing dirty -- proceed exactly as the pre-05-12 zero-dirty-
      // documents path did, with no dialog at all.
      quitDecided = true
      checkInFlight = false
      await sweepAllDrafts(draftsDir)
      await proceedAction()
      return
    }

    pendingProceedAction = proceedAction
    const result = await dialog.showMessageBox(win, buildAggregatedDialogOptions(docs))
    const decision = ['save-all', 'discard-all', 'cancel'][result.response]
    if (decision === 'cancel') {
      // [CR-01 fix-forward] The renderer's onQuitDecisionRequest('cancel')
      // branch (quit-handshake.js) deliberately sends NOTHING back over
      // 'app:quit-decision' for this exact case -- "nothing further needs
      // sending" is its own comment's words. That means THIS attempt is
      // fully, permanently resolved right here: no further round trip is
      // ever coming, so ipcMain.on('app:quit-decision')'s own 'cancel'
      // branch below (reached only by the renderer's SEPARATE, later
      // 'cancel' reply after a failed Save-All) will never fire for this
      // path. checkInFlight must be cleared HERE, synchronously with this
      // decision, or a later retry via either entry point would be
      // permanently blocked -- an unquittable app, discovered via
      // tests/e2e/quit-handshake-aggregated.spec.js's real-close Cancel-
      // then-retry test, which a unit-level mock of the renderer's reply
      // did not catch.
      checkInFlight = false
      pendingProceedAction = null
    }
    win.webContents.send('app:quit-decision', decision)
  })

  win.webContents.send('app:query-dirty-state')
}

// PERS-03 (06-04): the post-confirmation clean-quit sweep -- distinct from
// the pending-draft FLUSH a not-yet-written debounced draft needs before
// quitting (that is quit-handshake.js's own renderer-side concern, wired in
// a later plan). By the time quitDecided is genuinely true here, every
// dirty document has either been saved (its draft already deleted by the
// renderer's own clean-on-save hook) or explicitly discarded -- sweeping
// whatever remains is a correct backstop, not a data-loss risk, and is what
// makes "a clean quit leaves drafts/ empty" hold even if some earlier
// delete-on-clean call was missed.
function registerBeforeQuit (win, draftsDir) {
  app.on('before-quit', (event) => {
    if (quitDecided) return // decision already reached via either entry point -- let it through
    if (checkInFlight) { event.preventDefault(); return } // [CR-01] a decision is already pending via either entry point -- block this trigger too, but do not start a second round trip
    if (win.isDestroyed() || win.webContents.isDestroyed()) return // window already gone -- nothing to ask

    event.preventDefault()
    runDirtyDocumentsCheck(win, draftsDir, async () => {
      await sweepAllDrafts(draftsDir)
      app.quit()
    })
  })

  // [11-01, DOC-06] The real user-facing close path -- a window X-click or
  // an explicit BrowserWindow.close() call -- routed into the SAME shared
  // handshake as app.quit(), via the SAME shared quitDecided latch. Guards
  // and preventDefault() discipline mirror the before-quit handler above
  // exactly. win.destroy() (not win.close() or app.quit()) is deliberate on
  // the proceed path: it bypasses the close/beforeunload sequence entirely
  // (no re-entry into this same handler), and still fires 'closed' (so
  // window-state.js's own cleanup-on-closed listener still runs), which
  // then lets index.js's existing 'window-all-closed' handler call
  // app.quit() -- re-firing 'before-quit' with quitDecided now true (the
  // SAME shared flag this close path just set), hitting the early return
  // above correctly, with no second dialog.
  win.on('close', (event) => {
    if (quitDecided) return // decision already reached via either entry point -- let it through
    if (checkInFlight) { event.preventDefault(); return } // [CR-01] a decision is already pending via either entry point (e.g. a double-click on the X, or a double Alt+F4) -- block this trigger too, but do not start a second round trip
    if (win.isDestroyed() || win.webContents.isDestroyed()) return // [WR-01, 11-REVIEW.md] mirrors the before-quit guard above exactly -- a webContents destroyed independently of the BrowserWindow would otherwise throw synchronously inside win.webContents.send() below, an uncaught main-process exception, after preventDefault() has already stood, leaving the window permanently unclosable

    event.preventDefault()
    runDirtyDocumentsCheck(win, draftsDir, async () => {
      await sweepAllDrafts(draftsDir)
      win.destroy()
    })
  })

  ipcMain.on('app:quit-decision', async (_event, decision) => {
    if (decision === 'proceed') {
      quitDecided = true
      checkInFlight = false
      const proceedAction = pendingProceedAction
      pendingProceedAction = null
      if (proceedAction) await proceedAction()
    } else if (decision === 'cancel') {
      // Reached only via the renderer's Save-All loop reporting a failed
      // save/cancelled Save-As (quit-handshake.js's own 'cancel' branch
      // there) -- the renderer's IMMEDIATE Cancel-button path deliberately
      // sends nothing back at all over this channel (see the 'cancel'
      // branch inside runDirtyDocumentsCheck above, where checkInFlight is
      // cleared synchronously for that case instead, since no reply is ever
      // coming here for it).
      //
      // [CR-01] Clear the in-flight guard so a later retry (via either
      // entry point) is genuinely treated as a fresh attempt, not
      // permanently blocked by a stale in-flight flag from this cancelled
      // one. [IN-02, 11-REVIEW.md] Also clear pendingProceedAction
      // defensively -- harmless under the pre-CR-01 sequential-only design
      // (nothing read it before the next attempt's runDirtyDocumentsCheck
      // overwrote it), but leaving a stale reference around is exactly the
      // kind of stale shared state CR-01's concurrency fix should not
      // tolerate, even though checkInFlight is what actually prevents any
      // code path from reading it while stale.
      checkInFlight = false
      pendingProceedAction = null
    }
    // The preventDefault() from whichever entry point started this attempt
    // already stands, so on 'cancel' the quit is genuinely cancelled and
    // the process keeps running -- quitDecided stays false, so a later
    // retry (via either entry point) starts clean.
  })
}

export { registerBeforeQuit, sanitizeDirtyDocuments, buildAggregatedDialogOptions }
