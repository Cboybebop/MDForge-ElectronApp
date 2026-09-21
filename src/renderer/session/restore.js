// Consumes the main-process-composed restore plan (06-03's
// composeRestorePlan(), delivered via 06-04's synchronous
// window.mdforge.getRestorePlan() IPC bridge) and builds a real tab for
// every entry, in the locked recovery -> argv/association -> session order
// composeRestorePlan() already guarantees -- this module does not re-sort
// anything.
//
// Self-wiring module, matching this codebase's established convention
// (documents.js's own header comment): the whole job runs once, at module
// load, with no exported function. main.js imports this module immediately
// after documents.js (before every other renderer module import) so this
// runs before tab-bar.js's own module-load-time state assumptions and
// before any other module reads documents.js's tab set.
//
// [06-04] The preload bridge's restore-complete signal gates window.js's
// show-gate together with 'ready-to-show' (a bounded 5s timeout is the
// fallback if this is never called). This module sends that signal on
// EVERY path, including the empty-plan case and any exception thrown
// while building tabs (try/finally below) -- never only on the happy
// path, or a crash partway through the loop would leave the window
// invisible for the full 5-second timeout on every launch that hits it.
//
// [06-CONTEXT.md, D1; SUPERSEDED by 15-02 for session-restored tabs] Under
// the textarea-per-tab surface, EVERY restored/recovered tab came back with
// EMPTY undo history -- the browser-owned undo stack could not be
// serialised at all. Under the CM6 per-tab EditorState model (Phase 12) plus
// Plan 15-01's serialize/restore contract, a SESSION-restored tab (source:
// 'session', entry.history below) now genuinely carries its real undo
// history forward, when it parses and matches the current content.
// Recovered (crash-journal) and argv/association-opened tabs still come
// back with EMPTY history by construction -- recoveryEntries/argvEntries
// never set a `history` field (main/index.js), so entry.history is
// `undefined` there, which createDocument's `historyJson = null` default
// already treats as "no history."
import {
  createDocument,
  setDocumentName,
  setActiveDocId,
  setDocumentScrollTop,
  markDocumentDirty,
  getDocumentContent,
} from '../documents.js';
import { registerKnownDraftUuid } from '../drafts/draft-journal.js';
import { renderTabBar } from '../tabs/tab-bar.js';
import { renderMarkdown } from '../markdown/render.js';
import { showRecoveryBanner } from '../recovery-banner.js';
// [15-02] markRecentAppWrite(docId) covers the boot-time scrollTop-race
// defect (session-restore-scrolltop-boot-race.md): setActiveDocId()'s own
// scrollDOM.scrollTop write below, this module's OWN re-application write a
// few lines later, and any async layout-driven scroll adjustment CM6 makes
// within the grace window -- all without needing a bracket at each
// individual write site. See this call's own inline comment below and
// 15-02-PLAN.md's <source_findings> for the exact mechanism.
import { markRecentAppWrite } from '../markdown/cm-dispatch.js';

// A second, cheap, idempotent sendSync call -- main already computed this
// once at startup (06-04's boot sequencing), before createWindow ever ran.
const { plan, recoveredCount, skippedCount, corruptCount, conflictedCount } =
  window.mdforge.getRestorePlan();

if (plan.length === 0) {
  // documents.js's own conditional bootstrap tab (06-05) already covers
  // this case -- nothing for this module to build. Signal immediately so
  // window.js's show-gate resolves off the real signal, not the 5s timeout
  // fallback, for the common "nothing to restore" case.
  //
  // [06-12, Rule 1 - Bug] An empty PLAN does not mean nothing to report --
  // every draft this launch found could have been corrupt/unreadable
  // (corruptCount > 0), producing zero valid recovery entries and thus an
  // empty plan, while 06-CONTEXT.md's own locked rule ("a corrupt or
  // unreadable draft is skipped and logged, with the skipped count
  // reported in the notice") still requires the banner. The tab-building
  // branch below is genuinely skippable on an empty plan; the banner check
  // is not -- it must run unconditionally on both branches.
  if (recoveredCount > 0 || skippedCount > 0 || corruptCount > 0) {
    showRecoveryBanner({ recoveredCount, skippedCount, corruptCount, conflictedCount });
  }
  window.mdforge.signalRestoreComplete();
} else {
  try {
    let activeDocId = null;
    let firstDocId = null;
    let activeScrollTop = 0;
    let firstScrollTop = 0;

    for (const entry of plan) {
      const docId = createDocument({ filePath: entry.filePath, initialContent: entry.content, historyJson: entry.history });
      if (firstDocId === null) {
        firstDocId = docId;
        firstScrollTop = entry.scrollTop || 0;
      }

      // Untitled documents (no filePath) carry their own assigned display
      // name from the plan entry -- setDocumentName mirrors files/new.js's
      // own Untitled-naming allocation call site.
      if (!entry.filePath) setDocumentName(docId, entry.name);

      // Seeds the SAME draft uuid this entry came from, so the FIRST
      // subsequent edit reuses that exact file instead of writing a
      // duplicate draft.
      if (entry.draftUuid) registerKnownDraftUuid(docId, entry.draftUuid);

      // A recovered draft (or a session tab persisted while dirty) is
      // marked dirty exactly per the plan's own `dirty` flag -- never
      // inferred otherwise. PERS-02/ROADMAP criterion 1: a recovered
      // document stays visibly dirty, on-disk conflict or not.
      if (entry.dirty) markDocumentDirty(docId);

      // [06-10, Rule 1 - Bug] This write is a KNOWN no-op for whichever
      // entry ends up being the active tab -- see the re-application call
      // below, right after setActiveDocId(). It is still made here (rather
      // than skipped) because it is NOT a no-op for every OTHER entry:
      // documents.js's own setDocumentScrollTop() writes the live DOM
      // `surface.scrollTop` property directly, and the CSSOM View spec's
      // scrollTop setter algorithm is a no-op whenever the element has no
      // associated CSS layout box -- true for every surface here except
      // the one about to be made visible below, since createDocument()
      // always builds a fresh surface with `style.display = 'none'`.
      setDocumentScrollTop(docId, entry.scrollTop || 0);

      if (entry.active) {
        activeDocId = docId;
        activeScrollTop = entry.scrollTop || 0;
      }
    }

    // No entry carried active:true (e.g. a recovery-only plan, since
    // recoveryEntries never set it) -- default to the first tab built,
    // matching every other "no active tab specified" fallback in this
    // codebase.
    if (activeDocId === null) {
      activeDocId = firstDocId;
      activeScrollTop = firstScrollTop;
    }

    // [15-02, PERS-04 boot-race fix] Marks activeDocId as having just had an
    // app-originated write, covering: (a) setActiveDocId()'s own internal
    // `view.scrollDOM.scrollTop = activeDoc.scrollTop` write below, (b) this
    // module's own re-application write a few lines further down, and (c)
    // any async layout-driven scroll adjustment CM6 makes within the grace
    // window after the state swap -- all via the SAME wasRecentAppWrite()
    // suppression window panes/scroll-sync.js's attachLeftScrollSync
    // listener already checks, without a second bracket-style call at each
    // individual write site. Called IMMEDIATELY BEFORE setActiveDocId(),
    // per 15-02-PLAN.md's own <source_findings> on why one call here is
    // sufficient. Deliberately NOT extended into tabs/tab-bar.js's
    // activateTab() -- out of this plan's own explicit scope decision (see
    // 15-02-PLAN.md's <source_findings>); Plan 15-03's gate task reports
    // honestly whether that separate flake persists.
    markRecentAppWrite(activeDocId);
    setActiveDocId(activeDocId);
    // [06-10, Rule 1 - Bug] Re-applies the active entry's scrollTop NOW,
    // after setActiveDocId() above has flipped its surface's
    // `style.display` from 'none' to '' -- the identical write inside the
    // loop above landed on that same surface while it still had no CSS
    // layout box, and per the CSSOM View spec, `Element.scrollTop`'s setter
    // algorithm is a no-op in that state (verified empirically against a
    // real Chromium renderer during this plan's own e2e work, not assumed
    // from the spec text alone: reading `scrollTop` back immediately after
    // the loop's own write, while still hidden, reports 0, not the value
    // just assigned). Setting it again in the SAME synchronous tick as the
    // `display` flip -- no `requestAnimationFrame` needed -- is sufficient,
    // also verified empirically. Without this second write, PERS-04's
    // scroll-position restoration silently failed for the one tab a user
    // can actually see immediately after a relaunch.
    setDocumentScrollTop(activeDocId, activeScrollTop);
    renderTabBar();
    renderMarkdown(getDocumentContent(activeDocId));

    // One dismissible inline banner (06-CONTEXT.md, locked) -- shown only
    // when there is something to report; showRecoveryBanner() itself
    // no-ops on all-zero counts, but this guard avoids the call entirely
    // for the common all-session, nothing-recovered case.
    if (recoveredCount > 0 || skippedCount > 0 || corruptCount > 0) {
      showRecoveryBanner({ recoveredCount, skippedCount, corruptCount, conflictedCount });
    }
  } finally {
    // Unconditional, exactly once for this branch -- including any
    // exception thrown while building tabs above, so the show-gate is
    // never left hanging on the full 5s timeout fallback because one
    // malformed plan entry threw partway through the loop.
    window.mdforge.signalRestoreComplete();
  }
}
