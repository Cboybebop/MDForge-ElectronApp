// Tab bar (Surface 1, 05-UI-SPEC.md) -- renders #tab-bar's children from
// documents.js's Map and wires every click/middle-click/close/keyboard-focus
// interaction the spec's Interaction contract table requires.
//
// Self-wiring module (matching this codebase's established convention --
// main.js's own header comment: every module attaches its own state/
// listeners at module-load time). No central init() call is needed: the
// event listeners below are attached once, at import time, and
// renderTabBar() is both exported (for this file's own handlers to call
// after a mutation they trigger) and invoked once at the bottom of this
// file so the bootstrap document renders as the sole tab on first launch.
//
// Deliberately NOT wired as an observer/subscribe callback off
// documents.js's markDocumentDirty/markDocumentClean (05-04-PLAN.md Task 2's
// own instruction: "Call renderTabBar() after every documents.js mutation
// THIS FILE ITSELF triggers (activate/close) -- no separate observer/
// subscribe mechanism needed"). This keeps the dependency direction
// one-way (tab-bar.js -> documents.js only, matching this plan's own
// key_links), at the cost of the dirty dot on the ACTIVE tab not
// repainting on every keystroke within this plan alone -- acceptable here
// because Surface 4's window title (05-04 Task 3) is the live-typing dirty
// signal, and tab-bar.js's own render always reads current dirty state
// whenever ITS OWN interactions (activate/close) next trigger a re-render.
import {
  getDocumentIds,
  getDocument,
  getDocumentContent,
  getActiveDocId,
  setActiveDocId,
  closeDocument,
  getActiveEditor,
  createDocument,
  markDocumentDirty,
  isDocumentDirty,
} from '../documents.js';
import { registerCommand } from '../command-dispatch.js';
import { COMMAND_IDS } from '../../shared/command-ids.js';
import { renderMarkdown } from '../markdown/render.js';
import { pushClosed, popClosed } from './closed-stack.js';
import { saveFile, saveFileAs } from '../files/save.js';
import { checkPendingBannerForActiveDoc } from '../workspace/reconcile.js';

const tabBarEl = document.getElementById('tab-bar');
const editorAreaEl = document.getElementById('editor-area');

// [05-05, Rule 3 - Blocking] Untitled-numbering (`Untitled 2`, `Untitled
// 3`, ...) was deferred to this plan by 05-04-PLAN.md Task 3's own note.
// files/new.js now allocates and persists a real per-document `name` via
// documents.js's setDocumentName() (05-UI-SPEC.md Surface 1's "allocated
// against currently-open untitled documents" rule) -- this function must
// read it back, or every untitled tab in the bar would still render the
// literal string 'Untitled' regardless of which one it actually is.
function displayName(doc) {
  if (!doc.filePath) return doc.name || 'Untitled';
  return doc.filePath.split(/[\\/]/).pop();
}

// 05-UI-SPEC.md Interaction contract: "Native title tooltip showing the
// full absolute path, plus ' — unsaved changes' when dirty. Untitled
// documents show just the display name."
//
// [07-03, WORK-06 groundwork] 07-UI-SPEC.md Surface 4 adds a `doc.missing`
// branch that REPLACES (not appends to) the existing "— unsaved changes"
// clause above -- the tooltip states the more surprising fact first
// ("file no longer found on disk"), with the dirty clause appended as its
// own trailing sentence only when both are true. A missing, clean document
// gets no "Unsaved changes." sentence at all.
function tabTooltip(doc, name) {
  if (!doc.filePath) return name;
  if (doc.missing) {
    return `${doc.filePath} — file no longer found on disk. Your content is safe here.${doc.dirty ? ' Unsaved changes.' : ''}`;
  }
  return doc.dirty ? `${doc.filePath} — unsaved changes` : doc.filePath;
}

function buildTabElement(docId, doc, activeDocId) {
  const isActive = docId === activeDocId;
  const name = displayName(doc);

  const tab = document.createElement('div');
  tab.className = ['tab', isActive ? 'active' : '', doc.dirty ? 'dirty' : '', doc.missing ? 'missing' : '']
    .filter(Boolean)
    .join(' ');
  tab.setAttribute('role', 'tab');
  tab.id = `tab-${docId}`;
  tab.dataset.docId = String(docId);
  tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  tab.setAttribute('aria-controls', 'editor-area');
  tab.setAttribute('tabindex', isActive ? '0' : '-1');
  tab.title = tabTooltip(doc, name);

  // Element order is fixed: dot -> name -> close (05-UI-SPEC.md Surface 1
  // Markup section).
  const dot = document.createElement('span');
  dot.className = 'tab-dirty';
  dot.setAttribute('aria-hidden', 'true');

  const nameEl = document.createElement('span');
  nameEl.className = 'tab-name';
  nameEl.textContent = name;

  // Known, documented ARIA deviation (05-UI-SPEC.md Surface 1 Accessibility
  // section): a focusable <button> inside role="tab", tabindex="-1" so it
  // never enters the tab sequence, mitigated by its own aria-label and by
  // Ctrl+W/middle-click as independent close paths. Do not "fix" this.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.type = 'button';
  closeBtn.tabIndex = -1;
  closeBtn.setAttribute('aria-label', `Close ${name}`);
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  tab.append(dot, nameEl, closeBtn);
  return tab;
}

// Rebuilds every .tab child from documents.js's current Map. Rebuild-whole,
// not incremental patch -- this bar never holds more than a few dozen tabs
// and matches this codebase's existing renderMarkdown()-style "rebuild from
// source of truth" convention rather than introducing a new diffing scheme.
export function renderTabBar() {
  const activeDocId = getActiveDocId();
  const ids = getDocumentIds();

  tabBarEl.innerHTML = '';
  for (const docId of ids) {
    const doc = getDocument(docId);
    if (!doc) continue; // defensive -- ids came from documents.js itself
    tabBarEl.appendChild(buildTabElement(docId, doc, activeDocId));
  }

  // 05-UI-SPEC.md Accessibility: "#editor-area gains role=tabpanel and
  // aria-labelledby pointing at the active tab's id."
  if (editorAreaEl && activeDocId != null) {
    editorAreaEl.setAttribute('aria-labelledby', `tab-${activeDocId}`);
  }
}

function scrollTabIntoView(docId) {
  const tabEl = tabBarEl.querySelector(`.tab[data-doc-id="${docId}"]`);
  if (tabEl) tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// [05-07, Rule 2 - Missing Critical] Re-renders #preview from the NOW-active
// document's own raw Markdown. 05-05-SUMMARY.md's own "Next Phase Readiness"
// flagged this exact gap: switching tabs via tab-bar.js's click/Ctrl+Tab
// handlers left #preview showing whichever document was last rendered,
// until the user typed. render.js's renderMarkdown() itself needs no change
// to fix this -- #preview is a single, shared, singleton element (never one
// per document), so its idempotence/diff bookkeeping (sync-controller.js's
// DEFAULT_DOC_ID-keyed slots, still unmigrated per-docId as of this plan)
// already tracks "the last content genuinely applied to the shared preview"
// correctly REGARDLESS of which document's keystroke or tab-switch produced
// that content -- there is exactly one writer (render.js) and exactly one
// target (#preview), so a single shared bookkeeping slot is not a latent
// bug here, just an as-yet-unmigrated implementation detail. What was
// actually missing was simply a CALL to renderMarkdown() at every point this
// file changes which document is active.
// [12-06] getActiveEditor() now returns the shared CM6 EditorView, not a
// textarea -- the old whole-document-string read becomes `state.doc.
// toString()`.
function syncPreviewToActiveDocument() {
  const editor = getActiveEditor();
  if (editor) renderMarkdown(editor.state.doc.toString());
}

// [05-07, Rule 1 - Bug; centralized per 12-REVIEW.md CR-02] Only the ACTIVE
// document's surface ever receives keyboard input (a hidden, unfocused
// <textarea> cannot fire 'input'), so at most ONE document can ever have a
// pending sync-controller debounce at the moment of a switch -- the one
// being switched AWAY from. Without a flush, that document's still-pending
// ~60-90ms scheduleFlush(...) callback (editor-events.js/back-convert.js)
// fires LATER, after the switch, and renders/writes the OUTGOING document's
// content against the INCOMING document (whichever docId getActiveDocId()
// resolves to at fire time) -- a real, observable cross-document corruption
// race, not a hypothetical one.
//
// [12-REVIEW.md CR-02] This function used to call flush(previousDocId)
// itself, here, before setActiveDocId(docId) -- but three OTHER call sites
// that perform the identical "switch which document is active" operation
// (files/new.js, both branches of files/open.js, this file's own
// reopenClosedTab() below) did not, and each was independently reachable by
// an ordinary fast typist (Ctrl+N / Ctrl+Shift+T chained into a keystroke).
// The fix moves this flush into documents.js's own setActiveDocId(), the
// single function every one of those call sites already calls -- so the
// discipline is now guaranteed for every caller, not just this one, and
// cannot be silently omitted by a future call site. This function no longer
// needs its own copy.
function activateTab(docId) {
  setActiveDocId(docId);
  renderTabBar();
  scrollTabIntoView(docId);
  syncPreviewToActiveDocument();
  // [07-09, WORK-05] Last statement, deliberately -- a background dirty
  // document's external-change conflict (recorded but never shown while
  // this tab was inactive, per 07-UI-SPEC.md Surface 3's scope rule) only
  // becomes visible now that this tab genuinely is the active one. No-op
  // when there is no pending conflict for docId.
  checkPendingBannerForActiveDoc(docId);
}

// [05-12, DOC-04] Closing a DIRTY document (X, Ctrl+W, or middle-click) now
// shows its own native Save/Don't Save/Cancel prompt (05-UI-SPEC.md
// Surface 5's derived, single-tab close requirement) before this function
// does anything else. A CLEAN document skips this entirely, unchanged from
// 05-04/05-07/05-10's existing behavior. 'cancel' aborts the close outright
// (return before any mutation -- the tab stays exactly as it was); 'save'
// runs the SAME saveFile()/saveFileAs() escalation quit-handshake.js's
// Save-All loop uses (never-saved -> real Save-As) and only continues to
// the ordinary close below if that save genuinely succeeded
// (isDocumentDirty(docId) false afterwards) -- a failed save or a
// cancelled Save-As leaves the tab open, per UI-SPEC's explicit "closes
// only on success" rule; 'dont-save' falls straight through to the
// ordinary close, discarding the edit exactly as before.
//
// [05-10, DOC-07] Every close path (X-click, middle-click, Ctrl+W) still
// routes through this one function -- so pushing the closing document onto
// closed-stack.js's depth-10 reopen stack here, BEFORE closeDocument()
// removes its Map entry and DOM node, covers Cancel-out/Don't-Save/Save
// alike. Captured here (not inside closeDocument()) because documents.js's
// own header comment establishes it as pure per-doc state with no
// knowledge of tab-bar.js's reopen-stack concern -- the capture belongs to
// the caller that decides a close is happening, exactly where
// 05-CONTEXT.md's stack entry shape ({filePath, content, dirty} -- not
// undo history) is read off the live document one last time before it
// disappears. The document is re-read fresh at that point (not the `doc`
// reference captured above) since a successful "Save" choice may have
// changed its filePath/dirty state (Save-As) in between.
async function closeTab(docId) {
  const doc = getDocument(docId);
  if (!doc) return;

  if (doc.dirty) {
    const choice = await window.mdforge.confirmCloseTab(displayName(doc));

    if (choice === 'cancel') return;

    if (choice === 'save') {
      if (doc.filePath) {
        await saveFile(docId);
      } else {
        await saveFileAs(docId);
      }
      if (isDocumentDirty(docId)) return; // save failed or Save-As was cancelled -- leave the tab open
    }
    // choice === 'dont-save' falls straight through to the ordinary close.
  }

  const finalDoc = getDocument(docId);
  if (!finalDoc) return;
  // [12-REVIEW.md CR-01 fix] `finalDoc.state` is documents.js's own Map
  // entry -- per that module's own header comment on getDocumentContent(),
  // THIS is stale for the currently-ACTIVE document: it is only refreshed by
  // setActiveDocId() when the user switches AWAY from it, never by typing.
  // Reading `finalDoc.state.doc.toString()` directly (the old, buggy read)
  // silently restored pre-edit content from the reopen-tab stack whenever
  // the closed tab was the one the user was actively looking at and typing
  // into -- the common case, and the one this stack's own "undo my close"
  // purpose exists to protect. getDocumentContent(docId) is documents.js's
  // one shared content-read primitive (12-08-PLAN.md) that already resolves
  // this exact active/background split correctly -- every other content-read
  // call site in this codebase (save.js, reconcile.js, draft-journal.js)
  // already goes through it; this was the one straggler.
  pushClosed({ filePath: finalDoc.filePath, content: getDocumentContent(docId), dirty: finalDoc.dirty });
  closeDocument(docId);
  renderTabBar();
  const activeDocId = getActiveDocId();
  if (activeDocId != null) scrollTabIntoView(activeDocId);
  // closeDocument() may have changed the active document (closing the
  // active tab activates another, or auto-creates a fresh blank one if the
  // Map became empty) -- #preview must reflect whichever document is
  // active now, exactly as activateTab() above requires.
  syncPreviewToActiveDocument();
}

// Left click on a tab activates it; left click on .tab-close closes that
// document WITHOUT also activating it (event.stopPropagation() -- 05-UI-
// SPEC.md Interaction contract).
tabBarEl.addEventListener('click', (event) => {
  const closeBtn = event.target.closest('.tab-close');
  if (closeBtn) {
    event.stopPropagation();
    const tab = closeBtn.closest('.tab');
    if (tab) closeTab(Number(tab.dataset.docId));
    return;
  }

  const tab = event.target.closest('.tab');
  if (!tab) return;
  activateTab(Number(tab.dataset.docId));
});

// Middle click anywhere on a tab closes it. auxclick fires for the middle
// button; the paired mousedown handler below preventDefault()s button 1 so
// Chromium never enters its autoscroll mode over the tab bar (05-UI-SPEC.md
// Interaction contract's explicit warning).
tabBarEl.addEventListener('mousedown', (event) => {
  if (event.button === 1) event.preventDefault();
});

tabBarEl.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  const tab = event.target.closest('.tab');
  if (!tab) return;
  closeTab(Number(tab.dataset.docId));
});

// Roving tabindex keyboard navigation: <-/-> moves DOM focus to the
// adjacent tab WITHOUT activating it; Enter/Space activates the currently
// focused tab (05-UI-SPEC.md Interaction contract).
tabBarEl.addEventListener('keydown', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const tabs = Array.from(tabBarEl.querySelectorAll('.tab'));
    const index = tabs.indexOf(tab);
    if (index === -1) return;
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activateTab(Number(tab.dataset.docId));
  }
});

// Wheel-to-horizontal: a mouse over a horizontal strip has no natural
// horizontal wheel axis (05-UI-SPEC.md Overflow behaviour affordance #2).
tabBarEl.addEventListener('wheel', (event) => {
  event.preventDefault();
  tabBarEl.scrollLeft += event.deltaY;
});

// [05-07, superseding 05-04's Rule 2 fix] Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab
// are now real native Menu accelerators (src/main/menu.js's new 'View'
// submenu, COMMAND_IDS.TAB_CLOSE/TAB_NEXT/TAB_PREV) resolved through the
// SAME single command-dispatch path every other menu command uses
// (04-CONTEXT.md "One command-dispatch path"; SHELL-07 precedent) --
// replacing 05-04's own window-level `keydown` listener for these three
// shortcuts, which pre-dated menu.js having any tab-related entries to
// route through. There is now exactly ONE handler per keystroke: the real
// OS-level accelerator table resolves Ctrl+W/Ctrl+Tab/Ctrl+Shift+Tab to
// these MenuItems' click handlers (main.js), which send 'menu:command' to
// the renderer, which dispatch()es to whichever of the three handlers below
// registerCommand() attached -- never a second, parallel renderer-level
// keydown listener for the same keys.
//
// Ctrl+Shift+T (DOC-07, reopen the most recently closed tab) remains
// unimplemented -- it requires a closed-tab stack this plan does not
// build, and DOC-07 is correctly absent from this plan's own requirements
// list (REQUIREMENTS.md marks it "Pending", not attributed to 05-07).
function switchActiveTab(delta) {
  const ids = getDocumentIds();
  if (ids.length === 0) return;
  const activeDocId = getActiveDocId();
  const index = ids.indexOf(activeDocId);
  const nextIndex = index === -1 ? 0 : (index + delta + ids.length) % ids.length;
  activateTab(ids[nextIndex]);
}

registerCommand(COMMAND_IDS.TAB_NEXT, () => switchActiveTab(1));
registerCommand(COMMAND_IDS.TAB_PREV, () => switchActiveTab(-1));
registerCommand(COMMAND_IDS.TAB_CLOSE, () => {
  const activeDocId = getActiveDocId();
  if (activeDocId != null) closeTab(activeDocId);
});

// [05-10, DOC-07] Ctrl+Shift+T: pop the most recently closed document off
// closed-stack.js's stack and reopen it as a brand-new tab, restoring its
// path/content/dirty state exactly -- never its undo history (a reopened
// document gets a brand-new <textarea> with an empty native undo buffer;
// this is 05-CONTEXT.md's explicit, accepted scope, not an omission).
// An empty stack is a silent no-op (Copywriting Contract: "an error for a
// speculative keystroke is noise") -- no new tab, no status message.
//
// [12-REVIEW.md CR-02 fix] This function's own setActiveDocId(docId) call
// below used to switch the active document WITHOUT flushing the outgoing
// document's pending sync-controller debounce first -- one of the three
// reachable cross-document corruption sites CR-02 identified. Fixed at the
// source (documents.js's setActiveDocId() itself now flushes the outgoing
// document before switching), so no change is needed in this function's own
// body; noted here so a future reader does not "fix" this by re-adding a
// local flush() call this file no longer imports.
function reopenClosedTab() {
  const entry = popClosed();
  if (!entry) return;

  const docId = createDocument({ filePath: entry.filePath, initialContent: entry.content });
  if (entry.dirty) markDocumentDirty(docId);
  setActiveDocId(docId);
  renderTabBar();
  scrollTabIntoView(docId);
  syncPreviewToActiveDocument();
}

registerCommand(COMMAND_IDS.TAB_REOPEN, reopenClosedTab);

renderTabBar();
