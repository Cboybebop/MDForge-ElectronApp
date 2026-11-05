// Single owner of leftWidthPercent — ported from index.html:892-899 (`setLeftPaneWidth`).
//
// PATTERNS.md Shared Pattern 5: `leftWidthPercent` must live in exactly ONE place.
// pane-mode.js and resize.js import `setLeftPaneWidth` (and `getLeftWidthPercent`
// where the current value is needed) rather than re-deriving the percentage.
//
// DOM refs are queried inside the function body, not at module load, so this
// module works correctly when imported before the real DOM exists (tests
// construct #left-pane/#right-pane/#split-width fresh in each beforeEach).

// Persisted pane-layout state (pane mode / split / sync-scroll). The main
// process validates and owns the store (window-state.js); this just bridges
// to it. Falls back silently when window.mdforge is absent (unit tests, or a
// preload that predates these methods) so pane code never depends on it.
export function getStoredPaneState() {
  try {
    const state = window.mdforge && window.mdforge.getPaneState && window.mdforge.getPaneState();
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

export function persistPaneState(partial) {
  try {
    if (window.mdforge && window.mdforge.setPaneState) window.mdforge.setPaneState(partial);
  } catch {
    // Persistence is best-effort; never break the pane UI over it.
  }
}

const storedPaneState = getStoredPaneState();

let leftWidthPercent = storedPaneState && typeof storedPaneState.splitPercent === 'number'
  ? Math.min(80, Math.max(20, storedPaneState.splitPercent))
  : 50;

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
