// Pane mode switching (both/left-only/right-only) — ported from
// index.html:901-926 (`applyPaneMode`), 1267-1269 (`paneModeSelect` wiring).
//
// Imports the single-owner `setLeftPaneWidth`/`getLeftWidthPercent` from
// split.js (PATTERNS.md Shared Pattern 5) — no local `leftWidthPercent`.

import { setLeftPaneWidth, getLeftWidthPercent } from './split.js';

// [18-01, re-evaluated 2026-09-16 -- KEPT, with evidence] A hidden pane is
// collapsed to zero width, NEVER display:none.
//
// Original (v1.0 UAT) cause: the whole preview -> markdown write path went
// through execCommand('insertText'), which requires FOCUSING the markdown
// textarea -- and a display:none element cannot be focused. In preview-only
// mode the write failed silently, the sync never reached a fixed point, and
// a multi-block selection delete re-applied forever: the preview grew to
// ~196KB of duplicated text before marked's lexer died with "Maximum call
// stack size exceeded". Reproduced end to end.
//
// [16-13] That original write mechanism has since changed: production code
// now writes via dispatchAppWrite() CM6 transactions, which
// 12-VERIFICATION.md's Finding 1 proved do NOT require DOM focus to succeed
// -- the original reason for this workaround no longer applies verbatim.
// 16-13-DISPOSITIONS.md flagged this exact re-evaluation as open.
//
// Phase 18 re-evaluated it with real evidence, not assumption. Temporarily
// changed hidePane()/showPane() to plain display:none/flex, rebuilt, and ran:
//   - tests/e2e/pane-mode-sync.spec.js: 3/3 runs PASSED under display:none
//     (both guards -- layout-box-in-every-mode, preview-only-edit-reaches-
//     markdown-without-runaway-duplication -- unaffected, confirming the
//     ORIGINAL focus-dependent defect really is closed).
//   - tests/e2e/find-replace.spec.js -g "switching to pane mode": 3/3 runs
//     FAILED under display:none, each timing out at the full 30s
//     ("Worker teardown timeout of 30000ms exceeded"). Root cause confirmed
//     by reading the test itself (find-replace.spec.js line ~219): its own
//     wait condition is `document.getElementById('left-pane').style.width
//     === '0px'` -- a signal specific to THIS zero-width mechanism's own
//     `style.width = '0'` side effect. display:none never touches
//     style.width at all, so that wait condition can never resolve under it.
//   - The SAME test, re-run 3/3 against the unmodified zero-width baseline
//     (confirmed via matching rebuilt asset hash, main-DeBwdENi.js): passed
//     every time, in ~2s each -- proving the display:none failure is not a
//     pre-existing flake (contra the "possible flake" framing in
//     pre-existing-test-failures-find-replace-vitest-crash.md item 2; that
//     todo's own claim is corrected by this finding) but a real, 100%
//     reproducible regression caused specifically by this change.
//   - tests/fixtures/corpus/corpus.test.js: 61/61 passed under both builds
//     (pane-mode.js is outside the conversion core's code path either way).
//
// Decision: KEPT as zero-width-and-clipped. Per the decision rule, all 9
// evidence runs must be clean to switch to display:none; 6/9 were (the two
// pane-mode-sync guards), 3/9 were not (find-replace's Ctrl+F pane-mode
// test), so the workaround stays. The remaining reason is no longer
// "execCommand needs focus" -- it is that at least one other regression
// guard (find-replace.spec.js) is itself written against the zero-width
// mechanism's own observable side effect, not against a
// mechanism-independent "is this pane hidden" signal. Keeping the element
// laid out and focusable also remains the same "pane mode is purely
// presentational" property this comment has always described. Kept in one
// helper so a future mode cannot quietly reintroduce display:none.
function hidePane(pane) {
  pane.style.display = 'flex';
  pane.style.flex = '0 0 0';
  pane.style.width = '0';
  pane.style.minWidth = '0';
  pane.style.overflow = 'hidden';
}

function showPane(pane) {
  pane.style.display = 'flex';
  pane.style.overflow = '';
  pane.style.minWidth = '';
}

// Ports index.html:901-926 exactly.
export function applyPaneMode(mode) {
  const leftPane = document.getElementById('left-pane');
  const rightPane = document.getElementById('right-pane');
  const dragHandle = document.getElementById('drag-handle');
  const splitWidth = document.getElementById('split-width');

  if (mode === 'left') {
    showPane(leftPane);
    leftPane.style.flex = '1 1 0';
    leftPane.style.width = 'auto';
    hidePane(rightPane);
    dragHandle.style.display = 'none';
    splitWidth.disabled = true;
    return;
  }
  if (mode === 'right') {
    hidePane(leftPane);
    showPane(rightPane);
    rightPane.style.flex = '1 1 0';
    rightPane.style.width = 'auto';
    dragHandle.style.display = 'none';
    splitWidth.disabled = true;
    return;
  }

  showPane(leftPane);
  showPane(rightPane);
  dragHandle.style.display = 'block';
  splitWidth.disabled = false;
  setLeftPaneWidth(getLeftWidthPercent());
}

// Ports index.html:1267-1269 exactly.
const paneModeSelect = document.getElementById('pane-mode-select');
paneModeSelect.addEventListener('change', () => {
  applyPaneMode(paneModeSelect.value);
});
