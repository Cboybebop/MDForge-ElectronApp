// Single owner of leftWidthPercent — ported from index.html:892-899 (`setLeftPaneWidth`).
//
// PATTERNS.md Shared Pattern 5: `leftWidthPercent` must live in exactly ONE place.
// pane-mode.js and resize.js import `setLeftPaneWidth` (and `getLeftWidthPercent`
// where the current value is needed) rather than re-deriving the percentage.
//
// DOM refs are queried inside the function body, not at module load, so this
// module works correctly when imported before the real DOM exists (tests
// construct #left-pane/#right-pane/#split-width fresh in each beforeEach).

let leftWidthPercent = 50;

export function getLeftWidthPercent() {
  return leftWidthPercent;
}

// Ports index.html:892-899 exactly. Runtime `.style.width`/`.style.flex`
// assignment is CSP-exempt (UI-SPEC New Surface 3) — do not convert to a
// classList toggle.
export function setLeftPaneWidth(percent) {
  leftWidthPercent = Math.min(80, Math.max(20, percent));

  const leftPane = document.getElementById('left-pane');
  const rightPane = document.getElementById('right-pane');
  const splitWidth = document.getElementById('split-width');

  leftPane.style.flex = '0 0 auto';
  leftPane.style.width = `${leftWidthPercent}%`;
  rightPane.style.flex = '0 0 auto';
  rightPane.style.width = `${100 - leftWidthPercent}%`;
  splitWidth.value = `${Math.round(leftWidthPercent)}`;
}
