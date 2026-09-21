// Renderer side of the before-quit handshake (SHELL-03/04) -- see
// src/main/before-quit.js for the main-process half. This is a SEPARATE,
// additional safety net alongside main.js's existing `beforeunload` DOM
// listener (Phase 1), which remains untouched. [WR-03, 11-REVIEW.md]
// Calling it "the browser-native fallback for any quit path that does not
// go through app.on('before-quit') (e.g. an OS-initiated shutdown)" is an
// UNVERIFIED ASSUMPTION, not a confirmed fact -- no empirical reproduction
// has exercised a real OS-shutdown/logoff scenario, and with
// src/main/before-quit.js's `win.on('close')` now unconditionally
// intercepting via preventDefault() on every ordinary close trigger, the
// set of quit paths that genuinely still reach `beforeunload` may be
// smaller than this comment implies. No removal of that existing listener
// is in scope here regardless -- see
// .planning/todos/pending/beforeunload-os-shutdown-fallback-unverified.md.
//
// [05-12, DOC-06] Restructured onto a genuine two-IPC-round-trip handshake
// (05-RESEARCH.md Architecture Pattern 4): main cannot render the native
// AGGREGATED dialog's message/detail text until it knows WHICH documents
// are dirty and what their display names are -- that is exclusively
// renderer state (documents.js). This module's own confirm()-based prompt
// is deleted outright; the native dialog now lives entirely in main
// (src/main/before-quit.js), replacing it per 05-UI-SPEC.md Surface 5.
//
// This module's job on every quit attempt is now:
// (1) answer 'app:query-dirty-state' by enumerating every dirty document
//     and sending it back over the new 'app:dirty-documents' channel (via
//     the preload bridge's sendDirtyDocuments());
// (2) receive the user's button choice ('save-all'|'discard-all'|'cancel')
//     back over onQuitDecisionRequest -- the SAME 'app:quit-decision'
//     channel this module already uses to report its OWN final decision
//     on, reused bidirectionally (see before-quit.js's header comment for
//     why this is safe, not a collision);
// (3) for 'save-all', loop over EVERY dirty document (not just the active
//     one -- the real gap 05-08 deliberately left open for this plan)
//     calling the SAME saveFile()/saveFileAs() escalation the single-
//     document case already used (WR-06: never-saved -> real Save-As),
//     cancelling the WHOLE quit (never partially completing it) the
//     moment any one save fails or any Save-As is cancelled, per UI-SPEC
//     Surface 5's explicit "never partially complete" rule;
// (4) for 'discard-all', report 'proceed' immediately with no save action
//     at all;
// (5) for 'cancel', report nothing further, mirroring the pre-05-12 cancel
//     path exactly.
//
// [05-08, historical] documents.js is the SOLE dirty-tracking mechanism --
// the single-document singleton this file used to read was deleted in that
// plan. isQuitProceeding() (below) remains the minimal coordination signal
// that prevents main.js's independent `beforeunload` fallback guard from
// re-blocking a quit this handshake has already decided to proceed with --
// preserved verbatim across this restructuring, per 05-08-SUMMARY.md's own
// "Next Phase Readiness" note.
import { saveFile, saveFileAs } from './files/save.js';
import { getDocumentIds, getDocument, isDocumentDirty } from './documents.js';
import { showStatus } from './status.js';
import { flushAllDrafts } from './drafts/draft-journal.js';

// Set the instant this handshake decides 'proceed' -- see header comment.
// Not a bare exported binding (this codebase's established discipline) --
// only a read-only getter is exported.
let quitProceeding = false;

export function isQuitProceeding() {
  return quitProceeding;
}

// Same display-name derivation tab-bar.js's own displayName() uses
// (filename only for a saved document, the assigned/fallback 'Untitled'
// name otherwise) -- duplicated rather than imported, since importing
// tabs/tab-bar.js here would create the exact reverse dependency
// 05-PATTERNS.md's "tab-bar.js -> documents.js only, never the reverse"
// discipline forbids.
function displayNameFor(doc) {
  if (!doc.filePath) return doc.name || 'Untitled';
  return doc.filePath.split(/[\\/]/).pop();
}

// Enumerates every dirty document, in tab order, as the {docId, name}
// shape before-quit.js's aggregated dialog needs to build its message/
// detail text. before-quit.js caps/coerces this array itself (T-5-01) --
// this module sends the real, uncapped list; main is the trust boundary
// that decides how much of it to actually show.
function enumerateDirtyDocuments() {
  const dirty = [];
  for (const docId of getDocumentIds()) {
    const doc = getDocument(docId);
    if (doc && doc.dirty) dirty.push({ docId, name: displayNameFor(doc) });
  }
  return dirty;
}

window.mdforge.onQueryDirtyState(async () => {
  // [06-05, PERS-01] Immediate-flush trigger 3 of 3 (before-quit): forces
  // every pending debounced draft write to disk BEFORE main even computes
  // what to show the user -- the FIRST statement in this handler, before
  // sendDirtyDocuments, so a still-dirty document's not-yet-journalled edit
  // is never lost to the 2-second debounce window on this, the very last
  // chance to write it. Distinct from before-quit.js's own sweepAllDrafts()
  // (06-04), which deletes already-CLEAN drafts AFTER a quit decision
  // resolves -- a different concern from flushing a still-dirty pending
  // write before the dialog even appears.
  //
  // [06-10, Rule 1 - Bug] AWAITED, not fire-and-forget: flushAllDrafts()
  // only INITIATING its writes (the pre-existing behaviour) leaves a real
  // race against main's own sweepAllDrafts()+app.quit() sequence once the
  // user's quit-decision answer comes back -- under a fast enough answer,
  // the sweep can run and the process can exit before the flush's own
  // async fs write actually lands, leaving a half-written draft behind
  // after an ostensibly clean quit. Reproduced directly against this app
  // (via a mocked dialog resolving in a microtask, collapsing the human-
  // response-time cushion a real dialog always provides) while writing
  // this plan's own clean-quit-drafts.spec.js. Awaiting here means
  // sendDirtyDocuments() -- and therefore the dialog itself -- never fires
  // until every pending draft has genuinely landed on disk, which also
  // strengthens this file's own "before the quit dialog is even shown"
  // guarantee from "initiated before" to "completed before".
  //
  // [CR-01, 06-REVIEW.md] flushDraftNow()'s own `.catch()` (draft-
  // journal.js) already ensures flushAllDrafts()'s Promise.all can no
  // longer reject on a genuine write failure (disk full, OneDrive/
  // Defender lock, etc.) -- but this try/catch is defense in depth
  // regardless, in case a future caller of flushAllDrafts() (or a change
  // to draft-journal.js) ever forgets to catch internally. Before CR-01,
  // an uncaught rejection here meant `sendDirtyDocuments()` never ran at
  // all: main's own `ipcMain.once('app:dirty-documents', ...)`
  // (before-quit.js) would then wait forever with `event.preventDefault()`
  // already standing -- the app could never quit again, silently, with
  // zero console-visible error. Proceeding to sendDirtyDocuments() even
  // after a caught failure here is deliberate: a draft-write failure must
  // never be allowed to block the quit decision itself.
  try {
    await flushAllDrafts();
  } catch (err) {
    console.error('quit-handshake: flushAllDrafts failed, proceeding anyway:', err);
  }
  window.mdforge.sendDirtyDocuments(enumerateDirtyDocuments());
});

window.mdforge.onQuitDecisionRequest(async (decision) => {
  if (decision === 'cancel') {
    // Mirrors the pre-05-12 cancel path exactly: main's own
    // preventDefault() already stands, so nothing further needs sending.
    return;
  }

  if (decision === 'discard-all') {
    quitProceeding = true;
    window.mdforge.sendQuitDecision('proceed');
    return;
  }

  // decision === 'save-all': loop over EVERY dirty document, not just the
  // active one -- saveFile(docId)/saveFileAs(docId)'s explicit, defaulted
  // docId parameter (05-08) is exactly what makes this loop able to save a
  // document other than whichever happens to be active.
  for (const docId of getDocumentIds()) {
    const doc = getDocument(docId);
    if (!doc || !doc.dirty) continue;

    // WR-06 (04-REVIEW.md), reused per-document: a never-saved ("Untitled")
    // document has no path -- saveFile() intentionally no-ops in that
    // state (correct for an ordinary Ctrl+S on a CLEAN path-less
    // document), so a dirty path-less document must escalate to the real
    // Save-As dialog instead, exactly as clicking "Save As..." would.
    if (doc.filePath) {
      await saveFile(docId);
    } else {
      await saveFileAs(docId);
    }

    if (isDocumentDirty(docId)) {
      // The save did not succeed (conflict, write error, or a cancelled
      // Save-As) -- the whole quit is cancelled here, never partially
      // completed (UI-SPEC Surface 5's explicit rule), and the failure is
      // surfaced via the Copywriting Contract's exact error-state copy.
      showStatus(`Could not save ${displayNameFor(getDocument(docId))} — quit cancelled.`, 'error');
      window.mdforge.sendQuitDecision('cancel');
      return;
    }
  }

  quitProceeding = true;
  window.mdforge.sendQuitDecision('proceed');
});
