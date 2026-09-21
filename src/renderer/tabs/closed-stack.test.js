// Unit tests for tabs/closed-stack.js's depth-10 bounded LIFO stack
// (DOC-07). No DOM/documents.js dependency at all -- this module holds no
// DOM reference (05-PATTERNS.md's own note that a plain, non-jsdom
// environment is sufficient whenever a module holds no DOM reference).
//
// closedStack is private module state with no reset export, so every test
// below drains the stack first (repeated popClosed() until undefined) --
// the only way to get back to a known-empty stack between tests without
// vi.resetModules() (which would defeat the point of testing a persistent
// module-level stack across pushes).
import { describe, it, expect, beforeEach } from 'vitest';
import { pushClosed, popClosed } from './closed-stack.js';

function drainStack() {
  while (popClosed() !== undefined) {
    // drain
  }
}

beforeEach(() => {
  drainStack();
});

describe('closed-stack.js', () => {
  it('popClosed() returns undefined on an empty stack -- the silent no-op contract', () => {
    expect(popClosed()).toBeUndefined();
  });

  it('pops entries in LIFO order (most-recently-closed first)', () => {
    pushClosed({ filePath: 'a.md', content: 'A', dirty: false });
    pushClosed({ filePath: 'b.md', content: 'B', dirty: true });
    pushClosed({ filePath: 'c.md', content: 'C', dirty: false });

    expect(popClosed()).toEqual({ filePath: 'c.md', content: 'C', dirty: false });
    expect(popClosed()).toEqual({ filePath: 'b.md', content: 'B', dirty: true });
    expect(popClosed()).toEqual({ filePath: 'a.md', content: 'A', dirty: false });
    expect(popClosed()).toBeUndefined();
  });

  it('caps at 10 entries, evicting the OLDEST entry once an 11th is pushed', () => {
    for (let i = 1; i <= 11; i++) {
      pushClosed({ filePath: `doc-${i}.md`, content: `content ${i}`, dirty: false });
    }

    // doc-1.md was the oldest and must have been evicted; only doc-2..doc-11
    // remain, most-recently-pushed (doc-11) first.
    const popped = [];
    let entry;
    while ((entry = popClosed()) !== undefined) popped.push(entry.filePath);

    expect(popped).toHaveLength(10);
    expect(popped).toEqual([
      'doc-11.md', 'doc-10.md', 'doc-9.md', 'doc-8.md', 'doc-7.md',
      'doc-6.md', 'doc-5.md', 'doc-4.md', 'doc-3.md', 'doc-2.md',
    ]);
    expect(popped).not.toContain('doc-1.md');
  });

  it('an empty stack after a full drain stays a silent no-op on further pops', () => {
    pushClosed({ filePath: null, content: 'solo', dirty: true });
    expect(popClosed()).toEqual({ filePath: null, content: 'solo', dirty: true });
    expect(popClosed()).toBeUndefined();
    expect(popClosed()).toBeUndefined();
  });
});
