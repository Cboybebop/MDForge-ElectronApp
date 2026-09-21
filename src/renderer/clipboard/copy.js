// Shared clipboard write helper — ported from index.html:802-823
// (`copyRichContent`), shared by both the Confluence and Word copy paths.

import { showStatus } from '../status.js';

// Ports index.html:802-823 exactly.
export async function copyRichContent(html, plainText, successMessage, fallbackMessage) {
  if (!html.trim()) {
    showStatus('Nothing to copy', 'error');
    return;
  }

  try {
    const htmlBlob = new Blob([html], { type: 'text/html' });
    const textBlob = new Blob([plainText], { type: 'text/plain' });
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
    ]);
    showStatus(successMessage, 'copied');
  } catch (e) {
    try {
      await navigator.clipboard.writeText(plainText);
      showStatus(fallbackMessage, 'copied', 3500);
    } catch {
      showStatus('Copy failed — check clipboard permissions', 'error', 3500);
    }
  }
}
