// Sidebar workspace tree (Surface 1, 07-UI-SPEC.md) -- WORK-01/WORK-02.
// Self-wiring module (this codebase's established convention, matching
// tabs/tab-bar.js's own header comment): attaches its own listeners at
// import time, no central init(). This file's own scope is browsing only
// -- rendering, lazy expansion, click-to-open, and roving-tabindex keyboard
// navigation. Context-menu-driven New File/Rename/Delete is a separate
// module (07-08), which extends this same tree rather than being folded in
// here (07-07-PLAN.md's own objective).
//
// Lazy expansion is real, not cosmetic (WORK-02): a directory's children
// are requested via window.mdforge.listWorkspaceDir() only on first expand
// and cached in `childrenCache` for the rest of the session -- collapsing
// and re-expanding the same directory never re-reads the filesystem.
//
// Rows are a FLAT list of sibling `.tree-item` elements inside #tree-root
// (07-UI-SPEC.md's markup skeleton shows a depth-1 file as a direct
// sibling of its depth-0 parent directory, not a nested child node) --
// depth is expressed only via `--depth`/`data-depth`, never DOM nesting.
// This makes "remove every descendant of a collapsed directory" a single
// linear walk of `nextElementSibling`s while `data-depth` stays greater
// than the collapsed row's own depth.
import { openFileAtPath } from '../files/open.js';
// 07-08 (WORK-03): tree-edit.js is a self-wiring sibling module (context
// menu, inline rename/new-file input, F2/Delete keyboard paths) -- imported
// here for its side effects only, per that plan's own instruction. It
// exports nothing and this file imports nothing from it; the two files
// agree only on the shared `.tree-item` DOM row shape below.
import './tree-edit.js';

const sidebarEmptyEl = document.getElementById('sidebar-empty');
const treeRootEl = document.getElementById('tree-root');
const btnSidebarOpenFolder = document.getElementById('btn-sidebar-open-folder');

// Map<dirPath, {name, type}[]> -- every directory whose children have been
// read at least once this session. Never invalidated except by a fresh
// workspace:root-opened/root-closed event.
const childrenCache = new Map();
// Set<dirPath> -- directories currently expanded. Doubles as the
// stale-response guard for an in-flight listWorkspaceDir() call: if a
// directory is collapsed again before its first-expand fetch resolves, the
// path will have been removed from this set by the time the response
// arrives, and the (now-irrelevant) result is dropped.
const expandedPaths = new Set();
// Map<path, HTMLElement> -- every currently-rendered `.tree-item` row,
// keyed by its full path. Used for ArrowLeft's "move focus to parent" and
// for dropping stale entries on collapse.
const rowsByPath = new Map();

let rootPath = null;
let selectedRow = null;
let tabbableRow = null;

function joinPath(dirPath, name) {
  const sep = dirPath.includes('\\') ? '\\' : '/';
  return dirPath.endsWith(sep) ? `${dirPath}${name}` : `${dirPath}${sep}${name}`;
}

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

// Builds one `.tree-item` row exactly per 07-UI-SPEC.md's markup skeleton:
// chevron (directories only) -> icon -> name, data-path/data-depth/
// --depth/role=treeitem/aria-level, tabindex managed separately by the
// roving-tabindex helpers below.
function buildTreeItemRow(entry, depth, fullPath, parentPath) {
  const isDir = entry.type === 'dir';
  const row = document.createElement('div');
  row.className = `tree-item ${isDir ? 'dir' : 'file'}`;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.dataset.path = fullPath;
  row.dataset.depth = String(depth);
  if (parentPath) row.dataset.parentPath = parentPath;
  row.style.setProperty('--depth', String(depth));
  row.title = fullPath;
  row.tabIndex = -1;

  if (isDir) {
    row.setAttribute('aria-expanded', 'false');
    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = CHEVRON_SVG;
    row.appendChild(chevron);
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = isDir ? FOLDER_SVG : FILE_SVG;
  row.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'tree-name';
  nameEl.textContent = entry.name;
  row.appendChild(nameEl);

  return row;
}

// A non-interactive status row (Loading.../No Markdown files/error) per
// 07-UI-SPEC.md's States table -- no role=treeitem, never focusable, but
// still carries data-depth so the sibling-depth walk used by collapse and
// keyboard nav treats it correctly (collapse removes it like any other
// descendant; keyboard nav skips over it, see findAdjacentRow below).
function buildStatusRow(className, text, depth) {
  const el = document.createElement('div');
  el.className = className;
  el.dataset.depth = String(depth);
  el.style.setProperty('--depth', String(depth));
  el.textContent = text;
  return el;
}

function setTabbableRow(row) {
  if (tabbableRow && tabbableRow !== row) tabbableRow.tabIndex = -1;
  row.tabIndex = 0;
  tabbableRow = row;
}

function markSelected(row) {
  if (selectedRow && selectedRow !== row) {
    selectedRow.classList.remove('selected', 'open');
    selectedRow.removeAttribute('aria-selected');
  }
  row.classList.add('selected', 'open');
  row.setAttribute('aria-selected', 'true');
  selectedRow = row;
}

// Removes every descendant row of `row` (any element -- `.tree-item` or a
// status row -- whose data-depth is greater than row's own), which is
// exactly the set of rows a flat, depth-annotated sibling list produces for
// a subtree, since renderChildren() always inserts a directory's children
// immediately after it and depth-first.
function removeDescendantRows(row) {
  const depth = Number(row.dataset.depth);
  let next = row.nextElementSibling;
  while (next && Number(next.dataset.depth) > depth) {
    const toRemove = next;
    next = next.nextElementSibling;
    if (toRemove.dataset.path) rowsByPath.delete(toRemove.dataset.path);
    toRemove.remove();
  }
}

function collapseDirectory(row) {
  const dirPath = row.dataset.path;
  expandedPaths.delete(dirPath);
  row.classList.remove('expanded');
  row.setAttribute('aria-expanded', 'false');
  removeDescendantRows(row);
}

// Inserts `entries` as flat sibling rows immediately after `afterRow`
// (the parent directory row), one depth level deeper.
function renderChildren(afterRow, entries, parentDepth, parentPath) {
  let insertAfter = afterRow;
  for (const entry of entries) {
    const childPath = joinPath(parentPath, entry.name);
    const childRow = buildTreeItemRow(entry, parentDepth + 1, childPath, parentPath);
    insertAfter.after(childRow);
    insertAfter = childRow;
    rowsByPath.set(childPath, childRow);
  }
}

async function expandDirectory(row) {
  const dirPath = row.dataset.path;
  const depth = Number(row.dataset.depth);

  expandedPaths.add(dirPath);
  row.classList.add('expanded');
  row.setAttribute('aria-expanded', 'true');

  if (childrenCache.has(dirPath)) {
    renderChildren(row, childrenCache.get(dirPath), depth, dirPath);
    return;
  }

  const loadingRow = buildStatusRow('tree-loading', 'Loading…', depth + 1);
  row.after(loadingRow);

  const result = await window.mdforge.listWorkspaceDir(dirPath);

  // Stale-response guard: the directory may have been collapsed again (or
  // the whole workspace root closed/replaced) while this call was
  // in-flight -- drop the result rather than rendering into a row that no
  // longer represents the current tree state.
  if (!expandedPaths.has(dirPath) || !row.isConnected) {
    loadingRow.remove();
    return;
  }

  loadingRow.remove();

  if (result.error) {
    row.after(buildStatusRow('tree-dir-error', `Couldn't read this folder — ${result.error.message}.`, depth + 1));
    return;
  }

  childrenCache.set(dirPath, result.entries);

  if (result.entries.length === 0) {
    row.after(buildStatusRow('tree-dir-empty', 'No Markdown files', depth + 1));
    return;
  }

  renderChildren(row, result.entries, depth, dirPath);
}

function toggleDirectory(row) {
  if (row.classList.contains('expanded')) {
    collapseDirectory(row);
  } else {
    expandDirectory(row);
  }
}

function activateRow(row) {
  if (row.classList.contains('dir')) {
    toggleDirectory(row);
  } else {
    openFileAtPath(row.dataset.path);
    markSelected(row);
  }
}

// Skips over non-`.tree-item` rows (Loading.../No Markdown files/error) --
// they are presentational only, never a keyboard-navigation stop, per
// 07-UI-SPEC.md's States table (no role=treeitem on any of the three).
function findAdjacentRow(row, direction) {
  let sibling = direction === 1 ? row.nextElementSibling : row.previousElementSibling;
  while (sibling && !sibling.classList.contains('tree-item')) {
    sibling = direction === 1 ? sibling.nextElementSibling : sibling.previousElementSibling;
  }
  return sibling;
}

function focusRow(row) {
  setTabbableRow(row);
  row.focus();
}

treeRootEl.addEventListener('click', (event) => {
  // 07-08 (Rule 1 auto-fix): a click landing inside tree-edit.js's own
  // `.tree-rename-input` (e.g. to position the caret while renaming/typing
  // a new filename) must never re-activate the row underneath it -- without
  // this guard, clicking inside the input would re-open the file or
  // toggle-expand the directory being renamed.
  if (event.target.closest('.tree-rename-input')) return;
  const row = event.target.closest('.tree-item');
  if (!row) return;
  focusRow(row);
  activateRow(row);
});

// Interaction contract (07-UI-SPEC.md): Up/Down move focus to the
// previous/next visible row; Right expands a focused collapsed directory
// without moving focus; Left collapses a focused expanded directory
// without moving focus, OR (on a file/collapsed directory) moves focus to
// the parent directory row; Enter/Space performs the same action as a
// click. Context-menu/F2/Delete are out of this plan's scope (07-08).
treeRootEl.addEventListener('keydown', (event) => {
  // 07-08 (Rule 1 auto-fix): while tree-edit.js's inline rename/new-file
  // input is focused, ArrowLeft/ArrowRight/Enter/Space must move the text
  // caret and submit text like any other input -- without this guard, this
  // listener's own preventDefault() on those keys would swallow normal
  // text-editing behaviour inside the input.
  if (event.target.closest('.tree-rename-input')) return;
  const row = event.target.closest('.tree-item');
  if (!row) return;

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const next = findAdjacentRow(row, 1);
      if (next) focusRow(next);
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const prev = findAdjacentRow(row, -1);
      if (prev) focusRow(prev);
      break;
    }
    case 'ArrowRight': {
      event.preventDefault();
      if (row.classList.contains('dir') && !row.classList.contains('expanded')) {
        expandDirectory(row);
      }
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      if (row.classList.contains('dir') && row.classList.contains('expanded')) {
        collapseDirectory(row);
      } else {
        const parentPath = row.dataset.parentPath;
        const parentRow = parentPath ? rowsByPath.get(parentPath) : null;
        if (parentRow) focusRow(parentRow);
      }
      break;
    }
    case 'Enter':
    case ' ': {
      event.preventDefault();
      focusRow(row);
      activateRow(row);
      break;
    }
    default:
      break;
  }
});

async function renderRoot(root) {
  rootPath = root;
  childrenCache.clear();
  expandedPaths.clear();
  rowsByPath.clear();
  selectedRow = null;
  tabbableRow = null;
  treeRootEl.innerHTML = '';

  sidebarEmptyEl.classList.add('hidden');
  treeRootEl.classList.remove('hidden');

  const result = await window.mdforge.listWorkspaceDir(root);

  // The root may have been closed/replaced again while this call was
  // in-flight -- drop a response that no longer matches the current root.
  if (rootPath !== root) return;

  if (result.error) {
    treeRootEl.appendChild(buildStatusRow('tree-dir-error', `Couldn't read this folder — ${result.error.message}.`, 0));
    return;
  }

  childrenCache.set(root, result.entries);

  if (result.entries.length === 0) {
    treeRootEl.appendChild(buildStatusRow('tree-dir-empty', 'No Markdown files', 0));
    return;
  }

  let firstRow = null;
  for (const entry of result.entries) {
    const path = joinPath(root, entry.name);
    const row = buildTreeItemRow(entry, 0, path, null);
    treeRootEl.appendChild(row);
    rowsByPath.set(path, row);
    if (!firstRow) firstRow = row;
  }

  if (firstRow) setTabbableRow(firstRow);
}

function closeRoot() {
  rootPath = null;
  childrenCache.clear();
  expandedPaths.clear();
  rowsByPath.clear();
  selectedRow = null;
  tabbableRow = null;
  treeRootEl.innerHTML = '';
  treeRootEl.classList.add('hidden');
  sidebarEmptyEl.classList.remove('hidden');
}

window.mdforge.onWorkspaceRootOpened(({ root }) => renderRoot(root));
window.mdforge.onWorkspaceRootClosed(closeRoot);

btnSidebarOpenFolder.addEventListener('click', () => window.mdforge.openFolder());
