// OPEN FILE — rewritten (05-05, DOC-01/DOC-08) against documents.js's
// per-document Map instead of the single cached #md-input. openFileAtPath()
// remains the single entry point for opening a path -- used by the Open
// button, drag-drop, the .md file association, and second-instance argv,
// all of which route through this exact function unchanged.
//
// [05-05] Opening a path already open in another tab FOCUSES that existing
// tab instead of creating a duplicate (05-CONTEXT.md, locked). Opening a
// genuinely new path creates a brand-new tab via documents.js -- it never
// overwrites the currently active document in place, which is exactly why
// the old isDirtyFlag()-gated "open anyway?" prompt is removed entirely
// (threat_model T-5-06, disposition "accept"): there is no longer anything
// for it to protect against.

import { renderMarkdown } from '../markdown/render.js';
import { showStatus } from '../status.js';
import { COMMAND_IDS } from '../../shared/command-ids.js';
import { registerCommand } from '../command-dispatch.js';
import {
  createDocument,
  getDocumentIds,
  getDocument,
  getDocumentContent,
  setActiveDocId,
  setDocumentMissing,
} from '../documents.js';
import { renderTabBar } from '../tabs/tab-bar.js';

const btnOpen = document.getElementById('btn-open');
const btnSave = document.getElementById('btn-save');

// Iterates documents.js's Map looking for an already-open document whose
// filePath matches the just-opened path. `path` here always comes from a
// successful open result (never null), so a strict `===` comparison can
// never false-positive against an untitled document's `null` filePath.
function findOpenDocumentByPath(path) {
  for (const docId of getDocumentIds()) {
    if (getDocument(docId).filePath === path) return docId;
  }
  return null;
}

// Shared open-or-focus handling for a successful open result
// ({path, text, name}), used by both openFile() and openFileAtPath().
function applyOpenedFile(result) {
  // [06-08, PERS-07] Every successful open -- whether it focuses an
  // already-open tab or creates a brand-new one -- bumps this path to the
  // front of the recents list. A single call here (rather than one per
  // branch below) covers both, since both branches already know the
  // document is now open at result.path.
  window.mdforge.addRecentDocument(result.path);

  const existingDocId = findOpenDocumentByPath(result.path);

  if (existingDocId != null) {
    setActiveDocId(existingDocId);
    // WR-01 (07-REVIEW.md): the just-succeeded open() call above proves this
    // path exists on disk right now -- if the existing tab was `.missing`
    // (e.g. its file was deleted, then recreated externally), focusing it
    // here is exactly 07-UI-SPEC.md Surface 4's third documented Recovery
    // path, so clear the flag. A no-op for a document that was never
    // missing.
    setDocumentMissing(existingDocId, false);
    renderTabBar();
    // Refresh the preview to match the tab just focused -- render.js is not
    // yet per-docId-aware (05-08+ carry-forward), but this keeps the
    // preview visually correct for the one action this file controls,
    // exactly mirroring what the pre-05-05 single-document code always did
    // on every open.
    renderMarkdown(getDocumentContent(existingDocId));
    btnSave.disabled = false;
    showStatus('Already open — switched tabs', 'copied');
    return;
  }

  const docId = createDocument({ filePath: result.path, initialContent: result.text });
  setActiveDocId(docId);
  renderTabBar();
  renderMarkdown(result.text);
  btnSave.disabled = false;
  showStatus('Opened ✓', 'saved');
}

export async function openFileAtPath(path) {
  const result = await window.mdforge.openAtPath(path);
  if (!result) return;
  if (result.error) {
    // [06-08, PERS-07] `path` here is the caller-supplied path, always
    // known and in scope (drag-drop, second-instance argv, the .md file
    // association, and 06-06's Open Recent menu item all call this exact
    // function with a known path) -- exactly the case where a stale
    // recents entry needs pruning. Reported before the status message so
    // main can act on it regardless of what the renderer shows the user.
    window.mdforge.reportOpenFailure(path);
    showStatus(`Could not open file: ${result.error.message}`, 'error');
    return;
  }

  applyOpenedFile(result);
}

export async function openFile() {
  const result = await window.mdforge.openFile();
  if (!result) return; // user canceled the native open dialog
  if (result.error) {
    showStatus(`Could not open file: ${result.error.message}`, 'error');
    return;
  }

  applyOpenedFile(result);
}

btnOpen.addEventListener('click', openFile);

// Single command-dispatch path (SHELL-07) -- the native Menu's "Open..."
// accelerator (CmdOrCtrl+O) resolves to this exact handler via
// command-dispatch.js's registry, never a re-typed string literal.
registerCommand(COMMAND_IDS.FILE_OPEN, openFile);
