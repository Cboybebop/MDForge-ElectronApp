// NEW FILE — rewritten (05-05, DOC-01/DOC-08) to always create a genuinely
// new, blank, clean tab via documents.js instead of overwriting the single
// cached #md-input in place.
//
// [05-05] The old isDirtyFlag()-gated "start a new file anyway?" prompt is
// removed entirely (threat_model T-5-06, disposition "accept"): New can no
// longer discard unsaved work, since it never touches the currently active
// document -- it only ever adds a new one alongside it.

import { renderMarkdown } from '../markdown/render.js';
import { COMMAND_IDS } from '../../shared/command-ids.js';
import { registerCommand } from '../command-dispatch.js';
import { createDocument, getDocumentIds, getDocument, setActiveDocId, setDocumentName } from '../documents.js';
import { renderTabBar } from '../tabs/tab-bar.js';

const btnNew = document.getElementById('btn-new');
const btnSave = document.getElementById('btn-save');

// 05-UI-SPEC.md Surface 1 "Untitled naming": `Untitled`, then `Untitled 2`,
// `Untitled 3`, ... allocated against the CURRENTLY OPEN set of untitled
// documents -- never a monotonic counter -- so closing `Untitled 2` frees
// that exact name for the next New to reuse.
function allocateUntitledName() {
  const usedSuffixes = new Set();
  for (const docId of getDocumentIds()) {
    const doc = getDocument(docId);
    if (doc.filePath) continue; // only untitled documents compete for this name
    const existingName = doc.name || 'Untitled';
    const match = existingName.match(/^Untitled(?: (\d+))?$/);
    if (match) usedSuffixes.add(match[1] ? Number(match[1]) : 1);
  }
  let suffix = 1;
  while (usedSuffixes.has(suffix)) suffix++;
  return suffix === 1 ? 'Untitled' : `Untitled ${suffix}`;
}

export function newFile() {
  const name = allocateUntitledName();
  const docId = createDocument({ filePath: null, initialContent: '' });
  setDocumentName(docId, name);
  setActiveDocId(docId);
  renderTabBar();
  // Refresh the preview to match the blank tab just activated -- mirrors
  // exactly what the pre-05-05 single-document code always did on every
  // New (render.js is not yet per-docId-aware; see files/open.js's own
  // comment on this same carry-forward).
  renderMarkdown('');
  btnSave.disabled = true;
}

btnNew.addEventListener('click', newFile);

// Single command-dispatch path (SHELL-07) -- the native Menu's "New"
// accelerator (CmdOrCtrl+N) resolves to this exact handler via
// command-dispatch.js's registry, never a re-typed string literal.
registerCommand(COMMAND_IDS.FILE_NEW, newFile);
