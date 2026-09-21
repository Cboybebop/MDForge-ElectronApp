// @vitest-environment jsdom
//
// Fast, deterministic unit proof that composeExportHtml() flushes the REAL
// active document before reading #preview state -- closes
// 05-VERIFICATION.md Gap 1 (the docId-threading bug class 05-REVIEW.md's
// WR-01 already fixed in clipboard/word.js and clipboard/confluence.js,
// but which was never migrated in this file). No dedicated test file
// existed for export.js before this plan (clipboard/word.js's own header
// comment already notes "No dedicated unit or test coverage exists for
// either file" -- this closes that gap for the export path specifically).
//
// markdown/sync-controller.js's flush is mocked so this test can assert on
// its call ARGUMENT directly, not merely on call count. ../documents.js's
// getActiveDocId is stubbed to a fixed non-default docId (7 -- deliberately
// not sync-controller.js's DEFAULT_DOC_ID of 1) so a regression back to the
// bare, no-argument flush() call is unambiguously distinguishable from the
// fixed call. markdown/back-convert.js's getCleanPreviewHTML is stubbed to
// return image-free HTML so embedRemoteImages() has nothing to fetch and
// this test needs no window.mdforge.fetchImageAsDataUrl stub to exercise
// that path (a real stub is still provided below for the property to
// exist, in case a future change adds an image).
//
// Confirmed to fail against the pre-fix export.js: temporarily reverting
// Task 1's fix (bare `flush()` in composeExportHtml()) makes this test's
// `toEqual([7])` assertion fail with `[]` -- flush was called with zero
// arguments -- via `git stash` against the working tree before Task 1 was
// committed. See this plan's SUMMARY for the recorded confirmation.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../markdown/sync-controller.js', () => ({
  flush: vi.fn(),
}));

vi.mock('../documents.js', () => ({
  getActiveDocId: vi.fn(() => 7),
}));

vi.mock('../markdown/back-convert.js', () => ({
  getCleanPreviewHTML: vi.fn(() => '<p>Hello, no images here.</p>'),
}));

// command-dispatch.js self-wires window.mdforge.onMenuCommand(dispatch) at
// its OWN module-load time, and export.js imports command-dispatch.js.
// export.js is imported dynamically below (mirroring
// tabs/tab-bar.test.js's established pattern) specifically so this
// assignment runs BEFORE that self-wiring import executes -- a static
// top-level `import` here would be hoisted ahead of this assignment and
// throw on `window.mdforge.onMenuCommand is not a function`.
window.mdforge = {
  onMenuCommand: vi.fn(),
  fetchImageAsDataUrl: vi.fn(),
};

let composeExportHtml;
let flush;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ composeExportHtml } = await import('./export.js'));
  ({ flush } = await import('../markdown/sync-controller.js'));
});

describe('composeExportHtml()', () => {
  it('flushes the real active document via getActiveDocId() -- never bare, never the literal default docId 1 when the active docId differs (05-VERIFICATION.md Gap 1)', async () => {
    await composeExportHtml();

    expect(flush).toHaveBeenCalledTimes(1);
    // Asserts on the exact argument LIST, not merely that flush was
    // called: [] would mean the pre-fix bare `flush()` regressed; [1]
    // would mean it fell back to DEFAULT_DOC_ID instead of the stubbed
    // active docId. Only [7] proves getActiveDocId()'s return value was
    // actually threaded through.
    expect(flush.mock.calls[0]).toEqual([7]);
  });
});
