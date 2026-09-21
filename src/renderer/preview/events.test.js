// @vitest-environment jsdom
//
// Unit tests for preview/events.js's PREVIEW_ECHO_ORIGINS suppression
// (03-REVIEW.md WR-01). Scoped narrowly to the #preview `input` listener's
// echo-suppression check -- the full paste round trip (DOMPurify, the
// scratch-clone execCommand simulation, applyUndoSafeInsertion) is already
// covered end-to-end by tests/e2e/paste-sanitise.spec.js against the real
// Chromium runtime; jsdom implements neither `document.execCommand` nor
// `contenteditable` well enough to re-prove that here (see
// back-convert.test.js's own header note on the same limitation). This file
// isolates the one thing WR-01 is about: does an `input` event that fires
// while `beginWrite('paste')`/`beginWrite('paste-plain')` is active get
// treated as this pane's own echo (no scheduleFlush call) rather than a
// fresh user edit?
//
// scheduleFlush is mocked the same way editor-events.test.js mocks it:
// beginWrite/endWrite/getActiveOrigin are left as the REAL sync-controller.js
// implementations (via importActual) because the echo-suppression check
// needs real, shared origin-tag state between the test body and the module
// under test.
//
// [12-05] `#md-input` below is now a plain mount-host `<div>`, matching
// index.html's real post-12-02 shape -- documents.js's real (unmocked)
// module-load-time bootstrap mounts a genuine CM6 EditorView into it the
// moment `./events.js` is imported below, exactly as it does in the running
// app. This file still never asserts against that view's content directly
// (syncScratchResultToMarkdown's own write is covered by the e2e paste spec,
// per this header's opening paragraph); it only needed to stop handing
// documents.js a `<textarea>` a real EditorView cannot meaningfully mount
// into the way production code does.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../markdown/sync-controller.js', async () => {
  const actual = await vi.importActual('../markdown/sync-controller.js');
  return {
    ...actual,
    scheduleFlush: vi.fn(),
    flush: vi.fn(),
  };
});

import { beginWrite, endWrite, scheduleFlush } from '../markdown/sync-controller.js';

let preview;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="preview" contenteditable="true"></div>
    <div id="md-input"></div>
    <input type="checkbox" id="toggle-sync-scroll" />
  `;
  preview = document.getElementById('preview');
  await import('./events.js');
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Hygiene: never leave the shared origin-tag state set across tests.
  endWrite();
});

describe('#preview input listener -- PREVIEW_ECHO_ORIGINS (WR-01)', () => {
  it("does not call scheduleFlush for a synthetic input event while beginWrite('paste') is active", () => {
    beginWrite('paste');
    preview.dispatchEvent(new Event('input'));

    expect(scheduleFlush).not.toHaveBeenCalled();
  });

  it("does not call scheduleFlush for a synthetic input event while beginWrite('paste-plain') is active", () => {
    beginWrite('paste-plain');
    preview.dispatchEvent(new Event('input'));

    expect(scheduleFlush).not.toHaveBeenCalled();
  });

  it("does not call scheduleFlush for a synthetic input event while beginWrite('toolbar') is active (unchanged pre-existing behaviour)", () => {
    beginWrite('toolbar');
    preview.dispatchEvent(new Event('input'));

    expect(scheduleFlush).not.toHaveBeenCalled();
  });

  it('calls scheduleFlush for a synthetic input event with no active write (a genuine user edit)', () => {
    preview.dispatchEvent(new Event('input'));

    expect(scheduleFlush).toHaveBeenCalledTimes(1);
  });
});

// 03-REVIEW.md IN-02: computeResultViaScratch() runs on every paste against
// an off-screen `.paste-scratch` clone of #preview. jsdom implements neither
// `document.execCommand` nor real focus/scroll behaviour, so this cannot
// prove the ABSENCE of visible scroll jank -- it proves the narrower, real
// thing IN-02 asks for: that the clone is focused with
// `{ preventScroll: true }`, via a spy on HTMLElement.prototype.focus.
describe('paste handler -- scratch clone focus (IN-02)', () => {
  let focusSpy;

  beforeEach(() => {
    preview.innerHTML = '<p>Hello world.</p>';
    document.execCommand = vi.fn(() => true);

    const range = document.createRange();
    range.selectNodeContents(preview.firstChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
  });

  afterEach(() => {
    focusSpy.mockRestore();
  });

  it('focuses the off-screen paste-scratch clone with { preventScroll: true }', () => {
    const event = new Event('paste', { cancelable: true });
    event.clipboardData = {
      getData: (type) => (type === 'text/html' ? '<p>pasted</p>' : 'pasted'),
    };
    preview.dispatchEvent(event);

    const scratchFocusCall = focusSpy.mock.calls.find(
      ([opts]) => opts && opts.preventScroll === true
    );
    expect(scratchFocusCall).toBeDefined();
  });
});
