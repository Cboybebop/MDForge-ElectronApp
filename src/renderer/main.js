// Renderer entry point — ported from index.html:1277-1297 (minus the two
// deleted boot races) plus the module wiring for every self-wiring module
// built across 01-02 through 01-07.
//
// Every module below attaches its own DOM event listeners at module-load
// time (matching the original single-file script's top-level execution
// model) — no central init() call is needed for any of them. This file's
// only job is to import them all for their side effects and run the pane
// layout defaults below.
//
// 01-CONTEXT.md / 04-CONTEXT.md ("Two boot races are deleted, not ported"):
// the original index.html:1287-1289 `pageshow` listener and index.html:1297
// `setTimeout(resetDocumentState, 0)` are NOT reintroduced anywhere in this
// file (deleted in Phase 1). The synchronous `.value=''`/`renderMarkdown('')`/
// `setFileLabel('No file open')`/`btn-save.disabled=true` reset block that
// 01-08 substituted in their place is ALSO deleted here (04-04-PLAN.md) --
// it was pure redundant defensive code once the document-state module's own
// `filePath = null` initial value and index.html's static empty-textarea/
// `#empty-state`/`disabled` defaults already represent the same state.
// The File System Access API browser-capability check that used to live
// here is also deleted -- native IPC file I/O (04-02) has no capability to
// detect; Save is always available.

import './documents.js';
import './session/restore.js';
import './session/session-writer.js';
import './recovery-banner.js';
import './workspace/reconcile.js';
import './markdown/render.js';
import './markdown/back-convert.js';
import './panes/split.js';
import './panes/pane-mode.js';
import './panes/resize.js';
import './tabs/tab-bar.js';
import './workspace/tree.js';
import './workspace/sidebar-resize.js';
import './find-replace/find-bar.js';
import './preview/toolbar.js';
import './preview/events.js';
import './clipboard/word.js';
import './clipboard/confluence.js';
import './files/open.js';
import './files/new.js';
import './files/save.js';
import './files/export.js';
import './command-dispatch.js';
import './theme/theme.js';
import './files/drag-drop.js';
import './quit-handshake.js';

import { setLeftPaneWidth } from './panes/split.js';
import { applyPaneMode } from './panes/pane-mode.js';
import { isAnyDocumentDirty } from './documents.js';
import { isQuitProceeding } from './quit-handshake.js';
import { openFileAtPath } from './files/open.js';

// Ports index.html:1295-1296 exactly.
setLeftPaneWidth(50);
applyPaneMode('both');

// Ports index.html:1280-1285 exactly (the `pageshow` listener at
// index.html:1287-1289 is deliberately NOT ported — see file header).
//
// [05-08] The former single-document dirty singleton is deleted; the guard
// now blocks the native browser-level unload if ANY open document is
// dirty, not just whichever one was active when the module first loaded.
//
// [Rule 1 - Bug, found during this plan's own verification] `&&
// !isQuitProceeding()` is required, not optional. Once this guard became
// genuinely multi-document-aware, a quit that the PRIMARY handshake
// (quit-handshake.js) already confirmed -- saving the active document,
// while some OTHER, non-active document remains dirty (this handshake
// only ever saves the active one; a real Save-All loop is 05-12's scope)
// -- would otherwise hit THIS listener a second time when the window
// actually closes, and isAnyDocumentDirty() would still correctly report
// true for that other document. Without the isQuitProceeding() escape
// hatch, that reintroduces a second, redundant native "leave without
// saving?" browser dialog for a quit the user already explicitly
// confirmed through quit-handshake.js's own dialog -- observed empirically
// as a hang / `dialog.accept: No dialog is showing` protocol error once
// 2+ documents were dirty at quit time. quit-handshake.js's own header
// comment has the full account. This listener remains fully armed for any
// quit path that never goes through the primary handshake at all (e.g. an
// OS-initiated shutdown), since isQuitProceeding() stays false unless that
// handshake genuinely ran and decided to proceed.
window.addEventListener('beforeunload', e => {
  if (isAnyDocumentDirty() && !isQuitProceeding()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// SHELL-06: a second app launch routes its incoming .md path here via
// src/main/index.js's 'second-instance' handler + the preload bridge's
// onExternalOpenPath. openFileAtPath already guards unsaved changes with a
// confirm() prompt (files/open.js) -- no separate dirty-state check needed
// here.
window.mdforge.onExternalOpenPath(openFileAtPath);
