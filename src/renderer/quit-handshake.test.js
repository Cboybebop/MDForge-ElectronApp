// @vitest-environment jsdom
//
// Regression coverage for CR-01 (06-REVIEW.md): a rejected draft write must
// never block the before-quit handshake. This module is self-wiring
// (registers its `window.mdforge.onQueryDirtyState`/`onQuitDecisionRequest`
// callbacks at import time), so every dependency it pulls in
// (documents.js, files/save.js, status.js, drafts/draft-journal.js) is
// mocked here, and the registered callbacks are captured off the mocked
// `window.mdforge.on*` calls -- mirroring drafts-store.test.js's own
// "capture the registered handler, invoke it directly" idiom for
// ipcMain.handle.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./documents.js', () => ({
  getDocumentIds: vi.fn(() => []),
  getDocument: vi.fn(),
  isDocumentDirty: vi.fn(),
}));

vi.mock('./files/save.js', () => ({
  saveFile: vi.fn(),
  saveFileAs: vi.fn(),
}));

vi.mock('./status.js', () => ({
  showStatus: vi.fn(),
}));

vi.mock('./drafts/draft-journal.js', () => ({
  flushAllDrafts: vi.fn(),
}));

import { flushAllDrafts } from './drafts/draft-journal.js';

describe('quit-handshake.js', () => {
  let onQueryDirtyStateCallback;

  beforeEach(async () => {
    vi.resetModules();
    flushAllDrafts.mockReset();

    window.mdforge = {
      onQueryDirtyState: vi.fn((cb) => {
        onQueryDirtyStateCallback = cb;
      }),
      onQuitDecisionRequest: vi.fn(),
      sendDirtyDocuments: vi.fn(),
      sendQuitDecision: vi.fn(),
    };

    // Self-wiring module -- importing it is what registers the callback
    // above via window.mdforge.onQueryDirtyState().
    await import('./quit-handshake.js');
  });

  afterEach(() => {
    delete window.mdforge;
  });

  it('CR-01: still calls sendDirtyDocuments() even when flushAllDrafts() rejects -- the defense-in-depth try/catch', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    flushAllDrafts.mockRejectedValue(new Error('a future caller forgot to catch internally'));

    await onQueryDirtyStateCallback();

    expect(window.mdforge.sendDirtyDocuments).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('calls sendDirtyDocuments() normally when flushAllDrafts() resolves', async () => {
    flushAllDrafts.mockResolvedValue([]);

    await onQueryDirtyStateCallback();

    expect(window.mdforge.sendDirtyDocuments).toHaveBeenCalledTimes(1);
  });
});
