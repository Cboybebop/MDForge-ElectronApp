// status.test.js -- unit tests for status.js's pure counting functions
// (countWords/countChars/formatDocCount), per 05-UI-SPEC.md Surface 3's
// "Counting rules (deterministic)" section.
//
// These functions are pure and markdown-agnostic: they count whatever text
// they are given. The "counts derive from rendered PROSE, never raw
// Markdown syntax" guarantee is a CALL-SITE responsibility (status.js's
// own updateDocCount() feeds them #preview.innerText, never the raw
// Markdown source) -- so most of this file's fixtures are innerText-SHAPED
// plain prose (no `**`, `#`, backticks, or link brackets). The
// "raw Markdown vs. rendered prose" describe block below exists precisely
// to demonstrate that distinction is real and is NOT handled by these
// functions themselves. Task 2's e2e spec (tests/e2e/doc-count.spec.js) is
// what proves the call site actually strips Markdown syntax before these
// functions ever see it.
//
// No DOM fixture / jsdom needed -- these are pure string functions, run
// under vitest.config.js's default `node` environment.
import { describe, it, expect } from 'vitest';
import { countWords, countChars, formatDocCount } from './status.js';

describe('countWords', () => {
  it('counts space-separated runs of non-whitespace as words', () => {
    expect(countWords('bold text and a link')).toBe(5);
  });

  it('returns 0 for empty input', () => {
    expect(countWords('')).toBe(0);
  });

  it('collapses multiple whitespace/newlines between words', () => {
    expect(countWords('one\n\ntwo   three')).toBe(3);
  });
});

describe('countChars', () => {
  it('counts an emoji (astral-plane character) as exactly 1 character, not 2', () => {
    expect(countChars('😀')).toBe(1);
  });

  it('counts an emoji embedded in prose correctly', () => {
    expect(countChars('Hi 😀 there')).toBe(10); // H i · 😀 · t h e r e
  });

  it('strips \\r before counting (CRLF normalisation)', () => {
    expect(countChars('a\r\nb')).toBe(3); // 'a', '\n', 'b'
  });

  it('returns 0 for empty input', () => {
    expect(countChars('')).toBe(0);
  });
});

describe('raw Markdown vs. rendered prose (call-site responsibility, not these functions\')', () => {
  it('countWords has no Markdown awareness -- **bold**/#/`code`/[text](url) syntax survives untouched if fed directly', () => {
    expect(countWords('**bold** # `code` [text](url)')).toBe(4);
  });

  it('a raw Markdown heading counts differently than its rendered prose equivalent', () => {
    // '#' and 'Title' both match /\S+/ as separate tokens when fed raw.
    expect(countWords('# Title')).toBe(2);
    // This is the shape updateDocCount() actually feeds these functions
    // (#preview.innerText after markdownToHtml renders the heading).
    expect(countWords('Title')).toBe(1);

    expect(countChars('# Title')).toBe(7);
    expect(countChars('Title')).toBe(5);
  });
});

describe('formatDocCount', () => {
  it('formats whole-document counts with the middle-dot separator and no prefix', () => {
    expect(formatDocCount(1234, 7890, false)).toBe('1,234 words · 7,890 chars');
  });

  it('formats zero-content input as the literal empty-state string', () => {
    expect(formatDocCount(0, 0, false)).toBe('0 words · 0 chars');
  });

  it('prefixes "Selection: " when isSelection is true', () => {
    expect(formatDocCount(12, 63, true)).toBe('Selection: 12 words · 63 chars');
  });
});
