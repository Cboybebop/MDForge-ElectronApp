// Reconciliation controller (WORK-04/05/06) -- turns main's watcher-
// classified events (07-05/07-06) into the renderer's own clean/dirty/
// active-scoping decision. Main tells the renderer WHAT changed (path,
// isDirectory); only the renderer knows which tab is dirty and which is
// active, so that decision belongs here, never in main.
//
// 07-UI-SPEC.md Surface 3's reuse contract (binding): this is NOT a second
// call into recovery-banner.js's showRecoveryBanner(). #external-change-
// banner is a distinct element with its own controller (this file), reusing
// only the THREE-CHOICE VOCABULARY (Keep Mine / Reload Theirs / Save As
// Copy, non-destructive default) from files/conflict-dialog.js and the
// VISUAL SHAPE (background/border/padding/font, classList.add/remove
// ('hidden'), no timer) from recovery-banner.js's own CSS values --
// recovery-banner.js's own single-button, no-timer interface has no
// parameter for three distinct action buttons with per-button click
// handlers and a focus-management requirement. See this plan's own
// SUMMARY.md for the full rationale (why the CSS in panes.css is also
// deliberately duplicated, not shared).
//
// The phase's single absolute invariant (07-CONTEXT.md, criterion 5): "A
// watcher event never closes a tab and never discards unsaved content."
// Every branch below either (a) reloads a document that was already CLEAN
// (nothing unsaved to lose), (b) shows a three-way choice and waits for the
// user to pick one, or (c) flips a purely visual `missing` flag
// (setDocumentMissing -- documents.js's own header comment: "structurally
// incapable of discarding content"). No branch here ever calls
// closeDocument() or clears `doc.dirty` without Keep Mine/Reload Theirs/
// Save As Copy having been explicitly clicked.
import {
  getDocument,
  getDocumentIdByPath,
  getDocumentIds,
  getDocumentContent,
  getActiveDocId,
  isDocumentDirty,
  markDocumentClean,
  setDocumentMissing,
  replaceDocumentContent,
} from '../documents.js';
import { renderMarkdown } from '../markdown/render.js';
import { renderTabBar } from '../tabs/tab-bar.js';
import { saveFileAs } from '../files/save.js';
import { showStatus } from '../status.js';
import { isPathInsideDir } from './path-utils.js';

const banner = document.getElementById('external-change-banner');
const bannerText = document.getElementById('external-change-banner-text');
const keepMineBtn = document.getElementById('external-change-keep-mine');
const reloadTheirsBtn = document.getElementById('external-change-reload-theirs');
const saveCopyBtn = document.getElementById('external-change-save-copy');

// docId -> true for a dirty, NOT-currently-active document whose file
// changed externally -- 07-UI-SPEC.md Surface 3's scope rule: "the conflict
// is recorded but no banner is shown until the user switches to that tab."
// Never bare-exported; checkPendingBannerForActiveDoc() below is the only
// reader/clearer.
const pendingConflicts = new Map();

// docId -> true once a vanish toast has fired for it, so a duplicate
// watcher event for the same path (e.g. a second unlink notification racing
// the first) never re-announces the same document twice.
const announcedMissing = new Set();

// Which document's conflict the banner is CURRENTLY showing, so the three
// button handlers below know which docId/path to act on -- the banner's own
// markup (07-UI-SPEC.md, copied verbatim) carries no data attribute for
// this by design.
let currentBannerDocId = null;

// Mirrors files/save.js's own `path.split(/[\\/]/).pop()` idiom -- the
// renderer has no Node `path` module available (sandboxed, no Node
// integration), so every basename derivation in this codebase does this by
// hand rather than importing one.
function basename(filePath) {
  return filePath ? filePath.split(/[\\/]/).pop() : '';
}

function hideBanner() {
  if (banner) banner.classList.add('hidden');
  currentBannerDocId = null;
}

// Shared by handleExternalChange's dirty-and-active branch and by
// checkPendingBannerForActiveDoc -- exact copy from 07-UI-SPEC.md Surface
// 3, with a real DOM .focus() on Reload Theirs (a plain <div> row, not a
// native <dialog>, so `autofocus` alone does not apply -- an explicit call
// is required, per the spec's own note).
function showBannerFor(docId) {
  const doc = getDocument(docId);
  if (!doc) return;
  currentBannerDocId = docId;
  const name = basename(doc.filePath);
  if (bannerText) bannerText.textContent = `${name} changed on disk. Your unsaved edits here are safe.`;
  if (banner) banner.classList.remove('hidden');
  if (reloadTheirsBtn) reloadTheirsBtn.focus();
}

// Shared by handleExternalChange's two "document is (now) dirty" exits --
// the initial dirty check, and the CR-01 re-check below. Both cases route
// through the identical active/background split.
function deferOrShowBanner(docId) {
  if (docId === getActiveDocId()) {
    showBannerFor(docId);
  } else {
    pendingConflicts.set(docId, true);
  }
}

/**
 * Consumes main's workspace:external-change event, {path}. No-ops for a
 * path with no open document. A CLEAN document reloads silently (nothing
 * unsaved to lose) -- never marks dirty/clean, never shows a banner. A
 * DIRTY document either shows the banner immediately (its tab is active) or
 * defers it until its tab becomes active (background), per Surface 3's
 * scope rule.
 */
export async function handleExternalChange({ path }) {
  const docId = getDocumentIdByPath(path);
  if (docId === null) return;

  if (!isDocumentDirty(docId)) {
    const result = await window.mdforge.openAtPath(path);
    // CR-01 (07-REVIEW.md): re-check dirty state AFTER the await, before the
    // destructive write below. window.mdforge.openAtPath is a real
    // renderer<->main IPC round trip; markDocumentDirty fires synchronously
    // on every native `input` event, so a keystroke landing in this exact
    // gap must never be silently discarded (criterion 5's absolute). If the
    // document became dirty while the reload was in flight, fall through to
    // the same banner path a dirty document already takes, instead of
    // overwriting the user's fresh edit with the now-stale reloaded content.
    if (isDocumentDirty(docId)) {
      deferOrShowBanner(docId);
      return;
    }
    if (result && !result.error) {
      const doc = getDocument(docId);
      // [12-11] This branch only ever runs for a document CONFIRMED clean
      // immediately above (the CR-01 dirty re-check) -- resetting undo
      // history via replaceDocumentContent is harmless by construction,
      // since nothing unsaved was ever on the stack to begin with.
      if (doc) replaceDocumentContent(docId, result.text);
      if (docId === getActiveDocId()) renderMarkdown(result.text);
      // WR-01 (07-REVIEW.md): a successful reload proves the path exists on
      // disk right now -- covers the "deleted, then recreated externally"
      // Recovery path (07-UI-SPEC.md Surface 4) for a document that was
      // clean the whole time, so no banner was ever needed. No-op for a
      // document that was never missing.
      setDocumentMissing(docId, false);
    }
    return;
  }

  deferOrShowBanner(docId);
}

/**
 * Called by tab-bar.js's activateTab() as its final statement -- shows a
 * previously-deferred background conflict's banner exactly once, at the
 * moment its tab genuinely becomes relevant, never before.
 */
export function checkPendingBannerForActiveDoc(docId) {
  if (!pendingConflicts.get(docId)) return;
  pendingConflicts.delete(docId);
  showBannerFor(docId);
}

async function onKeepMine() {
  const docId = currentBannerDocId;
  const doc = docId === null ? null : getDocument(docId);
  hideBanner();
  // Leaves surface.value and dirty state completely untouched -- only
  // advances main's recorded-stat baseline (via the new IPC bridge method,
  // Task 3) so this exact external revision is never re-flagged the next
  // time the watcher independently re-stats this path.
  if (doc && doc.filePath) await window.mdforge.acknowledgeExternalChange(doc.filePath);
}

async function onReloadTheirs() {
  const docId = currentBannerDocId;
  if (docId === null) return;
  const doc = getDocument(docId);
  if (!doc || !doc.filePath) {
    hideBanner();
    return;
  }
  // [files/save.js's own reload-theirs branches, same reasoning] `.value =`
  // was a deliberate exception to this codebase's undo-preserving-write
  // discipline: the user explicitly chose to discard their in-memory
  // edits, and this surface may be a background document that cannot be
  // focused for execCommand('insertText') in the first place. [12-11]
  // replaceDocumentContent is the CM6-native carry-forward of that same
  // reasoning (12-08-PLAN.md) -- fresh EditorState, undo reset, live only
  // if this docId happens to be active.
  //
  // [12-REVIEW.md WR-01] TOCTOU guard, mirrors handleExternalChange's own
  // CR-01 dirty re-check above: window.mdforge.openAtPath is a real IPC
  // round trip. If the user switches to this exact tab and types while it
  // is in flight, replaceDocumentContent() below would otherwise silently
  // discard those keystrokes the instant it resolves. Captures this
  // document's content before the await and re-checks it immediately
  // before the destructive write; on a mismatch, re-show the banner (the
  // conflict is not resolved -- the document just changed again) instead
  // of silently clobbering the fresh edit.
  const beforeReload = getDocumentContent(docId);
  const result = await window.mdforge.openAtPath(doc.filePath);
  if (result && !result.error) {
    if (getDocumentContent(docId) !== beforeReload) {
      showBannerFor(docId);
      return;
    }
    replaceDocumentContent(docId, result.text);
    if (docId === getActiveDocId()) renderMarkdown(result.text);
    markDocumentClean(docId);
    // WR-01 (07-REVIEW.md): mirrors the silent-reload branch above -- a
    // successful reload proves the path exists on disk right now.
    setDocumentMissing(docId, false);
  }
  hideBanner();
}

// Basename + ' (copy)' + extension, e.g. `roadmap.md` -> `roadmap (copy).md`.
function computeSiblingName(filePath) {
  const name = basename(filePath);
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return `${name} (copy)`;
  return `${name.slice(0, dotIndex)} (copy)${name.slice(dotIndex)}`;
}

async function onSaveAsCopy() {
  const docId = currentBannerDocId;
  if (docId === null) return;
  const doc = getDocument(docId);
  if (!doc) {
    hideBanner();
    return;
  }
  await saveFileAs(docId, computeSiblingName(doc.filePath));
  // Dismiss only if the save genuinely succeeded (mirrors tab-bar.js's own
  // save-outcome-check idiom) -- a cancelled native dialog or a failed
  // write must leave the banner, and the unsaved content, exactly as they
  // were.
  if (!isDocumentDirty(docId)) hideBanner();
}

if (keepMineBtn) keepMineBtn.addEventListener('click', onKeepMine);
if (reloadTheirsBtn) reloadTheirsBtn.addEventListener('click', onReloadTheirs);
if (saveCopyBtn) saveCopyBtn.addEventListener('click', onSaveAsCopy);

/**
 * Consumes main's workspace:external-vanish event, {path, isDirectory}.
 * isDirectory is treated defensively as false when missing/undefined
 * (never thrown on), though 07-05/07-06's corrected event shape always
 * supplies it explicitly on every real invocation. A single vanished file
 * marks its own open document (if any) missing; a vanished DIRECTORY
 * cascades the same flag across every open document whose path is
 * genuinely INSIDE it -- a real path-prefix check (T-7-17), never a
 * substring match, so a sibling directory sharing a name prefix (`notes2`
 * vs `notes`) is never falsely swept in.
 */
export function handleExternalVanish({ path, isDirectory } = {}) {
  const isDir = isDirectory === true;
  const missingDocIds = [];

  if (isDir) {
    for (const docId of getDocumentIds()) {
      const doc = getDocument(docId);
      if (doc && doc.filePath && isPathInsideDir(doc.filePath, path)) {
        setDocumentMissing(docId, true);
        missingDocIds.push(docId);
      }
    }
  } else {
    const docId = getDocumentIdByPath(path);
    if (docId !== null) {
      setDocumentMissing(docId, true);
      missingDocIds.push(docId);
    }
  }

  if (missingDocIds.length === 0) return;

  renderTabBar();
  for (const docId of missingDocIds) {
    if (announcedMissing.has(docId)) continue;
    announcedMissing.add(docId);
    const doc = getDocument(docId);
    const name = basename(doc && doc.filePath ? doc.filePath : path);
    showStatus(`${name} was deleted outside MD Forge — still open here.`, 'copied');
  }
}

// Self-wiring, matching this codebase's established convention. Guarded
// with optional chaining so importing this module without a stubbed
// window.mdforge (a plain jsdom test with no bridge fixture) never throws.
if (window.mdforge?.onWorkspaceFileChanged) window.mdforge.onWorkspaceFileChanged(handleExternalChange);
if (window.mdforge?.onWorkspaceFileVanished) window.mdforge.onWorkspaceFileVanished(handleExternalVanish);
