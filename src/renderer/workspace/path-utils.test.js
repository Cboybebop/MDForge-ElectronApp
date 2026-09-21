// WR-02 (07-REVIEW.md): unit coverage for the shared, case-insensitive,
// segment-aware directory-containment check now used by both
// reconcile.js's watcher-driven directory-vanish cascade and tree-edit.js's
// in-app delete cascade.
import { describe, it, expect } from 'vitest';
import { isPathInsideDir } from './path-utils.js';

describe('isPathInsideDir', () => {
  it('matches a child path under the directory, backslash-separated', () => {
    expect(isPathInsideDir('C:\\notes\\a.md', 'C:\\notes')).toBe(true);
  });

  it('matches a child path under the directory, forward-slash-separated', () => {
    expect(isPathInsideDir('C:/notes/a.md', 'C:/notes')).toBe(true);
  });

  it('matches the directory path itself', () => {
    expect(isPathInsideDir('C:\\notes', 'C:\\notes')).toBe(true);
  });

  it('is case-insensitive on both sides (Windows filesystem semantics) -- WR-02, the regression this fix closes', () => {
    expect(isPathInsideDir('C:\\Notes\\A.MD', 'c:\\notes')).toBe(true);
    expect(isPathInsideDir('c:\\notes\\a.md', 'C:\\NOTES')).toBe(true);
  });

  it('never matches a sibling directory sharing a name prefix (notes vs notes2) -- T-7-17', () => {
    expect(isPathInsideDir('C:\\notes2\\c.md', 'C:\\notes')).toBe(false);
    expect(isPathInsideDir('C:\\NOTES2\\c.md', 'c:\\notes')).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(isPathInsideDir('C:\\other\\a.md', 'C:\\notes')).toBe(false);
  });
});
