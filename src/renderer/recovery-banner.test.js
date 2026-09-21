// @vitest-environment jsdom
//
// recovery-banner.js is presentation-only (no import from documents.js or
// sync-controller.js) -- formatRecoveryMessage is pure and DOM-free
// (mirrors status.js's countWords/countChars discipline), tested directly
// with no fixture; showRecoveryBanner/dismissRecoveryBanner are tested
// against a real DOM fixture built in this file, following
// tabs/tab-bar.test.js's established `document.body.innerHTML` +
// `vi.resetModules()` + `await import(...)` idiom -- module-load-time DOM
// element caching means the fixture must exist BEFORE the module is first
// imported in each describe block.
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('recovery-banner.js', () => {
  describe('formatRecoveryMessage', () => {
    let formatRecoveryMessage;

    beforeEach(async () => {
      vi.resetModules();
      ({ formatRecoveryMessage } = await import('./recovery-banner.js'));
    });

    it('returns null when every count is zero', () => {
      expect(
        formatRecoveryMessage({ recoveredCount: 0, skippedCount: 0, corruptCount: 0, conflictedCount: 0 })
      ).toBeNull();
    });

    it('returns null when called with no argument at all', () => {
      expect(formatRecoveryMessage()).toBeNull();
    });

    it('names the recovered count, singular', () => {
      const msg = formatRecoveryMessage({
        recoveredCount: 1,
        skippedCount: 0,
        corruptCount: 0,
        conflictedCount: 0,
      });
      expect(msg).toBe('1 document recovered after an unexpected close.');
    });

    it('names the recovered count, plural', () => {
      const msg = formatRecoveryMessage({
        recoveredCount: 3,
        skippedCount: 0,
        corruptCount: 0,
        conflictedCount: 0,
      });
      expect(msg).toBe('3 documents recovered after an unexpected close.');
    });

    it('reports skipped and corrupt drafts combined, with no recovered sentence when recoveredCount is 0', () => {
      const msg = formatRecoveryMessage({
        recoveredCount: 0,
        skippedCount: 2,
        corruptCount: 1,
        conflictedCount: 0,
      });
      expect(msg).toBe('3 skipped (unreadable).');
    });

    it('reports a conflict-only count with no recovered or skipped sentence', () => {
      const msg = formatRecoveryMessage({
        recoveredCount: 0,
        skippedCount: 0,
        corruptCount: 0,
        conflictedCount: 2,
      });
      expect(msg).toBe('2 may have changed on disk since — check before saving.');
    });

    it('combines all three sentences when recovered, skipped/corrupt, and conflicted are all non-zero', () => {
      const msg = formatRecoveryMessage({
        recoveredCount: 2,
        skippedCount: 1,
        corruptCount: 1,
        conflictedCount: 1,
      });
      expect(msg).toBe(
        '2 documents recovered after an unexpected close. 2 skipped (unreadable). 1 may have changed on disk since — check before saving.'
      );
    });

    it('never implies undo history survived a restore', () => {
      const msg = formatRecoveryMessage({
        recoveredCount: 1,
        skippedCount: 0,
        corruptCount: 0,
        conflictedCount: 0,
      });
      expect(msg.toLowerCase()).not.toContain('undo');
    });
  });

  describe('showRecoveryBanner / dismissRecoveryBanner', () => {
    let showRecoveryBanner, dismissRecoveryBanner;

    beforeEach(async () => {
      vi.resetModules();
      document.body.innerHTML = `
        <div id="recovery-banner" class="hidden" role="status">
          <span id="recovery-banner-text"></span>
          <button id="recovery-banner-dismiss" type="button">Dismiss</button>
        </div>
      `;
      ({ showRecoveryBanner, dismissRecoveryBanner } = await import('./recovery-banner.js'));
    });

    it('does nothing when there is nothing to report (all-zero counts)', () => {
      showRecoveryBanner({ recoveredCount: 0, skippedCount: 0, corruptCount: 0, conflictedCount: 0 });
      expect(document.getElementById('recovery-banner').classList.contains('hidden')).toBe(true);
    });

    it('removes the hidden class and writes the formatted message when there is something to report', () => {
      showRecoveryBanner({ recoveredCount: 2, skippedCount: 0, corruptCount: 0, conflictedCount: 0 });
      const banner = document.getElementById('recovery-banner');
      expect(banner.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('recovery-banner-text').textContent).toBe(
        '2 documents recovered after an unexpected close.'
      );
    });

    it('dismissRecoveryBanner adds the hidden class back', () => {
      showRecoveryBanner({ recoveredCount: 1, skippedCount: 0, corruptCount: 0, conflictedCount: 0 });
      dismissRecoveryBanner();
      expect(document.getElementById('recovery-banner').classList.contains('hidden')).toBe(true);
    });

    it('clicking #recovery-banner-dismiss dismisses the banner (self-wired at module load)', () => {
      showRecoveryBanner({ recoveredCount: 1, skippedCount: 0, corruptCount: 0, conflictedCount: 0 });
      document.getElementById('recovery-banner-dismiss').click();
      expect(document.getElementById('recovery-banner').classList.contains('hidden')).toBe(true);
    });

    it('never arms a timer -- manual dismiss only, no auto-hide', () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      showRecoveryBanner({ recoveredCount: 1, skippedCount: 0, corruptCount: 0, conflictedCount: 0 });
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
    });
  });

  describe('module load without a DOM fixture', () => {
    it('does not throw when #recovery-banner-dismiss is absent (un-stubbed test fixture safety)', async () => {
      vi.resetModules();
      document.body.innerHTML = '';
      await expect(import('./recovery-banner.js')).resolves.toBeDefined();
    });
  });
});
