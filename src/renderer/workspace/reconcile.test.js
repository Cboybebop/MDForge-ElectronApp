// @vitest-environment jsdom
//
// Unit tests for the reconciliation controller (WORK-04/05/06). Uses
// documents.js's REAL Map (same "build the DOM fixture BEFORE importing"
// pattern documents.test.js established) so every dirty/active-scoping
// assertion below exercises the real state machine, not a stub of it.
// tabs/tab-bar.js (renderTabBar), files/save.js (saveFileAs),
// markdown/render.js (renderMarkdown) and status.js (showStatus) are
// mocked wholesale -- this file's job is reconcile.js's own decision
// logic, not any of those four modules' own behavior (each already has its
// own test file).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../tabs/tab-bar.js', () => ({
  renderTabBar: vi.fn(),
}));

vi.mock('../files/save.js', () => ({
  saveFileAs: vi.fn(),
}));

vi.mock('../markdown/render.js', () => ({
  renderMarkdown: vi.fn(),
}));

vi.mock('../status.js', () => ({
  showStatus: vi.fn(),
}));

let documents;
let reconcile;
let renderTabBarMock;
let saveFileAsMock;
let renderMarkdownMock;
let showStatusMock;
let mdforgeOpenAtPath;
let mdforgeAcknowledge;

// Flushes the microtask queue so an async click handler's own awaited
// promises have settled before assertions run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <textarea id="md-input" spellcheck="false" placeholder="Start typing..."></textarea>
    </div>
    <div id="preview" contenteditable="true"></div>
    <input type="checkbox" id="toggle-sync-scroll" checked />
    <div id="external-change-banner" class="hidden" role="alert">
      <span id="external-change-banner-text"></span>
      <div class="banner-actions">
        <button id="external-change-keep-mine" type="button">Keep Mine</button>
        <button id="external-change-reload-theirs" type="button">Reload Theirs</button>
        <button id="external-change-save-copy" type="button">Save As Copy</button>
      </div>
    </div>
  `;

  window.mdforge = {
    openAtPath: (...args) => mdforgeOpenAtPath(...args),
    acknowledgeExternalChange: (...args) => mdforgeAcknowledge(...args),
    onWorkspaceFileChanged: vi.fn(),
    onWorkspaceFileVanished: vi.fn(),
    setWindowTitleInfo: vi.fn(),
  };

  documents = await import('../documents.js');
  reconcile = await import('./reconcile.js');
  ({ renderTabBar: renderTabBarMock } = await import('../tabs/tab-bar.js'));
  ({ saveFileAs: saveFileAsMock } = await import('../files/save.js'));
  ({ renderMarkdown: renderMarkdownMock } = await import('../markdown/render.js'));
  ({ showStatus: showStatusMock } = await import('../status.js'));
});

beforeEach(() => {
  mdforgeOpenAtPath = vi.fn(async (path) => ({ path, text: `reloaded:${path}`, name: 'x' }));
  mdforgeAcknowledge = vi.fn(async () => ({ ok: true }));
  renderTabBarMock.mockClear();
  saveFileAsMock.mockClear();
  renderMarkdownMock.mockClear();
  showStatusMock.mockClear();
  document.getElementById('external-change-banner').classList.add('hidden');
});

describe('handleExternalChange', () => {
  it('no-ops when no open document matches the changed path', async () => {
    await reconcile.handleExternalChange({ path: 'C:\\nope\\ghost.md' });

    expect(mdforgeOpenAtPath).not.toHaveBeenCalled();
    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(true);
  });

  it('reloads a CLEAN active document silently -- no banner, re-renders the preview', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\clean.md', initialContent: 'old' });
    documents.setActiveDocId(docId);

    await reconcile.handleExternalChange({ path: 'C:\\notes\\clean.md' });

    expect(documents.getDocumentContent(docId)).toBe('reloaded:C:\\notes\\clean.md');
    expect(renderMarkdownMock).toHaveBeenCalledWith('reloaded:C:\\notes\\clean.md');
    expect(documents.isDocumentDirty(docId)).toBe(false);
    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(true);

    documents.closeDocument(docId);
  });

  it('reloads a CLEAN non-active document silently without touching the preview', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\background.md', initialContent: 'old' });
    // Deliberately not activated -- stays a background document.

    await reconcile.handleExternalChange({ path: 'C:\\notes\\background.md' });

    expect(documents.getDocumentContent(docId)).toBe('reloaded:C:\\notes\\background.md');
    expect(renderMarkdownMock).not.toHaveBeenCalled();

    documents.closeDocument(docId);
  });

  it('WR-01: the silent-reload path clears `.missing` -- covers a deleted-then-recreated file reloading into a clean tab', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\recreated.md', initialContent: 'old' });
    documents.setActiveDocId(docId);
    documents.setDocumentMissing(docId, true);
    expect(documents.getDocument(docId).missing).toBe(true);

    await reconcile.handleExternalChange({ path: 'C:\\notes\\recreated.md' });

    expect(documents.getDocument(docId).missing).toBe(false);

    documents.closeDocument(docId);
  });

  it('shows the banner immediately for a DIRTY ACTIVE document, with the exact copy, and focuses Reload Theirs', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\dirty.md', initialContent: 'mine' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);

    await reconcile.handleExternalChange({ path: 'C:\\notes\\dirty.md' });

    const banner = document.getElementById('external-change-banner');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('external-change-banner-text').textContent).toBe(
      'dirty.md changed on disk. Your unsaved edits here are safe.'
    );
    expect(document.activeElement.id).toBe('external-change-reload-theirs');
    // The silent-reload path must never run for a dirty document.
    expect(mdforgeOpenAtPath).not.toHaveBeenCalled();
    // Content must be untouched -- nothing was discarded just by showing the banner.
    expect(documents.getDocumentContent(docId)).toBe('mine');

    documents.closeDocument(docId);
  });

  it('CR-01: never overwrites a document that becomes dirty during the silent-reload IPC await', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\race.md', initialContent: 'old' });
    documents.setActiveDocId(docId);

    // Simulates a keystroke landing in the exact gap between the initial
    // dirty check and the IPC round trip's resolution: the mocked
    // openAtPath only resolves AFTER the document has been typed into and
    // marked dirty, mirroring markDocumentDirty's real synchronous firing
    // on every native `input` event. [12-11] A REAL dispatched transaction
    // against the active editor, not replaceDocumentContent -- this must
    // represent genuine concurrent user input (with its own undo entry),
    // not a deliberate reset, or the test would misrepresent what it proves.
    mdforgeOpenAtPath = vi.fn(
      (path) =>
        new Promise((resolve) => {
          const view = documents.getActiveEditor();
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: 'typed during the race' },
          });
          documents.markDocumentDirty(docId);
          resolve({ path, text: `reloaded:${path}`, name: 'x' });
        })
    );

    await reconcile.handleExternalChange({ path: 'C:\\notes\\race.md' });

    // The freshly-typed keystroke must survive -- never silently discarded
    // by the reload that was already in flight when it landed.
    expect(documents.getDocumentContent(docId)).toBe('typed during the race');
    // The user must get the same three-way choice a dirty document always
    // gets, not a silent overwrite with no banner and no recovery path.
    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(false);

    documents.closeDocument(docId);
  });

  it('defers the banner for a DIRTY BACKGROUND document until its tab becomes active', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\background-dirty.md', initialContent: 'mine' });
    documents.markDocumentDirty(docId);
    // Deliberately not activated.

    await reconcile.handleExternalChange({ path: 'C:\\notes\\background-dirty.md' });

    const banner = document.getElementById('external-change-banner');
    expect(banner.classList.contains('hidden')).toBe(true);

    reconcile.checkPendingBannerForActiveDoc(docId);
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('external-change-banner-text').textContent).toContain('background-dirty.md');

    // The pending flag was consumed -- a second check for the same docId
    // must not re-show it again after it has already been dismissed.
    banner.classList.add('hidden');
    reconcile.checkPendingBannerForActiveDoc(docId);
    expect(banner.classList.contains('hidden')).toBe(true);

    documents.closeDocument(docId);
  });
});

describe('external-change banner actions', () => {
  it('Keep Mine dismisses the banner, leaves content and dirty state untouched, and acknowledges via IPC', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\keep.md', initialContent: 'mine intact' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);
    await reconcile.handleExternalChange({ path: 'C:\\notes\\keep.md' });

    document.getElementById('external-change-keep-mine').click();
    await flush();

    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(true);
    expect(documents.getDocumentContent(docId)).toBe('mine intact');
    expect(documents.isDocumentDirty(docId)).toBe(true);
    expect(mdforgeAcknowledge).toHaveBeenCalledWith('C:\\notes\\keep.md');

    documents.closeDocument(docId);
  });

  it('Reload Theirs reloads content, marks the document clean, and dismisses', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\reload.md', initialContent: 'mine' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);
    await reconcile.handleExternalChange({ path: 'C:\\notes\\reload.md' });

    document.getElementById('external-change-reload-theirs').click();
    await flush();

    expect(documents.getDocumentContent(docId)).toBe('reloaded:C:\\notes\\reload.md');
    expect(documents.isDocumentDirty(docId)).toBe(false);
    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(true);

    documents.closeDocument(docId);
  });

  it('WR-01 (12-REVIEW.md): never overwrites content typed while a Reload Theirs IPC round trip is still in flight', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\race2.md', initialContent: 'mine' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);
    await reconcile.handleExternalChange({ path: 'C:\\notes\\race2.md' }); // shows the banner

    // Simulates a keystroke landing in the gap between capturing this
    // document's pre-reload content and the IPC round trip resolving --
    // mirrors CR-01's own race test above, but for the Reload Theirs BUTTON
    // path rather than the silent-reload path.
    mdforgeOpenAtPath = vi.fn(
      (path) =>
        new Promise((resolve) => {
          const view = documents.getActiveEditor();
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: 'typed during reload-theirs race' },
          });
          resolve({ path, text: `reloaded:${path}`, name: 'x' });
        })
    );

    document.getElementById('external-change-reload-theirs').click();
    await flush();

    // The freshly-typed keystroke must survive -- never silently clobbered
    // by the reload that was already in flight when it landed.
    expect(documents.getDocumentContent(docId)).toBe('typed during reload-theirs race');
    // The conflict is not silently resolved -- the banner reappears so the
    // user can choose again against the now-current content.
    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(false);

    documents.closeDocument(docId);
  });

  it('WR-01: Reload Theirs also clears `.missing`', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\reload-missing.md', initialContent: 'mine' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);
    documents.setDocumentMissing(docId, true);
    await reconcile.handleExternalChange({ path: 'C:\\notes\\reload-missing.md' });

    document.getElementById('external-change-reload-theirs').click();
    await flush();

    expect(documents.getDocument(docId).missing).toBe(false);

    documents.closeDocument(docId);
  });

  it('Save As Copy computes the sibling filename, saves, and dismisses only once the document is clean', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\roadmap.md', initialContent: 'mine' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);
    await reconcile.handleExternalChange({ path: 'C:\\notes\\roadmap.md' });

    saveFileAsMock.mockImplementationOnce(async (id) => {
      documents.markDocumentClean(id);
    });

    document.getElementById('external-change-save-copy').click();
    await flush();

    expect(saveFileAsMock).toHaveBeenCalledWith(docId, 'roadmap (copy).md');
    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(true);

    documents.closeDocument(docId);
  });

  it('Save As Copy leaves the banner open when the document is still dirty afterward (cancelled/failed save)', async () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\stay-open.md', initialContent: 'mine' });
    documents.setActiveDocId(docId);
    documents.markDocumentDirty(docId);
    await reconcile.handleExternalChange({ path: 'C:\\notes\\stay-open.md' });

    saveFileAsMock.mockImplementationOnce(async () => {}); // user canceled -- doc stays dirty

    document.getElementById('external-change-save-copy').click();
    await flush();

    expect(document.getElementById('external-change-banner').classList.contains('hidden')).toBe(false);
    expect(documents.isDocumentDirty(docId)).toBe(true);

    documents.closeDocument(docId);
  });
});

describe('handleExternalVanish', () => {
  it('marks a single vanished file missing, re-renders the tab bar, and toasts exactly once', () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\gone.md', initialContent: 'x' });

    reconcile.handleExternalVanish({ path: 'C:\\notes\\gone.md', isDirectory: false });

    expect(documents.getDocument(docId).missing).toBe(true);
    expect(renderTabBarMock).toHaveBeenCalledTimes(1);
    expect(showStatusMock).toHaveBeenCalledWith('gone.md was deleted outside MD Forge — still open here.', 'copied');
    // Never discards content just because the file vanished (T-7-13).
    expect(documents.getDocumentContent(docId)).toBe('x');
    expect(documents.isDocumentDirty(docId)).toBe(false);

    documents.closeDocument(docId);
  });

  it('no-ops for a vanished path with no open document', () => {
    reconcile.handleExternalVanish({ path: 'C:\\notes\\nobody-has-this.md', isDirectory: false });

    expect(renderTabBarMock).not.toHaveBeenCalled();
    expect(showStatusMock).not.toHaveBeenCalled();
  });

  it('never re-toasts the same docId for a repeated vanish event on the same path', () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\repeat.md', initialContent: 'x' });

    reconcile.handleExternalVanish({ path: 'C:\\notes\\repeat.md', isDirectory: false });
    reconcile.handleExternalVanish({ path: 'C:\\notes\\repeat.md', isDirectory: false });

    expect(showStatusMock).toHaveBeenCalledTimes(1);

    documents.closeDocument(docId);
  });

  it('treats a missing isDirectory as false (single-file) rather than throwing', () => {
    const docId = documents.createDocument({ filePath: 'C:\\notes\\undefined-kind.md', initialContent: 'x' });

    expect(() => reconcile.handleExternalVanish({ path: 'C:\\notes\\undefined-kind.md' })).not.toThrow();
    expect(documents.getDocument(docId).missing).toBe(true);

    documents.closeDocument(docId);
  });

  it('cascades missing across a vanished DIRECTORY while sparing a sibling with a colliding name prefix (notes vs notes2)', () => {
    const aId = documents.createDocument({ filePath: 'C:\\notes\\a.md', initialContent: 'a' });
    const bId = documents.createDocument({ filePath: 'C:\\notes\\b.md', initialContent: 'b' });
    const cId = documents.createDocument({ filePath: 'C:\\notes2\\c.md', initialContent: 'c' });

    reconcile.handleExternalVanish({ path: 'C:\\notes', isDirectory: true });

    expect(documents.getDocument(aId).missing).toBe(true);
    expect(documents.getDocument(bId).missing).toBe(true);
    // The deliberate collision trap: notes2 must NEVER be swept in by a
    // bare substring/startsWith("notes") check.
    expect(documents.getDocument(cId).missing).toBe(false);

    documents.closeDocument(aId);
    documents.closeDocument(bId);
    documents.closeDocument(cId);
  });

  it('WR-02: cascades missing across a vanished DIRECTORY even when a doc.filePath carries different casing', () => {
    const aId = documents.createDocument({ filePath: 'C:\\Notes\\A.MD', initialContent: 'a' });
    const cId = documents.createDocument({ filePath: 'C:\\notes2\\c.md', initialContent: 'c' });

    reconcile.handleExternalVanish({ path: 'c:\\notes', isDirectory: true });

    expect(documents.getDocument(aId).missing).toBe(true);
    // The sibling-collision guarantee must survive the case-insensitivity
    // fix -- notes2 is still never swept in.
    expect(documents.getDocument(cId).missing).toBe(false);

    documents.closeDocument(aId);
    documents.closeDocument(cId);
  });
});
