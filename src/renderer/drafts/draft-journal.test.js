// @vitest-environment jsdom
//
// draft-journal.js's own module state is a bare Map (docId -> timer/uuid),
// not documents.js's real Map -- getDocument/flush are mocked here so this
// suite can control exactly what "the current document" looks like per
// test, without needing a full documents.js DOM fixture. `vi.useFakeTimers()`
// is mandatory: a real 2-second setTimeout must never be armed and left
// pending past this test file's own lifetime.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../documents.js', () => ({
  getDocument: vi.fn(),
  getDocumentContent: vi.fn(),
}));

vi.mock('../markdown/sync-controller.js', () => ({
  flush: vi.fn(),
}));

vi.mock('../status.js', () => ({
  showStatus: vi.fn(),
}));

import { getDocument, getDocumentContent } from '../documents.js';
import { flush } from '../markdown/sync-controller.js';
import { showStatus } from '../status.js';
import {
  scheduleDraftWrite,
  flushDraftNow,
  flushAllDrafts,
  cancelDraftFlush,
  deleteDraftForDoc,
  registerKnownDraftUuid,
  getKnownDraftUuid,
} from './draft-journal.js';

// [12-12] `doc.dirty`/`doc.filePath`/`doc.name` still come off getDocument()'s
// mocked record (untouched by this plan's migration) -- only the document's
// CONTENT now comes from getDocumentContent(docId), a separate mocked
// primitive, matching documents.js's own real split between the two.
function dirtyDoc(overrides = {}) {
  return {
    dirty: true,
    filePath: null,
    name: 'Untitled',
    ...overrides,
  };
}

describe('draft-journal.js', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getDocument.mockReset();
    getDocumentContent.mockReset();
    getDocumentContent.mockReturnValue('hello world');
    flush.mockReset();
    showStatus.mockReset();
    window.mdforge = {
      writeDraft: vi.fn().mockResolvedValue({ uuid: 'x' }),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.mdforge;
  });

  describe('scheduleDraftWrite', () => {
    it('never arms a timer when window.mdforge.writeDraft is absent', () => {
      delete window.mdforge;
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      scheduleDraftWrite(1);

      expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it('arms a debounced flush that calls writeDraft after DRAFT_DEBOUNCE_MS', async () => {
      getDocument.mockReturnValue(dirtyDoc());

      scheduleDraftWrite(1);
      expect(window.mdforge.writeDraft).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);

      expect(flush).toHaveBeenCalledWith(1);
      expect(window.mdforge.writeDraft).toHaveBeenCalledWith(null, 'hello world', {
        filePath: null,
        name: 'Untitled',
      });
    });

    it('clears any existing pending timer before arming a new one', () => {
      getDocument.mockReturnValue(dirtyDoc());
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      scheduleDraftWrite(1);
      scheduleDraftWrite(1);

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe('flushDraftNow', () => {
    it('is exported directly (not merely the debounce timer callback)', () => {
      expect(typeof flushDraftNow).toBe('function');
    });

    it('on a CLEAN document is a no-op that never calls window.mdforge.writeDraft', () => {
      getDocument.mockReturnValue(dirtyDoc({ dirty: false }));

      flushDraftNow(1);

      expect(window.mdforge.writeDraft).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
    });

    it('on a document that no longer exists is a no-op', () => {
      getDocument.mockReturnValue(undefined);

      expect(() => flushDraftNow(1)).not.toThrow();
      expect(window.mdforge.writeDraft).not.toHaveBeenCalled();
    });

    it('flushes the sync-controller pending debounce BEFORE reading the document content via getDocumentContent', () => {
      getDocument.mockReturnValue(dirtyDoc());
      const callOrder = [];
      flush.mockImplementation(() => {
        callOrder.push('flush');
      });
      getDocumentContent.mockImplementation(() => {
        callOrder.push('getDocumentContent');
        return 'hello world';
      });

      flushDraftNow(1);

      expect(callOrder).toEqual(['flush', 'getDocumentContent']);
      expect(window.mdforge.writeDraft).toHaveBeenCalled();
    });

    it('reuses a previously-known uuid on a subsequent write for the same docId', async () => {
      getDocument.mockReturnValue(dirtyDoc());
      registerKnownDraftUuid(2, 'known-uuid');

      flushDraftNow(2);

      expect(window.mdforge.writeDraft).toHaveBeenCalledWith(
        'known-uuid',
        'hello world',
        expect.objectContaining({ filePath: null })
      );
    });

    it('stores the uuid main returns for use by a later write', async () => {
      getDocument.mockReturnValue(dirtyDoc());
      window.mdforge.writeDraft.mockResolvedValue({ uuid: 'fresh-uuid' });

      flushDraftNow(3);
      await Promise.resolve();
      await Promise.resolve();

      expect(getKnownDraftUuid(3)).toBe('fresh-uuid');
    });

    it('CR-01: a REJECTED write resolves (never rejects) the returned promise, logs it, and surfaces it via showStatus', async () => {
      getDocument.mockReturnValue(dirtyDoc({ filePath: 'C:\\docs\\report.md' }));
      const writeError = new Error('ENOSPC: no space left on device');
      window.mdforge.writeDraft.mockRejectedValue(writeError);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(flushDraftNow(4)).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(showStatus).toHaveBeenCalledWith(
        expect.stringContaining('report.md'),
        'error',
        expect.any(Number)
      );
      consoleErrorSpy.mockRestore();
    });

    it('CR-01: a rejected write does not leave a stale uuid registered for a later write', async () => {
      getDocument.mockReturnValue(dirtyDoc());
      window.mdforge.writeDraft.mockRejectedValue(new Error('EBUSY'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await flushDraftNow(5);

      expect(getKnownDraftUuid(5)).toBeUndefined();
    });
  });

  describe('flushAllDrafts', () => {
    it('flushes every currently-pending docId exactly once', () => {
      getDocument.mockReturnValue(dirtyDoc());
      scheduleDraftWrite(10);
      scheduleDraftWrite(11);

      flushAllDrafts();

      expect(window.mdforge.writeDraft).toHaveBeenCalledTimes(2);
    });

    it('is safe to call when nothing is pending', () => {
      expect(() => flushAllDrafts()).not.toThrow();
    });

    it('CR-01: resolves even when ONE of several pending writes rejects -- a single failed write must never block the whole quit handshake', async () => {
      getDocument.mockImplementation((docId) => dirtyDoc({ filePath: `C:\\docs\\doc-${docId}.md` }));
      window.mdforge.writeDraft.mockImplementation((uuid, content, meta) => {
        if (meta.filePath.includes('doc-21')) return Promise.reject(new Error('EACCES'));
        return Promise.resolve({ uuid: 'ok-uuid' });
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      scheduleDraftWrite(20);
      scheduleDraftWrite(21);

      await expect(flushAllDrafts()).resolves.toEqual([undefined, undefined]);
    });
  });

  describe('cancelDraftFlush', () => {
    it('cancels a pending timer WITHOUT invoking it', async () => {
      getDocument.mockReturnValue(dirtyDoc());
      scheduleDraftWrite(20);

      cancelDraftFlush(20);
      await vi.advanceTimersByTimeAsync(5000);

      expect(window.mdforge.writeDraft).not.toHaveBeenCalled();
    });
  });

  describe('deleteDraftForDoc', () => {
    it('never calls window.mdforge.deleteDraft for a docId with no known uuid', () => {
      deleteDraftForDoc(999);

      expect(window.mdforge.deleteDraft).not.toHaveBeenCalled();
    });

    it('deletes a known draft and clears its uuid (idempotent on a second call)', () => {
      registerKnownDraftUuid(30, 'uuid-30');

      deleteDraftForDoc(30);
      expect(window.mdforge.deleteDraft).toHaveBeenCalledWith('uuid-30');

      deleteDraftForDoc(30);
      expect(window.mdforge.deleteDraft).toHaveBeenCalledTimes(1);
    });

    it('WR-03: a delete requested WHILE a write is still in flight is chained to run once that write lands, using whatever uuid it registers -- no orphaned draft', async () => {
      getDocument.mockReturnValue(dirtyDoc());
      let resolveWrite;
      window.mdforge.writeDraft.mockReturnValue(
        new Promise((resolve) => {
          resolveWrite = resolve;
        })
      );

      // Start the write, but do NOT let it resolve yet -- simulates the
      // debounce timer (or an immediate-flush trigger) having just fired
      // moments before a concurrent save-success/close-with-discard calls
      // markDocumentClean()/closeDocument().
      const flushPromise = flushDraftNow(50);
      expect(window.mdforge.deleteDraft).not.toHaveBeenCalled();

      // The document becomes clean WHILE the write above is still
      // in-flight -- cancelDraftFlush() (called by the real
      // markDocumentClean()/closeDocument(), not exercised directly by
      // this unit test) cannot reach an already-started write; only
      // deleteDraftForDoc()'s own in-flight-aware branch can.
      deleteDraftForDoc(50);
      expect(window.mdforge.deleteDraft).not.toHaveBeenCalled(); // not yet -- still in flight

      // The write finally lands, registering its uuid.
      resolveWrite({ uuid: 'landed-after-clean' });
      // Wait for flushDraftNow's own internal .then/.catch/.finally chain
      // to fully settle, THEN one more microtask tick for
      // deleteDraftForDoc's own externally-chained .then() (attached to
      // that same settled promise) to run.
      await flushPromise;
      await Promise.resolve();

      expect(window.mdforge.deleteDraft).toHaveBeenCalledWith('landed-after-clean');
      expect(getKnownDraftUuid(50)).toBeUndefined();
    });

    it('WR-03: a delete requested while a write is in flight, where that write ultimately fails, deletes nothing (no uuid was ever registered)', async () => {
      getDocument.mockReturnValue(dirtyDoc());
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let rejectWrite;
      window.mdforge.writeDraft.mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        })
      );

      const flushPromise = flushDraftNow(51);
      deleteDraftForDoc(51);

      rejectWrite(new Error('ENOSPC'));
      await flushPromise;
      await Promise.resolve();

      expect(window.mdforge.deleteDraft).not.toHaveBeenCalled();
    });
  });

  describe('registerKnownDraftUuid / getKnownDraftUuid', () => {
    it('round-trips a uuid for a docId', () => {
      registerKnownDraftUuid(40, 'round-trip-uuid');
      expect(getKnownDraftUuid(40)).toBe('round-trip-uuid');
    });
  });
});
