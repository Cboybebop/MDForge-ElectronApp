// BACK-CONVERSION: Right -> Left -- rewritten per 03-04-PLAN.md (Task 1).
//
// The header's former "READ BUT DO NOT MODIFY BEHAVIOR" instruction (01/02-
// era) explicitly EXPIRED this phase (03-CONTEXT.md "Files This Phase
// Rewrites"). Both flagged lines from the old 34-line version are gone:
// the whole-document `turndown.turndown(getCleanPreviewHTML())` call, and
// the undo-destroying `mdInput.value = md` assignment.
//
// `syncPreviewBlockToMarkdown(origin)` is the new primary entry point --
// used by both ordinary preview typing (`preview/events.js`, origin
// 'user-right') and format.js's toolbar commands (origin 'toolbar'). It is
// RANGE-BASED, not positionally-indexed: it locates the smallest source
// range that is provably affected by resolving the current selection's
// top-level #preview children, then searching outward BY CONTENT (via
// turndownBlock(), never htmlToMarkdown()) for the nearest verifiably
// unchanged block on each side. This subsumes ordinary typing (N->N, one
// block), a toolbar command spanning one or more blocks (N->N), Enter
// splitting a paragraph (1->2), Backspace joining two (2->1), and a toolbar
// list conversion (N->M) as exactly the same operation -- no block-count
// special-casing, which is precisely the defect two plan-review rounds
// closed (03-CONTEXT.md "Planning-Time Amendments").
//
// `syncPreviewToMarkdown(origin)` -- the OLD exported name -- survives, but
// only for a genuinely unresolvable selection (Step 1's sole fallback
// trigger below) and for 03-05's paste/Ctrl+Shift+V round trip. It has NO
// default `origin` value so an accidental un-tagged call cannot slip
// through silently.

import { turndownBlock } from './turndown-block.js';
import { spliceByRange } from './splice.js';
import { renderWithSourceMap } from './source-map.js';
import { htmlToMarkdown, markdownToHtml } from './convert.js';
import { computeShiftedOffset } from './caret-math.js';
import {
  getDocumentBody,
  setDocumentBody,
  getDocumentBlocks,
  setDocumentBlocks,
  getFrontMatter,
  setFrontMatter,
  recordApplied,
  scheduleFlush,
} from './sync-controller.js';
// [12-05] The imported dispatch helper below is now the SOLE write mechanism
// for both sync directions below -- it owns beginWrite/endWrite internally
// (cm-dispatch.js), so this file no longer imports or calls them directly.
// The two former #preview-selection-preserving helper calls that used to
// bracket the old write are gone too: that helper never focuses the CM6
// view, so #preview's own focus/selection is never disturbed by a write
// here -- the entire reason those two calls used to exist at this call site.
import { dispatchAppWrite } from './cm-dispatch.js';
// 05-03: both sync functions must resolve the ACTIVE document's surface and
// docId at the point of use, never a fixed element/id cached at module scope
// -- the active document can change between calls (05-CONTEXT.md/
// 05-PATTERNS.md; threat T-5-03).
//
// [05-08] markDirty() (the former single-document dirty singleton) is
// replaced outright by markDocumentDirty(docId) -- documents.js is now the
// SOLE dirty-tracking mechanism.
import { getActiveEditor, getActiveDocId, markDocumentDirty } from '../documents.js';

// [13-01] Retry delay for a debounced splice write that finds the target
// view mid-IME-composition (view.composing) at the moment it would
// otherwise dispatch. 50ms is short relative to a real composition session
// (unbounded, typically hundreds of ms to seconds) so the retry loop
// re-checks frequently without meaningfully delaying the eventual write
// once composition ends, and short relative to CONVERT_DEBOUNCE_MS (90ms,
// preview/events.js) so it does not itself become a new, separately-tunable
// debounce window.
const COMPOSITION_RETRY_MS = 50;

// Walks up from `node` to the nearest ancestor that is a direct, top-level
// child of `preview`. Returns null if that never happens (node resolves to
// `preview` itself, a detached node, or `document.body`/higher) -- exactly
// the "genuinely unresolvable" condition Step 1 below treats as the sole
// trigger for the whole-document fallback.
function resolveTopLevelChild(node, preview) {
  if (!node) return null;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el.parentElement !== preview) {
    el = el.parentElement;
  }
  return el && el.parentElement === preview ? el : null;
}

// [Rule 1 - Bug, discovered this task] renderWithSourceMap()'s `blocks`
// array has a SECOND non-visual token type beyond `'space'`: a top-level
// `'def'` token (a link-reference definition line, e.g. `[ref]: url`)
// renders NO DOM element either -- marked resolves the reference into the
// PARAGRAPH that uses it, and the definition line itself contributes empty
// output. render.js's (03-03) `toRenderable()` filtered only `'space'`,
// which silently mis-indexes every block-index correspondence for any
// document containing a reference-style link definition (verified directly
// against marked 18.0.9's token stream). This predicate is shared by both
// sync directions so the DOM-correspondence rule stays IDENTICAL on both
// sides, per 03-04-PLAN.md's explicit instruction that an inconsistency
// here would desync the panes -- see render.js's `toRenderable()`, updated
// to use this same predicate.
function isRenderableBlockType(block) {
  return block.type !== 'space' && block.type !== 'def';
}

// [Rule 1 - Bug, discovered by 03-06-PLAN.md's caret-stationary e2e spec
// against a REALISTIC, hand-wrapped 200-line fixture] Every "is this
// candidate block unchanged?" comparison below pits `turndownBlock()`'s
// output (always single-line: the round trip through HTML collapses a
// soft line-wrap to one space, since HTML has no notion of a Markdown
// source's internal line breaks within a paragraph) against a RAW slice of
// `body` (which preserves whatever line-wrapping the user's own Markdown
// source happens to use -- extremely common hand-authoring style, e.g.
// this repo's own README/docs/ARCHITECTURE.md, and tests/fixtures/sync/200-line-doc.md).
// For ANY multi-line-wrapped candidate, `turndownBlock(currentChildren[i])`
// (single-line) can never equal `body.slice(candidate.srcStart,
// candidate.srcEnd)` (multi-line) even when the block is genuinely
// unedited -- the search then walks PAST every such candidate, sweeping
// unrelated, untouched neighbouring paragraphs into the "affected" splice
// region and silently collapsing their line wraps on write (T-3-09,
// verified via a real Enter-triggered edit whose immediately-following,
// untouched paragraph came back space-joined instead of byte-identical).
// The fix: normalise BOTH sides of every comparison in this file through
// the SAME round trip (`markdownToHtml` -> `htmlToMarkdown`) before
// comparing, so a genuinely-unedited candidate always compares equal to
// itself regardless of its own source-level line-wrapping. This operates
// on one block's slice at a time (a few hundred characters at most), never
// the whole document, so it stays in turndownBlock()'s cost class per
// 03-RESEARCH.md Pitfall 3 -- it does not reintroduce the whole-document
// `htmlToMarkdown()` cost this file's design otherwise avoids.
//
// [Rule 1 - Bug, discovered by 03-REVIEW.md CR-01] Parsing `mdSlice` alone
// breaks for any construct whose correct rendering depends on content
// OUTSIDE its own source range. The concrete, already-present case is a
// reference-style link (`[text][ref]`): its definition (`[ref]: url`)
// tokenises as a `'def'` block with no DOM element (isRenderableBlockType
// filters it out above), so it is never itself a candidate here -- but a
// paragraph that USES that reference is. When the full document rendered,
// marked resolved the reference against the definition living elsewhere in
// the document, producing an inline `<a href>` (accepted-normalisations.md
// #1); parsed here alone, with no definition in sight, marked can't resolve
// it and the literal brackets survive. That made a genuinely-unedited
// reference-using paragraph compare unequal to itself, get swept into the
// splice as "changed", and get silently rewritten from reference-link
// spelling to inline spelling -- exactly the silent-content-mutation class
// this file exists to eliminate.
//
// Fix: give this one block's slice the document's reference definitions as
// context, without re-parsing the whole document. `contextDefsText` is the
// caller's PRE-COLLECTED (once per syncPreviewBlockToMarkdown call, not per
// comparison) concatenation of every `'def'` block's raw source text.
// Appending it after `mdSlice` lets marked's lexer resolve the reference --
// marked collects all link/image reference definitions from its ENTIRE
// input before resolving inline references, so definition order relative to
// usage doesn't matter -- while a `'def'` line itself renders no visible
// output, so appending it never changes the comparison's rendered content.
// This stays in the cheap turndownBlock()-adjacent cost class: the appended
// text is at most a handful of one-line definitions, not the document.
//
// List tightness across a block boundary (Accepted Limitation #3) is a
// separate, already-documented gap this fix does not attempt to close --
// it depends on adjacent BLOCK content, not a document-wide out-of-band
// definition table, and closing it would require the full-body re-parse
// this design deliberately avoids.
function normalisedForm(mdSlice, contextDefsText = '') {
  const composite = contextDefsText ? `${mdSlice}\n\n${contextDefsText}` : mdSlice;
  const { html } = markdownToHtml(composite);
  return htmlToMarkdown(html, '');
}

// The range-based splice write. See 03-04-PLAN.md Task 1's <behavior> for
// the full derivation this implements step-by-step; comments below mirror
// that step numbering so the two can be read side by side.
export function syncPreviewBlockToMarkdown(origin = 'user-right') {
  // Resolved fresh here, inside the function body, every call -- never
  // cached at module scope (05-03; T-5-03).
  const docId = getActiveDocId();
  // [13-01] Hoisted from just before this function's own dispatchAppWrite()
  // call (its former position) to immediately here, so the composing guard
  // below can read it before ANY other work in this function runs --
  // including before getDocumentBody()/getDocumentBlocks() are read.
  // render.js's setDocumentBody()/setDocumentBlocks() refresh (via the raw
  // pane's own render pass) is itself deferred until composition ends
  // (editor-events.js's leftGate), so that bookkeeping is stale, by design,
  // for exactly as long as composition is open -- deferring only the final
  // dispatch and still reading stale bookkeeping here would silently
  // compute a splice against out-of-date data. Deferring the WHOLE function
  // call (via the retry below) instead means the retry re-reads fresh
  // bookkeeping once composition's own render pass has caught up.
  const view = getActiveEditor();
  if (view.composing) {
    scheduleFlush('left', () => syncPreviewBlockToMarkdown(origin), COMPOSITION_RETRY_MS, docId);
    return;
  }
  const preview = document.getElementById('preview');
  const currentChildren = Array.from(preview.children);
  const selection = window.getSelection();

  // --- Step 1: resolve the edit's DOM boundary. ---
  const anchorEl =
    selection && selection.rangeCount > 0
      ? resolveTopLevelChild(selection.anchorNode, preview)
      : null;
  const focusEl =
    selection && selection.rangeCount > 0
      ? resolveTopLevelChild(selection.focusNode, preview)
      : null;
  const anchorIndex = anchorEl ? currentChildren.indexOf(anchorEl) : -1;
  const focusIndex = focusEl ? currentChildren.indexOf(focusEl) : -1;

  // Genuine last resort: no selection, a detached/unresolvable node, or
  // #preview has zero children. This is the ONLY fallback trigger -- a
  // block-count change alone (Enter/Backspace/list conversion) must NOT
  // reach this branch; Steps 2-4 below handle all of those by content-based
  // range resolution instead.
  if (currentChildren.length === 0 || anchorIndex === -1 || focusIndex === -1) {
    syncPreviewToMarkdown(origin);
    return;
  }

  const startDomIndex = Math.min(anchorIndex, focusIndex);
  const endDomIndex = Math.max(anchorIndex, focusIndex);
  const nAfter = currentChildren.length;

  // --- Step 2: find the nearest UNCHANGED block on each side, by content. ---
  const body = getDocumentBody(docId);
  const blocksFullBefore = getDocumentBlocks(docId);
  const renderableBefore = blocksFullBefore.filter(isRenderableBlockType);
  const nBefore = renderableBefore.length;

  // Collected ONCE per call (CR-01 fix) -- see normalisedForm()'s own header
  // comment. Every 'def' (reference-link definition) block's raw source
  // text, concatenated, so every normalisedForm() comparison below can
  // resolve a reference-style link the same way the live, full-document
  // render did, without re-parsing the whole document per comparison.
  const defBlocksText = blocksFullBefore
    .filter((b) => b.type === 'def')
    .map((b) => body.slice(b.srcStart, b.srcEnd))
    .join('\n\n');

  // Cost note (03-RESEARCH.md Pitfall 3): every comparison below calls
  // turndownBlock() (~0.06ms/call), never htmlToMarkdown() (55ms at 200
  // lines, 320ms at 2000). Even a pathological search that walks every
  // block on both sides stays in turndownBlock()'s cost class -- it can
  // never regress to whole-document-serialisation cost, which is the
  // property that makes an unbounded-looking scan still safe here.
  let leftAnchorIndex = -1;
  for (let i = startDomIndex - 1; i >= 0; i--) {
    if (i >= nBefore) continue; // no old counterpart at this position at all
    const candidate = renderableBefore[i];
    const currentMd = turndownBlock(currentChildren[i]);
    const oldMd = normalisedForm(body.slice(candidate.srcStart, candidate.srcEnd), defBlocksText);
    if (currentMd === oldMd) {
      leftAnchorIndex = i;
      break;
    }
  }

  // [Rule 1 - Bug, discovered this task] 03-04-PLAN.md's literal right-anchor
  // formula (d = 0, 1, 2, ... with i = N_after - 1 - d and oldIdx = N_before
  // - 1 - d) starts the search at the FAR END of the document and walks
  // TOWARD the edit, stopping at the first match -- but the far-end block is
  // almost always unedited, so it matches immediately at d = 0 regardless of
  // how close the real edit is, sweeping every block between the edit and
  // the document's end into the "affected" range. Concretely: for an
  // ordinary single-block edit with the block count unchanged
  // (nAfter === nBefore), that literal formula's oldIdx (nBefore - 1 - d)
  // does NOT reduce to "check the immediate neighbour first" the way the
  // left-anchor search does -- it reduces to "check the LAST block first,"
  // which would fail this task's own acceptance criterion that editing one
  // block produces an execCommand range covering exactly that block, not
  // also every unedited block after it out to the document's tail. The
  // search below is corrected to be symmetric with the left-anchor search:
  // start ADJACENT to the edit (i = endDomIndex + 1) and grow OUTWARD
  // (toward the document's end) as attempts fail, stopping at the first
  // (nearest) match. `distFromEnd`/`oldIdx` still use the "distance from the
  // end" alignment 03-04-PLAN.md calls for -- that part is correct and
  // necessary for surviving a block-count change -- only the search's
  // starting point and direction are corrected.
  let rightAnchorOldIndex = -1;
  let rightAnchorDomIndex = -1;
  for (let d = 0; ; d++) {
    const i = endDomIndex + 1 + d;
    if (i > nAfter - 1) break; // ran out of current DOM children -- no right anchor
    const distFromEnd = nAfter - 1 - i;
    const oldIdx = nBefore - 1 - distFromEnd;
    if (oldIdx < 0) continue; // no valid old counterpart at this distance yet
    const candidate = renderableBefore[oldIdx];
    const currentMd = turndownBlock(currentChildren[i]);
    const oldMd = normalisedForm(body.slice(candidate.srcStart, candidate.srcEnd), defBlocksText);
    if (currentMd === oldMd) {
      rightAnchorOldIndex = oldIdx;
      rightAnchorDomIndex = i;
      break;
    }
  }

  const firstAffectedIndex = leftAnchorIndex === -1 ? 0 : leftAnchorIndex + 1;
  const lastAffectedOldIndex =
    rightAnchorOldIndex === -1 ? nBefore - 1 : rightAnchorOldIndex - 1;
  const hasOldSpan = firstAffectedIndex <= lastAffectedOldIndex;

  const affectedSrcStart = hasOldSpan
    ? renderableBefore[firstAffectedIndex].srcStart
    : leftAnchorIndex === -1
      ? 0
      : renderableBefore[leftAnchorIndex].srcEnd;
  const affectedSrcEnd = hasOldSpan
    ? renderableBefore[lastAffectedOldIndex].srcEnd
    : rightAnchorOldIndex === -1
      ? body.length
      : renderableBefore[rightAnchorOldIndex].srcStart;

  // [Rule 1 - Bug, discovered this task] 03-04-PLAN.md's literal Step 2 ties
  // the "affected DOM region" directly to the raw selection bounds
  // (currentChildren[startDomIndex..endDomIndex]) -- but a COLLAPSED caret
  // (Enter-split's "collapsed caret in the SECOND new element") gives
  // startDomIndex === endDomIndex, a span of exactly ONE element. That
  // contradicts the plan's own acceptance criterion for this exact case
  // ("its replacement joins BOTH new elements' turndownBlock() output"):
  // the FIRST new element (immediately left of the caret) is genuinely new
  // content too and must not be silently excluded. The anchor search
  // itself is the mechanism that discovers this -- every element the left
  // search rejects as a MISMATCH (starting at startDomIndex - 1) is exactly
  // as much a part of the affected region as the caret's own element, and
  // the search only stops growing once it hits a genuine match. The DOM
  // region actually serialised below is therefore bounded by the anchors'
  // OWN positions (domStart/domEnd), not by the raw selection bounds
  // directly -- domStart/domEnd degrade to startDomIndex/endDomIndex
  // exactly whenever the immediate neighbours already matched on the first
  // try (the ordinary single/multi-block edit case), so this is a
  // generalisation, not a behaviour change, for every case that isn't a
  // structural (block-count-changing) edit.
  const domStart = leftAnchorIndex === -1 ? 0 : leftAnchorIndex + 1;
  const domEnd = rightAnchorDomIndex === -1 ? nAfter - 1 : rightAnchorDomIndex - 1;
  const affectedElements = currentChildren.slice(domStart, domEnd + 1);

  // --- Step 3: serialise the affected DOM region. ---
  const serializedParts = affectedElements.map((el) => turndownBlock(el));
  const affectedOldCount = lastAffectedOldIndex - firstAffectedIndex + 1;

  let serialised;
  if (serializedParts.length === affectedOldCount && affectedOldCount > 0) {
    // Counts match -- an ordinary N->N edit (typing, a toolbar command on a
    // static span). Reuse each pairwise ORIGINAL separator text verbatim so
    // exact original blank-line formatting survives untouched.
    serialised = serializedParts[0];
    for (let k = 1; k < serializedParts.length; k++) {
      const prevOld = renderableBefore[firstAffectedIndex + k - 1];
      const nextOld = renderableBefore[firstAffectedIndex + k];
      const separator = body.slice(prevOld.srcEnd, nextOld.srcStart);
      serialised += separator + serializedParts[k];
    }
  } else {
    // Counts differ -- a genuine new/removed boundary was created inside the
    // affected span (Enter-split, Backspace-join, or an N->M list
    // conversion). There is no "original" separator to reuse for a boundary
    // that did not exist before, so use the canonical blank-line separator
    // this codebase's whole marked/Turndown pipeline already uses between
    // block-level elements.
    serialised = serializedParts.join('\n\n');
  }

  // --- Step 4: splice, shift, and write. ---
  const unchangedSlice = body.slice(affectedSrcStart, affectedSrcEnd);
  if (serialised === normalisedForm(unchangedSlice, defBlocksText)) {
    return; // idempotent -- nothing to write
  }

  const newBody = spliceByRange(body, affectedSrcStart, affectedSrcEnd, serialised);

  // Re-derive new block entries by running renderWithSourceMap() over ONLY
  // the spliced sub-range (never the whole document -- that would be
  // exactly the htmlToMarkdown()-class cost this design exists to avoid),
  // then offset them into newBody's coordinate space.
  const localBlocks = renderWithSourceMap(serialised).blocks;
  const newBlocksAbsolute = localBlocks.map((b) => ({
    ...b,
    srcStart: b.srcStart + affectedSrcStart,
    srcEnd: b.srcEnd + affectedSrcStart,
  }));

  // affectedSrcStart/affectedSrcEnd are always exact boundaries of entries
  // in blocksFullBefore (derived only from real srcStart/srcEnd values, 0,
  // or body.length) -- offsets are contiguous (source-map.js's own
  // invariant), so partitioning by srcEnd/srcStart against those two
  // offsets is exact, never a partial-overlap split.
  //
  // [Rule 1 - Bug, discovered by 03-REVIEW.md WR-02] `keptAfter`'s shift used
  // to be inline `+ delta` arithmetic, duplicating caret-math.js's already-
  // tested `computeShiftedOffset()` (which existed, fully implemented, but
  // was wired in nowhere). Every `keptAfter` entry is, by the filter above,
  // already `>= affectedSrcEnd` (`rangeEnd`), so `computeShiftedOffset()`'s
  // rule 2 (`offset >= rangeEnd -> offset + (replacementLength - (rangeEnd -
  // rangeStart))`) applies unconditionally here and reduces to the exact
  // same `+ delta` this replaces -- same values, one tested implementation
  // instead of two.
  const keptBefore = blocksFullBefore.filter((b) => b.srcEnd <= affectedSrcStart);
  const shiftParams = {
    rangeStart: affectedSrcStart,
    rangeEnd: affectedSrcEnd,
    replacementLength: serialised.length,
  };
  const keptAfter = blocksFullBefore
    .filter((b) => b.srcStart >= affectedSrcEnd)
    .map((b) => ({
      ...b,
      srcStart: computeShiftedOffset(b.srcStart, shiftParams),
      srcEnd: computeShiftedOffset(b.srcEnd, shiftParams),
    }));

  const newBlocksFull = [...keptBefore, ...newBlocksAbsolute, ...keptAfter].map(
    (b, index) => ({ ...b, index })
  );

  setDocumentBody(newBody, docId);
  setDocumentBlocks(newBlocksFull, docId);

  // Write: a single surgical CM6 transaction over the computed [start, end)
  // range, via the dispatchAppWrite helper below -- never a whole-document
  // replacement, never the old DOM-command-based insertion mechanism. No
  // explicit `selection` field is passed: CM6's
  // default selection-mapping through the transaction's ChangeSet is relied
  // on to keep the caret stationary (12-RESEARCH.md Assumption A2; SYNC-09
  // is proven by 12-10-PLAN.md's caret-stability Playwright spec).
  // `isolateHistory: 'before'` (this function's per-origin tag, passed as
  // dispatchAppWrite's explicit 5th argument) groups this write with
  // whatever the user typed immediately before it, never with what comes
  // after -- matching 12-RESEARCH.md section 4's per-origin undo table for
  // splice/toolbar writes.
  //
  // `view` is the SAME binding hoisted to the top of this function (13-01)
  // -- getActiveEditor() is still resolved once, fresh, at the top of every
  // call (05-03; T-5-03), just no longer re-resolved a second time here.
  const frontMatterLength = getFrontMatter(docId).length;
  dispatchAppWrite(
    view,
    {
      from: frontMatterLength + affectedSrcStart,
      to: frontMatterLength + affectedSrcEnd,
      insert: serialised,
    },
    origin,
    docId,
    'before'
  );

  markDocumentDirty(docId);
  recordApplied('left', serialised, docId);
}

// Whole-document fallback. Its remaining legitimate callers are ONLY
// 03-05's paste and Ctrl+Shift+V handlers ('paste'/'paste-plain') and this
// file's own genuinely-last-resort call above (an unresolvable selection).
// No default `origin` value -- every caller must pass one explicitly, so an
// accidental un-tagged call cannot slip through silently.
//
// Deliberate deviation from the old (pre-03-04) version: the previous
// implementation saved/restored `mdInput.scrollTop` around the write,
// because `.value =` resets scroll position as a side effect. The
// dispatchAppWrite helper below never focuses the view at all, so there is
// no scroll or selection side effect to guard against here either -- that
// dance stays dead code, not ported.
export function syncPreviewToMarkdown(origin) {
  // Resolved fresh here, inside the function body, every call -- never
  // cached at module scope (05-03; T-5-03).
  const docId = getActiveDocId();
  // [13-01] Hoisted to immediately after docId, mirroring
  // syncPreviewBlockToMarkdown's identical hoist-and-guard pattern above --
  // see that function's own comment for the full reasoning (deferring the
  // WHOLE call, not just the dispatch, since this function's own
  // conversion/bookkeeping is only correct once composition's render pass
  // has caught up).
  const view = getActiveEditor();
  if (view.composing) {
    scheduleFlush('left', () => syncPreviewToMarkdown(origin), COMPOSITION_RETRY_MS, docId);
    return;
  }
  const frontMatter = getFrontMatter(docId);
  const fullMarkdown = htmlToMarkdown(getCleanPreviewHTML(), frontMatter);

  if (fullMarkdown === view.state.doc.toString()) return; // idempotent -- nothing to write

  // Whole-document surgical transaction -- [0, doc.length) is still a single
  // CM6 `changes` spec dispatched via the same dispatchAppWrite helper, never
  // `.value =` and never the old DOM-command-based insertion mechanism.
  // `isolateHistory: 'before'` matches this
  // function's own callers (the unresolvable-selection fallback above,
  // 'user-right'/'toolbar'-origin) -- 'full' is reserved for preview/
  // events.js's own syncScratchResultToMarkdown(), the SEPARATE function
  // paste/Ctrl+Shift+V actually go through (this file's own header comment
  // above explains why: it mirrors this function's write mechanism but is
  // not the same call, per 12-RESEARCH.md section 4's per-origin table).
  dispatchAppWrite(
    view,
    { from: 0, to: view.state.doc.length, insert: fullMarkdown },
    origin,
    docId,
    'before'
  );

  // Resync sync-controller.js's shared bookkeeping so the NEXT range-based
  // preview edit (syncPreviewBlockToMarkdown) has a correct baseline again.
  const body = fullMarkdown.slice(frontMatter.length);
  setDocumentBody(body, docId);
  setDocumentBlocks(renderWithSourceMap(body).blocks, docId);
  setFrontMatter(frontMatter, docId);

  markDocumentDirty(docId);
  recordApplied('left', fullMarkdown, docId);
}

// Ports index.html:728-734 MINUS the #empty-state guard (index.html:731-732).
// Per UI-SPEC New Surface 3, #empty-state is now a DOM sibling of #preview, not a
// child, so preview.innerHTML can never contain it — the guard is structurally
// unreachable and is "deleted, not ported" per 01-PATTERNS.md.
export function getCleanPreviewHTML() {
  const preview = document.getElementById('preview');
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = preview.innerHTML;
  return tempDiv.innerHTML.trim();
}
