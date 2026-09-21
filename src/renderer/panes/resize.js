// DRAG-TO-RESIZE the split panes (SYNC-06) — ported from index.html:1241-1265
// (drag-handle mousedown/mousemove/mouseup) and 1271-1274 (#split-width input
// wiring, the other direct driver of the same resize interaction).
//
// Imports the single-owner setLeftPaneWidth from split.js (PATTERNS.md Shared
// Pattern 5) rather than re-deriving the clamped percentage locally.

import { setLeftPaneWidth } from './split.js';
import { applyPaneMode } from './pane-mode.js';

const dragHandle = document.getElementById('drag-handle');
const editorArea = document.getElementById('editor-area');
const splitWidth = document.getElementById('split-width');
const paneModeSelect = document.getElementById('pane-mode-select');

let isDragging = false;

// Ports index.html:1243-1248 exactly.
dragHandle.addEventListener('mousedown', () => {
  isDragging = true;
  dragHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none'; // prevent text selection while dragging
});

// Ports index.html:1250-1257 exactly.
document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const rect = editorArea.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  // Clamp between 20% and 80% so neither pane disappears
  const pct = Math.min(0.80, Math.max(0.20, ratio));
  setLeftPaneWidth(pct * 100);
});

// Ports index.html:1259-1265 exactly.
document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  dragHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// Ports index.html:1271-1274 exactly.
splitWidth.addEventListener('input', () => {
  setLeftPaneWidth(Number(splitWidth.value));
  applyPaneMode(paneModeSelect.value);
});
