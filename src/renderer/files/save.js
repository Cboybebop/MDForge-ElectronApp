// SAVE (writes to the current path) + SAVE AS — rewritten against the real
// IPC bridge (04-02) in place of the deleted File System Access API picker
// module (SHELL-02/03/04). The renderer holds a path string, never a
// handle; every read/write is an async IPC round-trip to text-file.js's
// mtime/size conflict-checked write.
//
// flush() (03-04-PLAN.md, CONTEXT.md's "flush() is called before save"
// rule) remains the FIRST statement in every handler below, before
// mdInput.value is ever read -- a pending debounced preview->left
// conversion must never be silently stale at the moment the user saves
// (T-3-07). This must survive the IPC rewrite unchanged.
//
// 04-PATTERNS.md's "never catch {} / never discard the error object" shared
// pattern: the old handler's bare-literal error status (discarding the
// caught error entirely) is the exact anti-pattern this rewrite does not
// carry forward -- every failure path below surfaces result.error.message.

import { flush } from '../markdown/sync-controller.js';
import { showStatus } from '../status.js';
import { showConflictDialog } from './conflict-dialog.js';
import { renderMarkdown } from '../markdown/render.js';
import { COMMAND_IDS } from '../../shared/command-ids.js';
import { registerCommand } from '../command-dispatch.js';
import {
  getActiveDocId,
  getDocument,
  getDocumentContent,
  replaceDocumentContent,
  markDocumentClean,
  setDocumentFilePath,
  setDocumentMissing,
  setDocumentName,
} from '../documents.js';

const btnSave = document.getElementById('btn-save');
const btnSaveAs = document.getElementById('btn-save-as');

// [05-08] Full docId parameterization -- saveFile/saveFileAs no longer
// implicitly act on "the" document. Both accept an explicit, defaulted
// docId (`= getActiveDocId()`, resolved at CALL time, not at import time)
// so a non-active dirty document can be saved directly -- the exact
// capability 05-12's aggregated quit dialog's Save-All loop depends on
// (it calls saveFile(docId)/saveFileAs(docId) once per dirty document).
// Every existing zero-argument call site (the Save/Save-As buttons'
// click handlers below, Ctrl+S/Ctrl+Shift+S via registerCommand(),
// quit-handshake.js's own no-arg calls) keeps resolving to the active
// document exactly as before, since the default parameter is evaluated
// fresh on each call.
//
// Read/write is per-DOCUMENT now, not per-active-document: `path`/
// `content` resolve from documents.js's own Map entry for the given
// docId via getDocument(docId), never getActiveEditor()/a module-scope
// cached element. Writes route through documents.js's own
// setDocumentFilePath(docId, ...)/setDocumentName(docId, ...)/
// markDocumentClean(docId) -- documents.js is now the SOLE owner of this
// state; the former single-document module (which used to bridge these
// same writes for the active document only) is deleted in this same plan.
function resolveDocumentFilePath(docId) {
  return getDocument(docId)?.filePath ?? null;
}

export async function saveFile(docId = getActiveDocId()) {
  flush(docId);

  const path = resolveDocumentFilePath(docId);
  // IN-03 (04-REVIEW.md): this IS reachable, not a defensive-only guard --
  // a fresh "Untitled" document (the app's default state at launch, with no
  // session restore in this phase) has filePath === null and is directly
  // reachable via Ctrl+S or the Save menu item without ever going through
  // Save-As (menu.spec.js's "clean, path-less document" case exercises
  // exactly this). On such a document, saveFile() intentionally no-ops here
  // rather than opening a dialog. The one caller that needs different
  // behaviour for a DIRTY path-less document is the quit handshake
  // (quit-handshake.js), which now falls back to saveFileAs() itself
  // instead of relying on this guard to do that (WR-06).
  if (!path) return;

  const content = getDocumentContent(docId);
  let result = await window.mdforge.saveFile(path, content);

  if (result.ok) {
    markDocumentClean(docId);
    // WR-01 (07-REVIEW.md): a successful save writes the file back to its
    // original path -- per 07-UI-SPEC.md Surface 4's locked Recovery
    // contract, that clears a `.missing` tab's strikethrough/tooltip. A
    // no-op for a document that was never missing.
    setDocumentMissing(docId, false);
    window.mdforge.addRecentDocument(path);
    if (docId === getActiveDocId()) showStatus('Saved ✓', 'saved');
    return;
  }

  if (result.conflict) {
    const choice = await showConflictDialog();

    if (choice === 'keep-mine') {
      result = await window.mdforge.saveFile(path, content, { force: true });
      if (result.ok) {
        markDocumentClean(docId);
        setDocumentMissing(docId, false);
        window.mdforge.addRecentDocument(path);
        if (docId === getActiveDocId()) showStatus('Saved ✓', 'saved');
      } else {
        showStatus(`Save failed: ${result.error.message}`, 'error');
      }
    } else if (choice === 'reload-theirs') {
      // [05-REVIEW.md WR-03] `.value =` here is a DELIBERATE exception to
      // this codebase's undo-preserving-write discipline (execCommand
      // ('insertText') everywhere else), not an oversight, for two
      // independent reasons: (1) the user explicitly chose "discard my
      // in-memory edits and reload from disk" -- there is nothing
      // meaningful left on this surface's undo stack worth preserving,
      // unlike every OTHER write site in this codebase, which always
      // preserves a real, in-progress edit; (2) `docId` here can be a
      // NON-active document (this function is also called, with an
      // explicit docId, by a Save-All loop over every dirty tab) whose
      // surface is permanently `display:none` per documents.js -- a
      // hidden element cannot receive focus in a real browser, so
      // execCommand('insertText') (which requires a focused target) is
      // not merely undesirable here, it is unusable without either
      // stealing focus to a background tab (a worse UX defect than a
      // reset undo stack) or silently writing into whatever WAS focused
      // instead. Resetting the undo stack is the accepted, understood
      // consequence, not a silent gap.
      //
      // [12-11] `replaceDocumentContent` (documents.js, 12-08-PLAN.md) is
      // the CM6-native equivalent of that same deliberate choice: it builds
      // a brand-new EditorState (fresh undo history) rather than dispatching
      // a transaction, and pushes it live via setState() only when docId is
      // the currently active document -- exactly the "reset means reset,
      // whether visible or not" behavior `.value =` used to provide.
      //
      // [12-REVIEW.md WR-01] TOCTOU guard: `window.mdforge.openAtPath` is a
      // real IPC round trip. If the user switches to this exact (possibly
      // non-active, Save-All-loop) tab and types while it is in flight,
      // replaceDocumentContent() below would otherwise silently discard
      // those keystrokes the instant the reload resolves -- no error, no
      // dialog, no undo entry (replaceDocumentContent deliberately builds a
      // history-less fresh state). Captures this document's content
      // immediately before the await and re-checks it immediately before the
      // destructive write; a mismatch means a genuine edit landed in the
      // gap, so the reload is abandoned rather than clobbering it.
      const beforeReload = getDocumentContent(docId);
      const reopened = await window.mdforge.openAtPath(path);
      if (reopened && !reopened.error) {
        if (getDocumentContent(docId) !== beforeReload) {
          showStatus('Reload cancelled — this document changed while reloading', 'error');
        } else {
          replaceDocumentContent(docId, reopened.text);
          if (docId === getActiveDocId()) renderMarkdown(reopened.text);
          markDocumentClean(docId);
          setDocumentMissing(docId, false);
          showStatus('Reloaded from disk', 'saved');
        }
      } else if (reopened && reopened.error) {
        showStatus(`Could not reload file: ${reopened.error.message}`, 'error');
      }
    } else if (choice === 'save-as-copy') {
      await saveFileAs(docId);
    }
    return;
  }

  // A bare failure (conflict:false) -- never a literal string alone, never a
  // catch that discards the error.
  showStatus(`Save failed: ${result.error.message}`, 'error');
}

// [07-09] `suggestedName` is additive and optional -- every pre-existing
// call site (btnSaveAs's click handler, the conflict dialog's own
// save-as-copy branch above, registerCommand(COMMAND_IDS.FILE_SAVE_AS,
// saveFileAs)) omits it and keeps resolving to `null`, threaded through to
// dialogs.js's dialog:save-file-as handler as "no default path hint,"
// identical to today's behavior. The one new caller is
// workspace/reconcile.js's Save As Copy button, which passes a computed
// sibling filename (e.g. `roadmap (copy).md`) so the native Save As dialog
// pre-fills a sensible destination for that specific flow.
export async function saveFileAs(docId = getActiveDocId(), suggestedName = null) {
  flush(docId);

  const content = getDocumentContent(docId);
  const result = await window.mdforge.saveFileAs(content, suggestedName);
  if (!result) return; // user canceled the native save dialog

  // WR-05: dialog:save-file-as can now report a genuine conflict -- the
  // chosen destination has a recorded stat from earlier in this session
  // (opened, saved, or Saved-As before) AND has changed on disk since.
  // Escalate through the same Keep Mine / Reload Theirs / Save As Copy
  // dialog a normal Save conflict uses, rather than silently overwriting.
  if (result.conflict) {
    const choice = await showConflictDialog();

    if (choice === 'keep-mine') {
      const forced = await window.mdforge.saveFile(result.path, content, { force: true });
      if (forced.ok) {
        setDocumentFilePath(docId, result.path);
        setDocumentName(docId, result.path.split(/[\\/]/).pop());
        markDocumentClean(docId);
        setDocumentMissing(docId, false);
        window.mdforge.addRecentDocument(result.path);
        if (docId === getActiveDocId()) btnSave.disabled = false;
        showStatus('Saved ✓', 'saved');
      } else {
        showStatus(`Save failed: ${forced.error.message}`, 'error');
      }
    } else if (choice === 'reload-theirs') {
      // [05-REVIEW.md WR-03] `.value =` was deliberate here too -- see
      // saveFile()'s identical 'reload-theirs' branch above for the full
      // reasoning (discarded in-memory edits leave nothing meaningful to
      // preserve on the undo stack, and a non-active document's surface
      // cannot be focused for execCommand in the first place). [12-11]
      // `replaceDocumentContent` is the CM6-native carry-forward of that
      // same reasoning -- see the identical note in saveFile() above.
      //
      // [12-REVIEW.md WR-01] Same TOCTOU guard as saveFile()'s identical
      // branch above -- see that comment for the full reasoning.
      const beforeReload = getDocumentContent(docId);
      const reopened = await window.mdforge.openAtPath(result.path);
      if (reopened && !reopened.error) {
        if (getDocumentContent(docId) !== beforeReload) {
          showStatus('Reload cancelled — this document changed while reloading', 'error');
        } else {
          replaceDocumentContent(docId, reopened.text);
          if (docId === getActiveDocId()) renderMarkdown(reopened.text);
          setDocumentFilePath(docId, result.path);
          setDocumentName(docId, reopened.name);
          markDocumentClean(docId);
          setDocumentMissing(docId, false);
          window.mdforge.addRecentDocument(result.path);
          if (docId === getActiveDocId()) btnSave.disabled = false;
          showStatus('Reloaded from disk', 'saved');
        }
      } else if (reopened && reopened.error) {
        showStatus(`Could not reload file: ${reopened.error.message}`, 'error');
      }
    } else if (choice === 'save-as-copy') {
      await saveFileAs(docId);
    }
    return;
  }

  if (result.error) {
    showStatus(`Save failed: ${result.error.message}`, 'error');
    return;
  }

  setDocumentFilePath(docId, result.path);
  setDocumentName(docId, result.name);
  markDocumentClean(docId);
  setDocumentMissing(docId, false);
  window.mdforge.addRecentDocument(result.path);
  if (docId === getActiveDocId()) btnSave.disabled = false;
  showStatus('Saved ✓', 'saved');
}

// Wrapped in arrow functions, not passed directly: addEventListener calls
// its handler with the DOM Event as the first argument, which would
// otherwise be mistaken for an explicit (non-default) docId.
btnSave.addEventListener('click', () => saveFile());
btnSaveAs.addEventListener('click', () => saveFileAs());

// Single command-dispatch path (SHELL-07) -- the native Menu's Save/Save
// As/Reveal in Explorer accelerators and clicks all resolve through
// command-dispatch.js's registry, never a re-typed string literal.
// Reveal-in-Explorer is registered here (rather than a dedicated module)
// since resolveDocumentFilePath() is already defined in this file.
// dispatch() (command-dispatch.js) calls its handler with zero arguments,
// so passing saveFile/saveFileAs directly here is safe -- the default
// docId parameter resolves to the active document exactly as before.
registerCommand(COMMAND_IDS.FILE_SAVE, saveFile);
registerCommand(COMMAND_IDS.FILE_SAVE_AS, saveFileAs);
registerCommand(COMMAND_IDS.FILE_REVEAL_IN_EXPLORER, () => {
  const path = resolveDocumentFilePath(getActiveDocId());
  if (path) window.mdforge.revealInExplorer(path);
});
