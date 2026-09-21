// Pure offset-shift arithmetic for a [rangeStart, rangeEnd) -> replacement
// splice. No module-level state, no DOM -- see splice.js's terseness for the
// density this file matches: the whole point is that there is nothing here
// to get wrong.
//
// Call sites: back-convert.js's syncPreviewBlockToMarkdown() (wired in per
// 03-REVIEW.md WR-02; this header previously claimed the wiring existed
// before it actually did) uses this to shift every documentBlocksMap entry
// AFTER the edited/spliced range following a per-block splice, so stored
// offsets stay valid without a full re-parse on every preview keystroke.
//
// [12-05] Rescoped: this file's remaining consumer is ONLY that stored-
// block-offset-table bookkeeping (documentBlocksMap), never live caret/
// selection positioning. Live cursor/selection mapping through a write is
// now CM6's own `ChangeSet.mapPos()` (or, for the whole transaction,
// dispatchAppWrite()'s reliance on CM6's default selection-mapping through
// the dispatched `changes` spec -- 12-RESEARCH.md Assumption A2) -- neither
// of which lives in this file. Before this phase, this function was ALSO
// the documented ground truth for what the old textarea write API did
// automatically to a textarea's cursor-position properties; that consumer
// is gone along with the textarea-based write mechanism itself.

// Rules, in this exact priority order:
//   1. offset <= rangeStart          -> unchanged
//   2. offset >= rangeEnd            -> offset + (replacementLength - (rangeEnd - rangeStart))
//   3. otherwise (strictly inside)   -> rangeStart + replacementLength
export function computeShiftedOffset(offset, { rangeStart, rangeEnd, replacementLength }) {
  if (offset <= rangeStart) return offset;
  if (offset >= rangeEnd) return offset + (replacementLength - (rangeEnd - rangeStart));
  return rangeStart + replacementLength;
}
