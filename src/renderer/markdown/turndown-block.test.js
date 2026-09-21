// @vitest-environment jsdom
//
// Unit tests for turndownBlock() (CONV-08's single-subtree Turndown
// primitive). jsdom is required here — not because turndownBlock.js itself
// has a hard DOM dependency (Turndown ships its own domino fallback and
// runs fine under plain node), but because these tests need a real DOM
// Element to call node.outerHTML on, per 02-PATTERNS.md's note for this file.

import { describe, it, expect, beforeEach } from 'vitest';
import { turndownBlock } from './turndown-block.js';
import { turndown } from './turndown-config.js';

// Builds `<tag>${innerHTML}</tag>` as a real, attached DOM element and
// returns that element itself (not a wrapping <div>). This matters: Turndown's
// own defaultReplacement override in turndown-config.js returns node.outerHTML
// verbatim (unprocessed children included) for any BLOCK element with no
// matching rule -- a plain wrapping <div> has no such rule, so wrapping test
// content in one would trigger that fallback on the wrapper itself and mask
// the very conversion this file is testing. Real Phase-3 callers pass an
// actual block node (p, li, td, ...), which always has a specific rule, so
// the tests must do the same.
function makeElement(tag, html) {
  document.body.innerHTML = `<${tag}>${html}</${tag}>`;
  return document.body.firstElementChild;
}

describe('turndownBlock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('converts a subtree containing <strong>bold</strong> to markdown containing **bold**', () => {
    const node = makeElement('p', '<strong>bold</strong>');
    expect(turndownBlock(node)).toContain('**bold**');
  });

  it('preserves an HTML comment mid-content verbatim, via the same protectComments contract turndown-config.js callers must honor', () => {
    const node = makeElement('p', 'before<!-- keep me -->after');
    const md = turndownBlock(node);
    expect(md).toContain('<!-- keep me -->');
  });

  it('never constructs a second TurndownService -- reuses the exact turndown-config.js singleton across repeated calls', () => {
    // If turndownBlock() constructed its own `new TurndownService()` instead
    // of importing the configured singleton, it would never see a rule
    // added to that singleton after the fact. Registering a marker rule on
    // the imported singleton and confirming turndownBlock() picks it up --
    // on two separate calls -- proves both calls run through the SAME
    // instance, not two fresh ones.
    turndown.addRule('importDisciplineMarker', {
      filter: 'mark-test-marker',
      replacement: () => 'MARKER-HIT',
    });

    const first = turndownBlock(makeElement('mark-test-marker', 'x'));
    const second = turndownBlock(makeElement('mark-test-marker', 'y'));

    expect(first).toContain('MARKER-HIT');
    expect(second).toContain('MARKER-HIT');
  });
});
