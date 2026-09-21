// @vitest-environment jsdom
//
// Unit tests proving 05-08-PLAN.md's own load-bearing acceptance criteria:
// saveFile(docId)/saveFileAs(docId) accept an EXPLICIT docId (defaulting to
// the active document), reading THAT document's own surface/filePath from
// documents.js's Map -- so a non-active dirty document can be saved
// directly. This is the exact capability 05-12's aggregated quit dialog's
// Save-All loop depends on (it calls saveFile(docId)/saveFileAs(docId)
// once per dirty document, not just the active one).
//
// documents.js self-wires its bootstrap document at module-load time --
// same "build the DOM fixture BEFORE importing" pattern documents.test.js/
// editor-events.test.js already established.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../command-dispatch.js', () => ({
  registerCommand: vi.fn(),
}));

vi.mock('./conflict-dialog.js', () => ({
  showConflictDialog: vi.fn(),
}));

vi.mock('../markdown/render.js', () => ({
  renderMarkdown: vi.fn(),
}));

vi.mock('../status.js', () => ({
  showStatus: vi.fn(),
}));

let documents;
let saveFile;
let saveFileAs;
let showConflictDialogMock;
let showStatusMock;
let mdforgeSaveFile;
let mdforgeSaveFileAs;
let mdforgeOpenAtPath;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="left-pane">
      <textarea id="md-input" spellcheck="false" placeholder="Start typing..."></textarea>
    </div>
    <div id="preview" contenteditable="true"></div>
    <input type="checkbox" id="toggle-sync-scroll" checked />
    <button id="btn-save"></button>
    <button id="btn-save-as"></button>
  `;

  window.mdforge = {
    saveFile: (...args) => mdforgeSaveFile(...args),
    saveFileAs: (...args) => mdforgeSaveFileAs(...args),
    openAtPath: (...args) => mdforgeOpenAtPath(...args),
    revealInExplorer: vi.fn(),
    setWindowTitleInfo: vi.fn(),
    // [06-08] save.js's success branches call this on every successful
    // save/save-as path resolution -- stubbed here so the existing suite
    // doesn't throw on an unmocked bridge method.
    addRecentDocument: vi.fn(),
  };

  documents = await import('../documents.js');
  ({ saveFile, saveFileAs } = await import('./save.js'));
  ({ showConflictDialog: showConflictDialogMock } = await import('./conflict-dialog.js'));
  ({ showStatus: showStatusMock } = await import('../status.js'));
});

beforeEach(() => {
  mdforgeSaveFile = vi.fn(async () => ({ ok: true }));
  mdforgeSaveFileAs = vi.fn(async () => ({ ok: true, path: 'C:\\scratch\\new.md', name: 'new.md' }));
  mdforgeOpenAtPath = vi.fn(async (path) => ({ path, text: `reloaded:${path}`, name: 'x' }));
  showConflictDialogMock.mockReset();
  showStatusMock.mockClear();
});

describe('saveFile(docId)', () => {
  it("saves a NON-active document's own content to its own path, never the active document's", async () => {
    const activeId = documents.getActiveDocId();
    documents.replaceDocumentContent(activeId, 'active document content');
    documents.setDocumentFilePath(activeId, 'C:\\scratch\\active.md');

    const otherId = documents.createDocument({ initialContent: 'inactive document content' });
    documents.setDocumentFilePath(otherId, 'C:\\scratch\\inactive.md');
    documents.markDocumentDirty(otherId);

    // Prove otherId is genuinely NOT the active document before saving it.
    expect(documents.getActiveDocId()).toBe(activeId);
    expect(documents.getActiveDocId()).not.toBe(otherId);

    await saveFile(otherId);

    expect(mdforgeSaveFile).toHaveBeenCalledTimes(1);
    expect(mdforgeSaveFile).toHaveBeenCalledWith(
      'C:\\scratch\\inactive.md',
      'inactive document content'
    );
    // The active document's own path/content were never touched.
    expect(mdforgeSaveFile).not.toHaveBeenCalledWith(
      'C:\\scratch\\active.md',
      expect.anything()
    );
    expect(documents.isDocumentDirty(otherId)).toBe(false);
    // The active document's dirty state is untouched by saving a different doc.
    expect(documents.getDocument(activeId).filePath).toBe('C:\\scratch\\active.md');

    documents.closeDocument(otherId); // cleanup
  });

  it('with no argument, resolves to the currently active document (backward-compatible default)', async () => {
    const activeId = documents.getActiveDocId();
    documents.replaceDocumentContent(activeId, 'default-arg content');
    documents.setDocumentFilePath(activeId, 'C:\\scratch\\default-arg.md');

    await saveFile();

    expect(mdforgeSaveFile).toHaveBeenCalledWith('C:\\scratch\\default-arg.md', 'default-arg content');
  });

  it('no-ops for a path-less (never-saved) document, active or not', async () => {
    const otherId = documents.createDocument({ initialContent: 'untitled content' });

    await saveFile(otherId);

    expect(mdforgeSaveFile).not.toHaveBeenCalled();

    documents.closeDocument(otherId); // cleanup
  });

  it('WR-01: a successful save clears a `.missing` tab -- 07-UI-SPEC.md Surface 4 Recovery contract', async () => {
    const otherId = documents.createDocument({ initialContent: 'recovered content' });
    documents.setDocumentFilePath(otherId, 'C:\\scratch\\missing.md');
    documents.markDocumentDirty(otherId);
    documents.setDocumentMissing(otherId, true);
    expect(documents.getDocument(otherId).missing).toBe(true);

    await saveFile(otherId);

    expect(documents.getDocument(otherId).missing).toBe(false);

    documents.closeDocument(otherId); // cleanup
  });
});

// [12-REVIEW.md WR-01] saveFile()'s 'reload-theirs' conflict branch calls
// replaceDocumentContent() after an `await window.mdforge.openAtPath()` IPC
// round trip with no re-check that the document was not switched-to and
// edited in the meantime -- a silent-data-loss TOCTOU window.
describe("saveFile(docId) -- Reload Theirs conflict branch (WR-01)", () => {
  it('never clobbers content typed while the reload IPC round trip is still in flight', async () => {
    const docId = documents.getActiveDocId();
    documents.replaceDocumentContent(docId, 'mine, dirty');
    documents.setDocumentFilePath(docId, 'C:\\scratch\\conflict.md');
    documents.markDocumentDirty(docId);

    mdforgeSaveFile = vi.fn(async () => ({ conflict: true }));
    showConflictDialogMock.mockResolvedValueOnce('reload-theirs');
    mdforgeOpenAtPath = vi.fn(
      (path) =>
        new Promise((resolve) => {
          const view = documents.getActiveEditor();
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: 'typed during save-reload race' },
          });
          resolve({ path, text: 'reloaded content', name: 'conflict.md' });
        })
    );

    await saveFile(docId);

    // The freshly-typed keystroke must survive -- never silently discarded
    // by the reload that was already in flight when it landed.
    expect(documents.getDocumentContent(docId)).toBe('typed during save-reload race');
    // The document is left dirty (never marked clean by a reload that was
    // abandoned) and the user is told why, rather than a silent no-op.
    expect(documents.isDocumentDirty(docId)).toBe(true);
    expect(showStatusMock).toHaveBeenCalledWith(
      expect.stringContaining('changed while reloading'),
      'error'
    );
  });

  it('reloads normally when nothing changed during the IPC round trip', async () => {
    const docId = documents.getActiveDocId();
    documents.replaceDocumentContent(docId, 'mine, dirty');
    documents.setDocumentFilePath(docId, 'C:\\scratch\\conflict2.md');
    documents.markDocumentDirty(docId);

    mdforgeSaveFile = vi.fn(async () => ({ conflict: true }));
    showConflictDialogMock.mockResolvedValueOnce('reload-theirs');
    mdforgeOpenAtPath = vi.fn(async (path) => ({ path, text: 'reloaded content', name: 'conflict2.md' }));

    await saveFile(docId);

    expect(documents.getDocumentContent(docId)).toBe('reloaded content');
    expect(documents.isDocumentDirty(docId)).toBe(false);
  });
});

describe('saveFileAs(docId)', () => {
  it("Save-As a NON-active document writes THAT document's own content via the native dialog result", async () => {
    const activeId = documents.getActiveDocId();
    documents.replaceDocumentContent(activeId, 'active content, must not leak');

    const otherId = documents.createDocument({ initialContent: 'save-as target content' });
    documents.markDocumentDirty(otherId);

    await saveFileAs(otherId);

    // [07-09] saveFileAs's second (optional) suggestedName parameter now
    // threads through to window.mdforge.saveFileAs as an explicit second
    // argument -- this call site omits it, so it resolves to `null`.
    expect(mdforgeSaveFileAs).toHaveBeenCalledWith('save-as target content', null);
    expect(documents.getDocument(otherId).filePath).toBe('C:\\scratch\\new.md');
    expect(documents.isDocumentDirty(otherId)).toBe(false);

    documents.closeDocument(otherId); // cleanup
  });

  it('WR-01: a successful Save As also clears `.missing` -- the newly-written path genuinely exists', async () => {
    const otherId = documents.createDocument({ initialContent: 'save-as target content' });
    documents.markDocumentDirty(otherId);
    documents.setDocumentMissing(otherId, true);

    await saveFileAs(otherId);

    expect(documents.getDocument(otherId).missing).toBe(false);

    documents.closeDocument(otherId); // cleanup
  });
});

// [12-REVIEW.md WR-01] saveFileAs()'s 'reload-theirs' conflict branch is the
// identical shape to saveFile()'s own -- same TOCTOU window, same fix.
describe("saveFileAs(docId) -- Reload Theirs conflict branch (WR-01)", () => {
  it('never clobbers content typed while the reload IPC round trip is still in flight', async () => {
    const docId = documents.getActiveDocId();
    documents.replaceDocumentContent(docId, 'mine, dirty');
    documents.markDocumentDirty(docId);

    mdforgeSaveFileAs = vi.fn(async () => ({ conflict: true, path: 'C:\\scratch\\as-conflict.md' }));
    showConflictDialogMock.mockResolvedValueOnce('reload-theirs');
    mdforgeOpenAtPath = vi.fn(
      (path) =>
        new Promise((resolve) => {
          const view = documents.getActiveEditor();
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: 'typed during save-as-reload race' },
          });
          resolve({ path, text: 'reloaded content', name: 'as-conflict.md' });
        })
    );

    await saveFileAs(docId);

    expect(documents.getDocumentContent(docId)).toBe('typed during save-as-reload race');
    expect(documents.isDocumentDirty(docId)).toBe(true);
    // The document must NOT have been silently re-pathed/renamed by the
    // abandoned reload either.
    expect(documents.getDocument(docId).filePath).not.toBe('C:\\scratch\\as-conflict.md');
    expect(showStatusMock).toHaveBeenCalledWith(
      expect.stringContaining('changed while reloading'),
      'error'
    );
  });
});
