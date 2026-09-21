// Formatting toolbar wiring — ported from index.html:1139-1154
// (format button / link / block-select wiring).

// `updateFormatState` is deliberately NOT imported here: runFormatCommand
// already invokes it internally after every command, and events.js invokes it
// on keyup/mouseup. This file has no call site of its own.
import { runFormatCommand } from './format.js';
import { restorePreviewSelection } from './selection.js';

const formatButtons = document.querySelectorAll('.format-btn[data-command]');
const btnLink = document.getElementById('btn-link');
const formatBlock = document.getElementById('format-block');

// Ports index.html:1139-1142 exactly.
formatButtons.forEach(button => {
  button.addEventListener('mousedown', e => e.preventDefault());
  button.addEventListener('click', () => runFormatCommand(button.dataset.command));
});

// Ports index.html:1144-1150 exactly.
btnLink.addEventListener('mousedown', e => e.preventDefault());
btnLink.addEventListener('click', () => {
  restorePreviewSelection();
  const href = prompt('Link URL');
  if (!href) return;
  runFormatCommand('createLink', href);
});

// Ports index.html:1152-1154 exactly.
formatBlock.addEventListener('change', () => {
  runFormatCommand('formatBlock', `<${formatBlock.value}>`);
});
