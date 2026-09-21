// RENDERING: Left -> Right — replaces the isSyncing()/setSyncing() mutex and
// the unconditional preview.innerHTML = clean wholesale replace with an
// origin-aware, per-block patch (03-CONTEXT.md "Caret & Selection
// Preservation" / "Sync Loop Control & Debouncing"; ROADMAP criteria 1/3).
//
// Authorized deviations from strict parity (all from CONTEXT.md O7 decisions,
// unchanged from the previous version of this file):
//   1. DOMPurify.sanitize() runs on marked's output before it is ever assigned
//      to the DOM — a security control, not a behavior change (threat T-1-01).
//   2. The empty-state placeholder is a DOM sibling of #preview, toggled via
//      visibility, never written by this function (UI-SPEC New Surface 3).
//   3. DOMPurify.sanitize() forbids the "style" tag and the "style" attribute
//      via the sanitize-config options below (02-CONTEXT.md/02-RESEARCH.md
//      Post-Research Amendments, CONV-07, threat T-2-04) — reused verbatim,
//      not re-derived, by the paste handler 03-05 adds.

import DOMPurify from 'dompurify';
import { stripFrontMatter } from './front-matter.js';
import { renderWithSourceMap } from './source-map.js';
import {
  isNoOp,
  recordApplied,
  getDocumentBody,
  setDocumentBody,
  getDocumentBlocks,
  setDocumentBlocks,
  setFrontMatter,
} from './sync-controller.js';
// [05-REVIEW.md CR-01] renderMarkdown() was the one sync-engine entry point
// never migrated to per-docId state: it always read/wrote documentBody/
// documentBlocks/frontMatter under sync-controller.js's DEFAULT_DOC_ID (1),
// regardless of which document was actually active. back-convert.js's
// syncPreviewBlockToMarkdown()/syncPreviewToMarkdown() (05-03) already key
// those SAME three slots by getActiveDocId() -- so for any document other
// than docId 1, a preview edit read a phantom, permanently-empty "previous
// body" baseline (whatever renderMarkdown last wrote was filed under the
// wrong key) and spliced the edit in at a corrupted offset. Resolved fresh
// at the point of use (never cached at module scope), mirroring every other
// sync-engine file's own T-5-03 discipline.
import { getActiveDocId } from '../documents.js';

// renderWithSourceMap()'s `blocks` array is deliberately one entry per
// marked.lexer() top-level token, INCLUDING `type: 'space'` entries between
// visible blocks — that's what keeps the offsets contiguous (source-map.js's
// own header comment). marked.parser() renders NO DOM element for a `space`
// token, so `blocks.length`/`preview.children.length` are never directly
// comparable, and `blocks[i]`/`preview.children[i]` do NOT correspond
// index-for-index. `renderable[i]` is what corresponds to `preview.children[i]`.
//
// [Rule 1 - Bug, discovered in 03-04] `'space'` is not the ONLY non-visual
// top-level token type: a `'def'` token (a link-reference definition line,
// e.g. `[ref]: url`) also renders NO DOM element -- marked resolves the
// reference into the paragraph that USES it, and the definition line's own
// slot in the token stream contributes empty output. Filtering only
// `'space'` silently mis-indexed `renderable[i]`<->`preview.children[i]`
// for any document containing a reference-style link definition (verified
// directly against marked 18.0.9's token stream). back-convert.js (03-04)
// applies this identical predicate for its own DOM correspondence, per this
// phase's explicit requirement that both sync directions use the SAME rule.
function toRenderable(blocks) {
  return blocks.filter((block) => block.type !== 'space' && block.type !== 'def');
}

// [Rule 1 - Bug, discovered verifying this fix's own tabs-switch.spec.js e2e
// coverage] `applyPreviewPatch()`'s per-block diff (below) assumes
// `preview.children` currently corresponds to `previousRenderable` -- true
// ONLY if the docId being rendered now is also the docId that last actually
// painted the shared #preview element. Once documentBody/documentBlocks
// became per-docId (this fix's own CR-01 change, needed for back-convert.js's
// correctness), that assumption breaks the instant two documents alternate:
// switching from document A to document B and back to A, where A's OWN raw
// content never changed, makes A's own per-block diff see "my content is
// identical to my own last-known body" and skip the DOM write entirely --
// even though the LIVE #preview currently shows B's content, not A's. This
// module-level slot (private to this file, never exported -- it is a
// render.js-internal bookkeeping detail, not a per-document sync-controller.js
// state slot) tracks which docId's content is genuinely painted onto the
// shared #preview right now, so renderMarkdown() can force a full replace
// whenever the active document changed since the last render, and keep the
// efficient per-block patch only for the common case of typing within the
// SAME still-active document.
let lastPreviewDocId = null;

export function renderMarkdown(md, docId = getActiveDocId()) {
  const preview = document.getElementById('preview');
  const { frontMatter, body } = stripFrontMatter(md);
  const previousBody = getDocumentBody(docId);
  const previousBlocks = getDocumentBlocks(docId);
  const { html, blocks } = renderWithSourceMap(body);
  const forceFullReplace = docId !== lastPreviewDocId;

  // WR-04 (Phase 2), preserved through this migration in spirit rather than
  // literally: setSyncing(false) used to be the thing a thrown parse/sanitize
  // exception could skip, wedging the preview permanently behind the
  // isSyncing() guard forever after. There is no boolean mutex left to reset
  // here — isNoOp/recordApplied and the per-block diff below replace it
  // entirely — but the PROPERTY that fix protected still matters exactly as
  // much: a thrown exception must not leave documentBody/documentBlocks/
  // frontMatter (or the empty-state toggle) stale, because the very NEXT call
  // diffs against exactly that bookkeeping. The `finally` below is what
  // guarantees that, even though nothing inside it looks like a lock being
  // released.
  try {
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['style'],
      FORBID_ATTR: ['style'],
    });

    // [Rule 1 - Bug, discovered verifying this fix's own tabs-close.spec.js/
    // tabs-switch.spec.js e2e coverage] isNoOp/recordApplied for the
    // 'preview' target are DELIBERATELY NOT keyed by docId, unlike every
    // other call in this function -- #preview is a genuine singleton DOM
    // element (never one per document; 05-07-SUMMARY.md's own correct
    // finding), so this cache must track "what is actually painted onto the
    // ONE shared #preview element right now," not "what was last painted
    // while THIS document happened to be active." Keying it by docId (as
    // 05-REVIEW.md's CR-01 fix suggestion literally proposed) reintroduces a
    // DIFFERENT, worse bug: switching from document A to document B (which
    // blanks #preview) and then back to A, where A's own raw content is
    // unchanged, makes isNoOp('preview', clean, docIdA) true against A's OWN
    // stale cache entry -- even though the LIVE DOM currently shows B's
    // (blank) render -- silently skipping the write and leaving #preview
    // empty. Verified empirically: this exact scenario is what
    // tabs-close.spec.js's "closing the active tab re-syncs the preview"
    // test and tabs-switch.spec.js's Ctrl+Tab/Ctrl+Shift+Tab tests exercise.
    if (!isNoOp('preview', clean)) {
      applyPreviewPatch(preview, clean, blocks, previousBlocks, body, previousBody, forceFullReplace);
      recordApplied('preview', clean);
    }
  } finally {
    setDocumentBody(body, docId);
    setDocumentBlocks(blocks, docId);
    setFrontMatter(frontMatter, docId);
    // Runs unconditionally, same WR-04 reasoning as the three bookkeeping
    // writes above: whatever happened above (write, no-op, or a thrown
    // exception), THIS docId is now the one whose content the shared
    // #preview element is (or should be) showing, so the next call --
    // whichever docId it names -- must diff against that fact.
    lastPreviewDocId = docId;

    // Toggle the sibling empty-state overlay's visibility instead of injecting
    // its markup into #preview (UI-SPEC New Surface 3) — unchanged, runs on
    // every call regardless of which branch above ran or threw.
    document.getElementById('empty-state').classList.toggle('hidden', Boolean(md.trim()));
  }
}

// Applies `clean` HTML to `preview`, either via a full replace or via a
// per-block patch addressed by RENDERABLE index (see toRenderable's header
// comment above).
function applyPreviewPatch(preview, clean, blocks, previousBlocks, body, previousBody, forceFullReplace) {
  const renderable = toRenderable(blocks);
  const previousRenderable = toRenderable(previousBlocks);

  // Structural fallback (the safe, existing behavior), in priority order:
  //   1. A different document was the last to actually paint #preview
  //      (forceFullReplace) -- see this function's caller and the
  //      `lastPreviewDocId` comment above for why the per-block diff below
  //      is unsafe to trust across a document switch.
  //   2. First render (nothing to diff against).
  //   3. A visible block was added or removed (renderable counts differ).
  //   4. The live preview DOM doesn't actually contain one child per previous
  //      renderable block. This guards a real edge case: if a PRIOR call's
  //      bookkeeping was updated (in its own `finally`, per the comment
  //      above) but its DOM write never completed -- e.g. it threw before
  //      reaching this function at all -- trusting that stale bookkeeping
  //      here would address preview.children by an index that doesn't exist.
  //      Falling back to a full replace is always safe and is exactly the
  //      WR-04 "must render normally on the next call" recovery guarantee
  //      this migration must not regress.
  const structuralChange =
    forceFullReplace ||
    previousBlocks.length === 0 ||
    renderable.length !== previousRenderable.length ||
    preview.children.length !== previousRenderable.length;

  if (structuralChange) {
    preview.innerHTML = clean;
    return;
  }

  const temp = document.createElement('div');
  temp.innerHTML = clean;
  const oldChildren = Array.from(preview.children);
  const newChildren = Array.from(temp.children);

  for (let i = 0; i < renderable.length; i++) {
    const block = renderable[i];
    const previousBlock = previousRenderable[i];
    const newSrc = body.slice(block.srcStart, block.srcEnd);
    const oldSrc = previousBody.slice(previousBlock.srcStart, previousBlock.srcEnd);
    if (newSrc === oldSrc) continue; // untouched -- leave this child's node identity alone

    patchBlock(oldChildren[i], newChildren[i]);
  }
}

// Replaces `oldElement` with `newElement` in place. If the current selection
// anchors inside `oldElement`, its position is captured as a character offset
// relative to oldElement's own textContent and re-placed at the equivalent
// offset in newElement after the swap (03-RESEARCH.md Pattern 3/Pitfall 2:
// verified that patching the EXACT block a selection anchors inside "heals"
// the selection to a coarse element-child-index position unless guarded this
// way; patching any OTHER (sibling) block leaves an unrelated selection
// completely intact by construction -- no code needed for that case, and none
// is run here for it).
function patchBlock(oldElement, newElement) {
  const selection = window.getSelection();
  let charOffset = null;
  if (selection && selection.rangeCount > 0 && oldElement.contains(selection.anchorNode)) {
    charOffset = textOffsetOf(oldElement, selection.anchorNode, selection.anchorOffset);
  }

  oldElement.replaceWith(newElement);

  if (charOffset !== null) {
    placeCaretAtTextOffset(newElement, charOffset);
  }
}

// Walks `container`'s text nodes in document order, returning the character
// offset of (targetNode, targetOffset) relative to container's own
// textContent. Falls back to the end of the text if targetNode is never
// found as a descendant text node (e.g. the selection anchored on the
// element itself rather than one of its text children).
function textOffsetOf(container, targetNode, targetOffset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node === targetNode) return offset + targetOffset;
    offset += node.textContent.length;
  }
  return offset;
}

// Inverse of textOffsetOf: walks `container`'s text nodes and places a
// collapsed selection at the given character offset.
function placeCaretAtTextOffset(container, charOffset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = charOffset;
  let node;
  let lastNode = null;
  while ((node = walker.nextNode())) {
    lastNode = node;
    if (remaining <= node.textContent.length) {
      setCollapsedRange(node, remaining);
      return;
    }
    remaining -= node.textContent.length;
  }
  if (lastNode) {
    setCollapsedRange(lastNode, lastNode.textContent.length);
  }
}

function setCollapsedRange(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
