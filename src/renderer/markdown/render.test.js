// @vitest-environment jsdom
//
// Unit tests for renderMarkdown()'s DOMPurify sanitization (threat T-1-01),
// its preservation of legitimate structural/formatting HTML, and (03-03) its
// origin-aware, per-block preview patch replacing the old unconditional
// innerHTML= assignment.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { getDocumentBlocks, setDocumentBody, setDocumentBlocks, setFrontMatter } from './sync-controller.js';

// [05-REVIEW.md CR-01 fix] render.js now resolves a default `docId` via
// documents.js's getActiveDocId(), so a static top-of-file import of
// render.js would transitively import documents.js -- which captures
// `#md-input`/`#left-pane` as live element references AT MODULE-LOAD TIME
// and immediately wires attachEditorEvents()/attachLeftScrollSync() (a
// transitive import of panes/scroll-sync.js, which ALSO queries `#preview`
// at module scope) onto the bootstrap document's surface. This file's own
// DOM does not exist yet at that point -- module evaluation runs before any
// test's `beforeEach` fires. Mirrors back-convert.test.js's/
// sync-controller.test.js's own established fix: build the full DOM
// fixture once in `beforeAll`, THEN dynamically `import()` render.js.
let renderMarkdown;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <textarea id="md-input"></textarea>
    </div>
    <div id="preview" contenteditable="true"></div>
    <div id="empty-state"></div>
    <input type="checkbox" id="toggle-sync-scroll" />
  `;
  ({ renderMarkdown } = await import('./render.js'));
});

// Resets CONTENT on the SAME persistent `#preview`/`#empty-state` nodes
// built once in `beforeAll` -- deliberately NOT `document.body.innerHTML =
// ...` (which would create a brand-new `<textarea id="md-input">` every
// test, orphaning the exact element reference documents.js cached at
// import time), mirroring back-convert.test.js's/sync-controller.test.js's
// identical `setupFixture()`/`setupSyncDom()` idiom.
function setupDom() {
  document.getElementById('preview').innerHTML = '';
  document.getElementById('empty-state').classList.remove('hidden');
}

const THREE_PARA = 'Para one.\n\nPara two.\n\nPara three.';
const THREE_PARA_EDITED_P2 = 'Para one.\n\nPara two EDITED.\n\nPara three.';

describe('renderMarkdown', () => {
  beforeEach(() => {
    setupDom();
    delete window.__pwned;
    window.getSelection().removeAllRanges();
    // Guard against cross-test pollution of sync-controller.js's shared
    // documentBody/documentBlocks/frontMatter state (module-level, singleton
    // across this test file's run) -- replaces the old setSyncing(false)
    // reset now that the old isUpdating-mutex module no longer exists.
    setDocumentBody('');
    setDocumentBlocks([]);
    setFrontMatter('');
  });

  it('never executes a malicious payload via DOMPurify sanitization', () => {
    renderMarkdown('<img src=x onerror="window.__pwned = true">');
    expect(window.__pwned).toBeUndefined();
  });

  it('preserves legitimate structural/formatting HTML', () => {
    renderMarkdown('# Heading\n\nSome **bold** text.');
    const html = document.getElementById('preview').innerHTML;
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  // CONV-07 / T-2-04: DOMPurify's default config strips <script>, on*, and
  // <iframe>/<object>/<embed>, but does NOT block CSS url() exfiltration via
  // a style attribute or a <style> tag — verified in 02-RESEARCH.md Pitfall 4.
  // These three cases assert the FORBID_TAGS/FORBID_ATTR config added in
  // render.js closes that gap, and are exact-vector assertions (not a loose
  // "no script tag" check) so a future contributor loosening the config fails
  // a specific, legible test — the same regression-guard idiom csp.spec.js
  // uses for CSP drift.
  it('strips a <style> tag carrying a CSS url() exfiltration vector', () => {
    renderMarkdown('<style>body{background:url(http://evil.example/x.png)}</style>');
    const html = document.getElementById('preview').innerHTML;
    expect(html).not.toContain('url(');
  });

  it('strips an iframe rather than allowing it to load', () => {
    renderMarkdown('<iframe src="http://evil.example"></iframe>');
    const html = document.getElementById('preview').innerHTML;
    expect(html).not.toContain('<iframe');
  });

  it('strips a style attribute carrying a CSS url() exfiltration vector', () => {
    renderMarkdown('<div style="background:url(http://evil.example/x.png)">x</div>');
    const html = document.getElementById('preview').innerHTML;
    expect(html).not.toContain('url(');
  });

  it('leaves state consistent even if DOMPurify.sanitize() throws, so the preview does not permanently wedge (WR-04)', () => {
    // Before the original fix, setSyncing(true) at the top of renderMarkdown()
    // had no matching try/finally: if marked.parse()/DOMPurify.sanitize()
    // threw for any input, setSyncing(false) never ran, and the isSyncing()
    // guard at the top of every future call made renderMarkdown() a silent,
    // permanent no-op for the rest of the session. There is no isSyncing()
    // mutex left to assert against -- the property that matters now is that
    // the new bookkeeping (documentBlocks/documentBody/frontMatter) stays
    // valid, and a subsequent call still renders normally rather than being
    // permanently wedged.
    const spy = vi.spyOn(DOMPurify, 'sanitize').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => renderMarkdown('# Heading')).toThrow('boom');
    expect(Array.isArray(getDocumentBlocks())).toBe(true);
    expect(getDocumentBlocks().length).toBeGreaterThan(0);
    spy.mockRestore();

    // And a subsequent call must render normally rather than remaining a
    // permanent silent no-op.
    renderMarkdown('# After recovery');
    const html = document.getElementById('preview').innerHTML;
    expect(html).toContain('<h1>After recovery</h1>');
  });

  it('falls back to a full innerHTML replace and still renders correctly when the block count changes', () => {
    renderMarkdown('Para one.\n\nPara two.');
    expect(document.getElementById('preview').children.length).toBe(2);

    renderMarkdown('Para one.\n\nPara two.\n\nPara three (new).');

    const preview = document.getElementById('preview');
    expect(preview.children.length).toBe(3);
    expect(preview.textContent).toContain('Para three (new).');
  });

  it('addresses the per-block patch by the RENDERABLE (space-filtered) index, not the raw blocks-array index, when editing the second of three paragraphs', () => {
    renderMarkdown(THREE_PARA);
    const preview = document.getElementById('preview');
    expect(preview.children.length).toBe(3);

    renderMarkdown(THREE_PARA_EDITED_P2);

    expect(preview.children.length).toBe(3);
    expect(preview.children[1].textContent).toBe('Para two EDITED.');
  });

  it('leaves the first paragraph element the exact same object reference across a call that only edits the second paragraph', () => {
    renderMarkdown(THREE_PARA);
    const firstBefore = document.getElementById('preview').children[0];

    renderMarkdown(THREE_PARA_EDITED_P2);

    const firstAfter = document.getElementById('preview').children[0];
    expect(firstAfter).toBe(firstBefore);
  });

  it('leaves a selection anchored in an untouched sibling block completely intact when a different block is patched', () => {
    renderMarkdown(THREE_PARA);
    const preview = document.getElementById('preview');
    const thirdParaTextNode = preview.children[2].firstChild;
    const range = document.createRange();
    range.setStart(thirdParaTextNode, 3);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    renderMarkdown(THREE_PARA_EDITED_P2);

    expect(selection.anchorNode).toBe(thirdParaTextNode);
    expect(selection.anchorOffset).toBe(3);
  });

  it('does not throw and keeps rangeCount at 1 when a selection is anchored inside the exact block being patched', () => {
    renderMarkdown(THREE_PARA);
    const preview = document.getElementById('preview');
    const secondParaTextNode = preview.children[1].firstChild;
    const range = document.createRange();
    range.setStart(secondParaTextNode, 4);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    expect(() => renderMarkdown(THREE_PARA_EDITED_P2)).not.toThrow();
    expect(window.getSelection().rangeCount).toBe(1);
  });

  // [Rule 1 - Bug, discovered verifying 05-REVIEW.md CR-01's own fix via
  // tabs-close.spec.js/tabs-switch.spec.js] Once documentBody/documentBlocks
  // became per-docId (required so back-convert.js sees the correct baseline
  // for each document -- CR-01's own concern), renderMarkdown()'s per-block
  // diff broke a DIFFERENT invariant it silently relied on: that
  // preview.children always corresponds to THIS docId's own previousBlocks.
  // That is only true if this same docId was also the last one to actually
  // paint the shared #preview element. Switching to document 3 (Gamma), then
  // back to document 1 (Alpha) -- whose OWN raw content never changed in the
  // meantime -- must still repaint #preview with Alpha's content, not
  // silently skip the write because "Alpha's content is unchanged relative
  // to Alpha's own last-known body" (true, but irrelevant: the LIVE DOM
  // currently shows Gamma's content, not Alpha's).
  it('CR-01 follow-up: switching back to a document whose own content never changed still repaints the shared #preview, not a stale sibling document\'s content', () => {
    renderMarkdown('Alpha content', 1);
    const preview = document.getElementById('preview');
    expect(preview.textContent.trim()).toBe('Alpha content');

    renderMarkdown('', 2); // a second, blank document becomes active
    expect(preview.textContent.trim()).toBe('');

    renderMarkdown('Gamma content', 3); // a third document becomes active
    expect(preview.textContent.trim()).toBe('Gamma content');

    // Switch back to document 1 -- its own content is byte-identical to the
    // very first call above, but the LIVE #preview currently shows document
    // 3's content and must be repainted.
    renderMarkdown('Alpha content', 1);
    expect(preview.textContent.trim()).toBe('Alpha content');
  });
});
