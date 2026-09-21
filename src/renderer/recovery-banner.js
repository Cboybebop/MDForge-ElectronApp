// Dismissible inline recovery banner (PERS-02, 06-CONTEXT.md "Crash
// Detection & Recovery UX" -- locked): "one dismissible inline banner at the
// top of the editor area, naming how many documents were recovered. Manual
// dismiss only; it never auto-hides. Not a Preferences panel, not a modal,
// and not the transient #status-badge."
//
// Presentation-only: this file imports nothing from documents.js or
// sync-controller.js. session/restore.js (a later task in this same plan) is
// the sole caller of showRecoveryBanner(), fed directly from
// window.mdforge.getRestorePlan()'s counts.
//
// formatRecoveryMessage mirrors status.js's countWords/countChars
// discipline: a pure, DOM-free function, unit-testable with no fixture.
// showRecoveryBanner/dismissRecoveryBanner mirror find-bar.js's
// showFindBar/hideFindBar `classList.add/remove('hidden')` idiom -- the
// mechanism this file copies. status.js's showStatus() debounced-timer-
// driven auto-hide (line 29) is explicitly the mechanism this file must
// NOT copy: this file arms no timer of any kind, anywhere.

/**
 * Pure formatter -- returns null when every count is zero (nothing to
 * show; callers must never display an empty banner). Otherwise returns one
 * sentence per non-zero category, space-joined:
 *   - "{n} document(s) recovered after an unexpected close." when
 *     recoveredCount > 0 (singular/plural handled properly).
 *   - "{n} skipped (unreadable)." when skippedCount + corruptCount > 0 --
 *     corrupt and unreadable-skipped drafts are combined into one count,
 *     since both represent "could not be recovered, logged" and the user
 *     has no actionable distinction between the two failure modes.
 *   - "{n} may have changed on disk since — check before saving." when
 *     conflictedCount > 0 -- surfaces 06-04's on-disk conflict detection
 *     rather than silently overwriting or silently discarding anything.
 * Deliberately never mentions undo history: restored/recovered tabs come
 * back with empty undo history (D1's accepted cost, 06-CONTEXT.md), and no
 * copy in this file may imply otherwise.
 */
export function formatRecoveryMessage({
  recoveredCount = 0,
  skippedCount = 0,
  corruptCount = 0,
  conflictedCount = 0,
} = {}) {
  if (recoveredCount === 0 && skippedCount === 0 && corruptCount === 0 && conflictedCount === 0) {
    return null;
  }

  const parts = [];

  if (recoveredCount > 0) {
    const noun = recoveredCount === 1 ? 'document' : 'documents';
    parts.push(`${recoveredCount} ${noun} recovered after an unexpected close.`);
  }

  const unreadableCount = skippedCount + corruptCount;
  if (unreadableCount > 0) {
    parts.push(`${unreadableCount} skipped (unreadable).`);
  }

  if (conflictedCount > 0) {
    parts.push(`${conflictedCount} may have changed on disk since — check before saving.`);
  }

  return parts.join(' ');
}

const banner = document.getElementById('recovery-banner');
const bannerText = document.getElementById('recovery-banner-text');
const dismissBtn = document.getElementById('recovery-banner-dismiss');

/**
 * Shows the banner with formatRecoveryMessage's own wording. Does nothing
 * (never shows an empty banner) when there is nothing to report.
 */
export function showRecoveryBanner(counts) {
  const msg = formatRecoveryMessage(counts);
  if (msg === null) return;
  if (bannerText) bannerText.textContent = msg;
  if (banner) banner.classList.remove('hidden');
}

/**
 * Manual dismiss only -- no timer anywhere in this file. 06-CONTEXT.md:
 * "Manual dismiss only; it never auto-hides."
 */
export function dismissRecoveryBanner() {
  if (banner) banner.classList.add('hidden');
}

// Self-wires the dismiss button's click listener at module load, matching
// this codebase's established self-wiring convention. Guarded so importing
// this module without the DOM fixture present (a plain jsdom test with no
// markup) does not throw.
if (dismissBtn) {
  dismissBtn.addEventListener('click', dismissRecoveryBanner);
}
