// @vitest-environment jsdom
//
// Unit tests for setLeftPaneWidth()'s clamping logic (SYNC-06). Covers the
// 20-80% clamp and the #split-width value mirror per index.html:892-899.

import { describe, it, expect, beforeEach } from 'vitest';
import { setLeftPaneWidth } from './split.js';

function setupDom() {
  document.body.innerHTML = `
    <div id="left-pane"></div>
    <div id="right-pane"></div>
    <input id="split-width" type="range" min="20" max="80" />
  `;
}

describe('setLeftPaneWidth', () => {
  beforeEach(() => {
    setupDom();
  });

  it('sets the left pane to 50% and the right pane to 50%', () => {
    setLeftPaneWidth(50);
    expect(document.getElementById('left-pane').style.width).toBe('50%');
    expect(document.getElementById('right-pane').style.width).toBe('50%');
  });

  it('clamps 5 to 20 (never below 20%)', () => {
    setLeftPaneWidth(5);
    expect(document.getElementById('left-pane').style.width).toBe('20%');
    expect(document.getElementById('right-pane').style.width).toBe('80%');
  });

  it('clamps 95 to 80 (never above 80%)', () => {
    setLeftPaneWidth(95);
    expect(document.getElementById('left-pane').style.width).toBe('80%');
    expect(document.getElementById('right-pane').style.width).toBe('20%');
  });

  it('writes the rounded percent into #split-width.value', () => {
    setLeftPaneWidth(50);
    expect(document.getElementById('split-width').value).toBe('50');
  });
});
