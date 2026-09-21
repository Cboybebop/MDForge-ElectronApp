// Sidebar drag-to-resize + collapse/expand + width persistence
// (07-UI-SPEC.md Surface 1 "Structural placement"). Mirrors
// panes/resize.js's exact mousedown/mousemove/mouseup idiom -- same
// single-owner setter shape, different element and different clamp
// range: a fixed [160, 480]px window, not panes/resize.js's 20%/80%
// ratio-of-container math (the sidebar has its own pixel min/max per
// UI-SPEC, not a percentage split).
import { registerCommand } from '../command-dispatch.js';
import { COMMAND_IDS } from '../../shared/command-ids.js';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

const sidebarEl = document.getElementById('sidebar');
const resizeHandleEl = document.getElementById('sidebar-resize-handle');
const toggleBtnEl = document.getElementById('btn-toggle-sidebar');

let isDragging = false;

// The width the sidebar returns to when expanded. Tracked separately from
// the live inline width because collapsing sets that to 0 -- persisting the
// live value would overwrite the user's chosen width with zero and lose it.
let expandedWidth = MIN_WIDTH;

function clampWidth(px) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px));
}

function persistState() {
  // Always persist the EXPANDED width, never the live inline one -- while
  // collapsed the latter is 0, which would come back as MIN_WIDTH on the
  // next launch and silently discard the width the user had chosen.
  window.mdforge.setSidebarState({
    width: expandedWidth,
    collapsed: sidebarEl.classList.contains('collapsed')
  });
}

// Ports panes/resize.js's mousedown handler, substituting the sidebar's
// own resize handle/dragging class for #drag-handle's.
resizeHandleEl.addEventListener('mousedown', () => {
  isDragging = true;
  resizeHandleEl.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

// Ports panes/resize.js's mousemove handler, substituting #sidebar's own
// getBoundingClientRect() (07-UI-SPEC.md's explicit instruction: THIS
// module reads #sidebar's own rect for its drag math, not #editor-area's,
// which panes/resize.js continues to own unaffected) and a clamped pixel
// width instead of a clamped percentage-of-container ratio.
document.addEventListener('mousemove', (event) => {
  if (!isDragging) return;
  const rect = sidebarEl.getBoundingClientRect();
  const width = clampWidth(event.clientX - rect.left);
  expandedWidth = width;
  sidebarEl.style.width = `${width}px`;
});

// Ports panes/resize.js's mouseup handler; additionally persists the final
// width once the drag completes.
document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  resizeHandleEl.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  persistState();
});

// Keeps the button's icon, accessible name and tooltip in step with the
// sidebar's actual state. aria-pressed drives the icon swap in sidebar.css,
// so there is one source of truth rather than a class that could drift from
// what screen readers are told.
function reflectSidebarState() {
  const collapsed = sidebarEl.classList.contains('collapsed');
  toggleBtnEl.setAttribute('aria-pressed', String(!collapsed));
  const label = collapsed ? 'Show folder sidebar' : 'Hide folder sidebar';
  toggleBtnEl.setAttribute('aria-label', label);
  toggleBtnEl.setAttribute('data-tooltip', `${collapsed ? 'Show' : 'Hide'} sidebar (Ctrl+B)`);
}

function toggleSidebar() {
  const collapsing = !sidebarEl.classList.contains('collapsed');
  sidebarEl.classList.toggle('collapsed');

  // The inline width MUST be driven here, not left to #sidebar.collapsed's
  // `width: 0` rule. An inline style always beats a class selector, and this
  // element carries one from the drag handler and from load -- so the class
  // alone toggled nothing visible, which is exactly why the button looked
  // dead in v1.0 UAT. Found by measuring: the sidebar stayed 240px wide
  // through a full toggle cycle.
  sidebarEl.style.width = collapsing ? '0px' : `${clampWidth(expandedWidth)}px`;

  reflectSidebarState();
  persistState();
}

toggleBtnEl.addEventListener('click', toggleSidebar);

// Single command-dispatch path (SHELL-07): View > Toggle Sidebar
// (CmdOrCtrl+B) resolves through this same registry, never a second,
// parallel keydown listener for the same accelerator.
registerCommand(COMMAND_IDS.WORKSPACE_TOGGLE_SIDEBAR, toggleSidebar);

// Apply the persisted width/collapsed state on load. getSidebarState() is
// synchronous (ipcRenderer.sendSync), matching preload/index.js's own
// theme:get-initial precedent, so this resolves before first paint with no
// IPC-latency flash.
const initialState = window.mdforge.getSidebarState();
if (initialState) {
  expandedWidth = clampWidth(initialState.width);
  if (initialState.collapsed) sidebarEl.classList.add('collapsed');
  sidebarEl.style.width = initialState.collapsed ? '0px' : `${expandedWidth}px`;
  reflectSidebarState();
}
