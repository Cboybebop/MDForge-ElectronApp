// DRAG-AND-DROP — SHELL-08. No existing drag-and-drop handling anywhere in
// the renderer prior to this (04-PATTERNS.md "No Analog Found"); closest
// structural precedent is main.js's document-level `beforeunload` listener
// registration (attach at document/window level, self-wiring at module-load
// time, no central init() call needed).
//
// `dragover` and `drop` both call event.preventDefault() as their FIRST
// statement, unconditionally -- without that, Chromium's default behavior is
// to navigate the whole window away to the dropped file, which looks like
// the app crashing (04-CONTEXT.md).
//
// `file.path` is a real OS filesystem path Electron attaches to dropped
// `File` objects (unlike a browser sandbox, which withholds it entirely).
// This module's own `.md`/`.markdown` extension check is a UX-level
// relevance filter only, NOT the security boundary -- the authoritative
// traversal/NUL-byte validation (path-guard.js's isSafeFilePath) happens
// downstream, in main, when openFileAtPath round-trips this path through
// the file:open-path IPC handler built in 04-02. This module does not
// duplicate that guard logic itself (04-PATTERNS.md's drag-drop.js note).

import { openFileAtPath } from './open.js';
import { showStatus } from '../status.js';

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();

  const file = e.dataTransfer.files[0];
  if (!file) return;

  const droppedPath = file.path;
  if (!droppedPath || !/\.(md|markdown)$/i.test(droppedPath)) {
    showStatus('Only .md files can be opened this way', 'error');
    return;
  }

  // openFileAtPath (files/open.js) already guards unsaved changes with a
  // confirm() prompt before overwriting the buffer -- no separate
  // dirty-state check needed here.
  await openFileAtPath(droppedPath);
});
