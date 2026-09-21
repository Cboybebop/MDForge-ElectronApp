// Tree file-operation surface (WORK-03, 07-UI-SPEC.md "Surface 2"): native
// context menu wiring, inline rename/new-file input with live validation,
// and the F2/Delete keyboard paths -- all converging on the SAME functions
// regardless of trigger (CONTEXT.md's locked "same code path" requirement).
//
// Self-wiring module (this codebase's established convention, matching
// tree.js's own header comment): attaches its own listeners at import time.
// Imported by workspace/tree.js for its side effects (this plan's own
// instruction) -- it does NOT import anything from tree.js, since tree.js
// exports nothing (07-07's own established convention, preserved here).
// Instead this file operates on the SAME live `.tree-item` DOM rows tree.js
// builds, using the identical data-path/data-depth/--depth/tree-name
// conventions, reached via plain DOM queries rather than a module-level
// import -- this keeps tree.js's export surface untouched while still
// letting both files agree on one row shape.
//
// T-7-01 (threat_model, carried from 07-02): every validation in this file
// is a UX convenience only. The authoritative gate is main process's
// isSafeFileName/isSafeFilePath (workspace-fileops.js, 07-02), which runs
// unconditionally inside createWorkspaceFile/renameWorkspaceEntry regardless
// of what this file already checked -- a renderer bug here can produce a
// wrong error message, never an unsafe filesystem write.
//
// T-7-12 (threat_model): a renamed or deleted OPEN file must update its tab
// in place, never close it. This file's rename/delete success paths call
// ONLY setDocumentFilePath/setDocumentName/setDocumentMissing -- closeDocument
// is never imported and never called anywhere in this file, structurally
// preventing a file operation from closing a tab as a side effect.
//
// Two narrow, necessary guards were added to tree.js's own pre-existing
// click/keydown listeners (07-08, Rule 1 auto-fix) so that clicking or
// pressing arrow keys inside THIS file's `.tree-rename-input` no longer gets
// intercepted by tree.js's row-activation/keyboard-navigation logic -- see
// tree.js's own inline comments at those two guard sites.
import { showStatus } from '../status.js';
import {
  getDocumentIdByPath,
  getDocument,
  getDocumentIds,
  setDocumentFilePath,
  setDocumentName,
  setDocumentMissing,
} from '../documents.js';
import { renderTabBar } from '../tabs/tab-bar.js';
import { isPathInsideDir } from './path-utils.js';

const sidebarEl = document.getElementById('sidebar');
const treeRootEl = document.getElementById('tree-root');

const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

// Illegal-character set per 07-UI-SPEC.md's validation table, identical to
// workspace-fileops.js's own isSafeFileName character class (this file's
// own copy, since a renderer module cannot import a main-process file).
const ILLEGAL_CHARS_RE = /[\\/<>:"|?*]/;

// Tracks the currently-open workspace root -- this module's OWN
// subscription to the same workspace:root-opened/closed events tree.js
// already listens for (ipcRenderer.on supports multiple independent
// listeners on one channel), so this file needs no export from tree.js just
// to know "what is the root path right now" for the empty-tree-space
// New File case.
let currentRootPath = null;
window.mdforge.onWorkspaceRootOpened(({ root }) => {
  currentRootPath = root;
});
window.mdforge.onWorkspaceRootClosed(() => {
  currentRootPath = null;
});

function basenameOf(fullPath) {
  return fullPath.split(/[\\/]/).pop();
}

function parentOf(fullPath) {
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const idx = fullPath.lastIndexOf(sep);
  return idx === -1 ? fullPath : fullPath.slice(0, idx);
}

function ensureMdExtension(name) {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

// SHELL-04-vocabulary reuse (07-UI-SPEC.md "Filesystem-rejected rename or
// delete"): a short, plain-language phrase derived from the errno.
function describeReason(error) {
  const code = error && error.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'the file is in use';
  return 'an unexpected error occurred';
}

function findRowByPath(targetPath) {
  for (const el of treeRootEl.querySelectorAll('.tree-item')) {
    if (el.dataset.path === targetPath) return el;
  }
  return null;
}

// Validates a raw (untrimmed) input value against 07-UI-SPEC.md's exact
// rule/copy table, checked in order: empty-after-trim, illegal characters,
// then a case-insensitive collision against `siblingNames` (computed on the
// FINAL, extension-appended name, since that is what would actually
// collide). Returns the exact error string, or null when valid.
function validateName(rawValue, siblingNames) {
  const trimmed = rawValue.trim();
  if (trimmed === '') return "File name can't be empty.";
  if (ILLEGAL_CHARS_RE.test(trimmed)) return 'File name can\'t contain \\ / : * ? " < > |.';

  const finalName = ensureMdExtension(trimmed);
  const finalLower = finalName.toLowerCase();
  if (siblingNames.some((name) => name.toLowerCase() === finalLower)) {
    return `"${finalName}" already exists in this folder.`;
  }
  return null;
}

// Reads sibling names directly from the already-rendered DOM rows sharing
// `row`'s own parent (via data-parent-path, or its absence for a top-level
// root row -- matching tree.js's own buildTreeItemRow(entry, 0, path, null)
// convention) -- this is "the already-cached directory listing tree.js
// holds" (07-08-PLAN.md's own phrasing), reached via the rendered rows
// themselves rather than tree.js's private childrenCache Map.
function getSiblingNames(row) {
  const parentAttr = row.dataset.parentPath || '';
  const names = [];
  for (const el of treeRootEl.querySelectorAll('.tree-item')) {
    if (el === row) continue;
    if ((el.dataset.parentPath || '') !== parentAttr) continue;
    const nameEl = el.querySelector('.tree-name');
    if (nameEl) names.push(nameEl.textContent);
  }
  return names;
}

// Builds a bare placeholder `.tree-item.file` row (icon + nothing else yet
// -- the inline input is appended by openInlineEditor) at `depth`, matching
// tree.js's own row shape/dataset conventions exactly so it is
// indistinguishable from a tree.js-rendered row once finalized.
function buildPlaceholderRow(depth, parentPath) {
  const row = document.createElement('div');
  row.className = 'tree-item file';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.dataset.depth = String(depth);
  if (parentPath) row.dataset.parentPath = parentPath;
  row.style.setProperty('--depth', String(depth));
  row.tabIndex = -1;

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = FILE_SVG;
  row.appendChild(icon);

  return row;
}

// Removes `row` and every descendant row (data-depth greater than row's
// own, contiguous next siblings) -- mirrors tree.js's own
// removeDescendantRows() shape for the flat-sibling-list convention, kept as
// this file's own small copy since tree.js exports nothing.
function removeRowAndDescendants(targetPath) {
  const row = findRowByPath(targetPath);
  if (!row) return;
  const depth = Number(row.dataset.depth);
  let next = row.nextElementSibling;
  while (next && Number(next.dataset.depth) > depth) {
    const toRemove = next;
    next = next.nextElementSibling;
    toRemove.remove();
  }
  row.remove();
}

// Marks every open tab whose document path is inside `dirPath` (case-
// insensitive, matching workspace-fileops.js's own case-insensitive-rename
// convention) as missing -- 07-UI-SPEC.md Surface 5's directory-delete
// behaviour row. Re-renders the tab bar once, after every affected document
// has been updated, never per-document.
//
// [WR-02, 07-REVIEW.md] isPathInsideDir is now shared with reconcile.js's
// own watcher-driven directory-vanish cascade (path-utils.js) -- the two
// cascades had independently diverged on Windows case semantics before this
// fix; one shared implementation keeps them from drifting apart again.
function markMissingUnderPath(dirPath) {
  let changed = false;
  for (const docId of getDocumentIds()) {
    const doc = getDocument(docId);
    if (!doc || typeof doc.filePath !== 'string') continue;
    if (isPathInsideDir(doc.filePath, dirPath)) {
      setDocumentMissing(docId, true);
      changed = true;
    }
  }
  if (changed) renderTabBar();
}

// The ONE function both the context menu's resulting 'delete' action and
// the Delete-key handler below call -- CONTEXT.md's locked "same code path"
// requirement. Never calls closeDocument (T-7-12): a successful delete of
// an open file marks it missing and re-renders the tab bar; the tab stays
// open, content intact.
async function performDelete(targetPath, isDirectory) {
  const result = await window.mdforge.confirmAndDeleteEntry(targetPath, isDirectory);
  if (!result || result.canceled) return;

  if (!result.ok) {
    // A trashItem failure is surfaced, never swallowed (07-08-PLAN.md's own
    // note: "a delete that silently fails is worse than one that errors").
    showStatus(`Couldn't delete "${basenameOf(targetPath)}" — ${describeReason(result.error)}.`, 'error');
    return;
  }

  if (isDirectory) {
    markMissingUnderPath(targetPath);
  } else {
    const docId = getDocumentIdByPath(targetPath);
    if (docId) {
      setDocumentMissing(docId, true);
      renderTabBar();
    }
  }

  removeRowAndDescendants(targetPath);
}

// Wires an inline `.tree-rename-input` into `row` (replacing `nameEl` for a
// rename, or being the row's sole content for a new-file placeholder),
// per 07-UI-SPEC.md's commit/cancel/validation contract. `opts` is one of:
//   {mode:'rename', originalPath, startingValue}
//   {mode:'create', parentDirPath, startingValue: ''}
function openInlineEditor(row, nameEl, opts) {
  const depth = Number(row.dataset.depth);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-rename-input';
  input.value = opts.startingValue;
  if (opts.mode === 'create') input.placeholder = 'Untitled.md';

  if (nameEl) {
    nameEl.replaceWith(input);
  } else {
    row.appendChild(input);
  }

  input.focus();
  if (opts.mode === 'rename') {
    // Base-name-only selection (Explorer/VS Code convention): the
    // extension is left un-selected so a plain overtype does not require
    // retyping it.
    const dotIndex = opts.startingValue.lastIndexOf('.');
    const end = dotIndex > 0 ? dotIndex : opts.startingValue.length;
    input.setSelectionRange(0, end);
  } else {
    input.setSelectionRange(0, 0);
  }

  let debounceTimer = null;
  let errorRow = null;
  let settled = false;

  function clearError() {
    if (errorRow) {
      errorRow.remove();
      errorRow = null;
    }
  }

  function showError(message) {
    clearError();
    errorRow = document.createElement('div');
    errorRow.className = 'tree-error-text';
    errorRow.style.setProperty('--depth', String(depth));
    errorRow.textContent = message;
    row.after(errorRow);
  }

  function runValidation() {
    const message = validateName(input.value, getSiblingNames(row));
    if (message) showError(message);
    else clearError();
    return message;
  }

  function scheduleValidation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runValidation, 150);
  }

  function detachInputListeners() {
    clearTimeout(debounceTimer);
    input.removeEventListener('input', scheduleValidation);
    input.removeEventListener('keydown', onKeydown);
    input.removeEventListener('blur', onBlur);
  }

  // Replaces the input with a normal `.tree-name` span and (for a
  // brand-new row) finishes turning the placeholder into a real tree row.
  function finalizeRow(finalName, finalPath) {
    clearError();
    const span = document.createElement('span');
    span.className = 'tree-name';
    span.textContent = finalName;
    input.replaceWith(span);
    row.dataset.path = finalPath;
    row.title = finalPath;
  }

  async function commit() {
    if (settled) return;
    const message = runValidation();
    if (message) {
      input.focus();
      return;
    }
    settled = true;
    detachInputListeners();

    const trimmed = input.value.trim();
    const finalName = ensureMdExtension(trimmed);

    if (opts.mode === 'create') {
      const result = await window.mdforge.createWorkspaceFile(opts.parentDirPath, finalName);
      if (!result.ok) {
        showStatus(`Couldn't create "${finalName}" — ${describeReason(result.error)}.`, 'error');
        row.remove();
        return;
      }
      finalizeRow(finalName, result.path);
      return;
    }

    // mode === 'rename'
    const oldPath = opts.originalPath;
    const result = await window.mdforge.renameWorkspaceEntry(oldPath, finalName);
    if (!result.ok) {
      showStatus(`Couldn't rename "${basenameOf(oldPath)}" to "${finalName}" — ${describeReason(result.error)}.`, 'error');
      finalizeRow(basenameOf(oldPath), oldPath); // revert to the original name/path
      return;
    }

    finalizeRow(finalName, result.path);

    // A renamed OPEN file relabels its tab in place -- never closeDocument
    // (T-7-12).
    const docId = getDocumentIdByPath(oldPath);
    if (docId) {
      setDocumentFilePath(docId, result.path);
      setDocumentName(docId, finalName);
      renderTabBar();
    }
  }

  function cancel() {
    if (settled) return;
    settled = true;
    detachInputListeners();
    clearError();

    if (opts.mode === 'create') {
      row.remove(); // No filesystem operation occurs.
    } else {
      finalizeRow(opts.startingValue, opts.originalPath);
    }
  }

  function onKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  // Blur commits (same as Enter) -- clicking away from an editable field is
  // not the same signal as pressing Escape (07-UI-SPEC.md's own commit/
  // cancel table).
  function onBlur() {
    void commit();
  }

  input.addEventListener('input', scheduleValidation);
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('blur', onBlur);
}

function startRename(targetPath) {
  const row = findRowByPath(targetPath);
  if (!row) return;
  const nameEl = row.querySelector('.tree-name');
  if (!nameEl) return;
  const currentName = nameEl.textContent;
  openInlineEditor(row, nameEl, { mode: 'rename', originalPath: targetPath, startingValue: currentName });
}

function startNewFile(targetPath, isDirectory) {
  const parentDirPath = isDirectory ? targetPath : parentOf(targetPath);
  const isAtRoot = parentDirPath === currentRootPath;
  const parentRow = isAtRoot ? null : findRowByPath(parentDirPath);

  // Auto-expand the parent directory first if it is collapsed (07-UI-SPEC.md
  // "New File creates inside that directory, auto-expanding it first if
  // collapsed") -- dispatched as a real DOM click so tree.js's own,
  // already-tested expandDirectory() runs unmodified; this file adds no
  // second expansion implementation.
  if (parentRow && !parentRow.classList.contains('expanded')) {
    parentRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  const depth = parentRow ? Number(parentRow.dataset.depth) + 1 : 0;
  const placeholder = buildPlaceholderRow(depth, isAtRoot ? null : parentDirPath);

  if (parentRow) {
    parentRow.after(placeholder);
  } else {
    treeRootEl.prepend(placeholder);
  }

  openInlineEditor(placeholder, null, { mode: 'create', parentDirPath, startingValue: '' });
}

window.mdforge.onWorkspaceContextAction(({ action, path: targetPath, isDirectory }) => {
  if (action === 'new-file') {
    startNewFile(targetPath, isDirectory);
  } else if (action === 'rename') {
    startRename(targetPath);
  } else if (action === 'delete') {
    void performDelete(targetPath, isDirectory);
  }
});

// Right-click on a tree row -- 07-UI-SPEC.md: "Right-click on a row: Show
// the tree context menu." stopPropagation() so the #sidebar listener below
// (the empty-tree-space case) never double-fires for the same event.
treeRootEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const row = event.target.closest('.tree-item');
  if (row) {
    window.mdforge.showTreeContextMenu(event.clientX, event.clientY, row.dataset.path, row.classList.contains('dir'), false);
  } else if (currentRootPath) {
    // [07-10, Rule 1 auto-fix] isDirectory MUST be true here -- currentRootPath
    // IS a directory (the workspace root itself), and startNewFile() below
    // branches on this flag to decide the create target: `isDirectory ?
    // targetPath : parentOf(targetPath)`. Passing false made startNewFile
    // compute parentOf(currentRootPath) -- one level ABOVE the open folder --
    // as the real create target, silently writing outside the workspace
    // root even though the placeholder row rendered (visually correctly) at
    // the tree's own top level. Caught empirically by 07-10's own e2e probe:
    // a file created via this exact path landed in the root's PARENT
    // directory on disk, not inside the opened folder.
    window.mdforge.showTreeContextMenu(event.clientX, event.clientY, currentRootPath, true, true);
  }
});

// Right-click on empty tree space below the last root item -- reaches
// #sidebar itself (rather than #tree-root) because #tree-root's own box
// only spans its rendered rows, not the sidebar's full remaining height.
sidebarEl.addEventListener('contextmenu', (event) => {
  if (!currentRootPath) return; // No folder open -- nothing to target.
  event.preventDefault();
  // [07-10, Rule 1 auto-fix] Same fix as the treeRootEl listener above --
  // currentRootPath is a directory; isDirectory must be true so
  // startNewFile() creates inside the root, not its parent.
  window.mdforge.showTreeContextMenu(event.clientX, event.clientY, currentRootPath, true, true);
});

// F2 (start rename) / Delete (open the delete confirmation) on a focused
// row -- the identical code paths the context menu's Rename/Delete items
// trigger. Skips entirely while the target is inside this file's own
// `.tree-rename-input` so editing text in the inline input is never
// intercepted as a tree command.
treeRootEl.addEventListener('keydown', (event) => {
  if (event.target.closest('.tree-rename-input')) return;
  const row = event.target.closest('.tree-item');
  if (!row) return;

  if (event.key === 'F2') {
    event.preventDefault();
    startRename(row.dataset.path);
  } else if (event.key === 'Delete') {
    event.preventDefault();
    void performDelete(row.dataset.path, row.classList.contains('dir'));
  }
});
