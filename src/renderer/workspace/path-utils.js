// Shared path-containment check for the two independent directory-delete
// cascades this phase ships: reconcile.js's watcher-driven external-delete
// cascade (WORK-06) and tree-edit.js's in-app delete cascade (WORK-03).
//
// WR-02 (07-REVIEW.md): the two cascades used to carry their own,
// independently-written copies of this exact check, and they had already
// diverged -- reconcile.js's copy was case-sensitive while tree-edit.js's
// was correctly case-insensitive. Windows filesystems are case-insensitive
// but case-preserving (`doc.filePath` can carry different casing than a
// watcher-reported or tree-derived `dirPath`, e.g. a file opened via
// drag-and-drop or a manually-typed Open-dialog path), so both callers need
// the identical lowercase-both-sides comparison. One shared implementation
// means the two cascades cannot silently drift apart on this again.
//
// Segment-aware, never a bare substring/startsWith(dirPath) match --
// `C:\notes2\x.md` must never be mistaken for a child of `C:\notes` just
// because the string "notes" is a substring of "notes2" (T-7-17, this
// phase's own deliberate collision trap, unit-tested in both callers'
// test files).
export function isPathInsideDir(filePath, dirPath) {
  const fp = filePath.toLowerCase();
  const dp = dirPath.toLowerCase();
  return fp === dp || fp.startsWith(`${dp}\\`) || fp.startsWith(`${dp}/`);
}
