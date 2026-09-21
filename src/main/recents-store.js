// Capped, deduped recent-documents/recent-folders store over
// `electron-store`, plus the Windows shell integration CONTEXT.md locks
// alongside it: `app.addRecentDocument()` for documents and a custom
// `app.setJumpList()` "Recent Folders" task-type category for folders. See
// 06-CONTEXT.md "Recent Documents & Folders (PERS-07)" and 06-RESEARCH.md
// Pitfall 5 (the Jump List's on-screen appearance is coupled to Phase 8's
// still-unresolved .md file-association spike -- this module builds and
// CALLS the mechanism; it does not, and cannot, prove its on-screen
// appearance pre-Phase-8).
//
// Both lists are most-recent-first, capped at 10 (CONTEXT.md-locked).
// Eviction end is the opposite of closed-stack.js's oldest-evicted-via-shift
// discipline: new entries are unshifted to the front, and anything past the
// cap is popped from the end.
import { app, ipcMain } from 'electron'
import Store from 'electron-store'
import path from 'node:path'

const MAX_ENTRIES = 10

// [WR-02, 06-REVIEW.md] Not a traversal check (no fs read/write happens on
// this path -- `app.addRecentDocument`/`app.clearRecentDocuments` are
// Windows-shell registration calls, not file access), but this codebase's
// own established discipline (06-RESEARCH.md Security Domain: "every
// renderer-supplied payload crossing an IPC boundary into a native call
// must be re-validated main-side") still applies. An oversized or
// malformed string would otherwise reach `path.basename()` in menu.js's
// label rendering and the native Windows Recent Items API with no upper
// bound at all.
const MAX_PATH_LENGTH = 4096

function isPlausiblePath (filePath) {
  return typeof filePath === 'string' && filePath.length > 0 && filePath.length <= MAX_PATH_LENGTH
}

const store = new Store({ defaults: { documents: [], folders: [] } })

// File-private, NOT exported and NOT shared with restore-plan.js's own
// equivalent (06-03, a separate parallel Wave 1 plan): path-guard.js
// deliberately avoids path normalization (traversal-detection reasons), so
// there is no existing shared helper to reuse. Lowercases and collapses
// backslash/forward-slash separators for a case-insensitive, Windows-first
// comparison.
function normalizeForDedup (filePath) {
  return String(filePath).toLowerCase().replace(/[\\/]+/g, '/')
}

// Removes any existing entry matching `filePath` (by normalizeForDedup),
// unshifts the new path to the front, and pops from the end once the list
// exceeds MAX_ENTRIES. Returns the new list; does not persist -- callers
// persist via store.set.
function addToCappedList (list, filePath) {
  const key = normalizeForDedup(filePath)
  const next = [filePath, ...list.filter((entry) => normalizeForDedup(entry) !== key)]
  if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES
  return next
}

function removeFromList (list, filePath) {
  const key = normalizeForDedup(filePath)
  return list.filter((entry) => normalizeForDedup(entry) !== key)
}

// File-private. Rebuilds the Windows Jump List's custom "Recent Folders"
// category from the current `folders` list. Per 06-RESEARCH.md Pitfall 5,
// folder items MUST be `type: 'task'`, never `type: 'file'` -- a folder has
// no file-type registration path at all, and `type: 'file'` items can
// return a fileTypeRegistrationError status for an unregistered extension.
// An empty `items` array (the expected, correct pre-Phase-7 state) is a
// valid, harmless call. Wrapped in try/catch: log, never throw.
function rebuildJumpList () {
  try {
    const folders = store.get('folders')
    app.setJumpList([
      {
        type: 'custom',
        name: 'Recent Folders',
        items: folders.map((f) => ({
          type: 'task',
          title: path.basename(f),
          program: process.execPath,
          args: f,
          description: f
        }))
      }
    ])
  } catch (err) {
    console.error('rebuildJumpList failed:', err)
  }
}

function addRecentDocument (filePath) {
  const documents = addToCappedList(store.get('documents'), filePath)
  store.set('documents', documents)
  app.addRecentDocument(filePath)
}

// Not called by anything else in this phase's own scope -- CONTEXT.md:
// folders stay empty/hidden in the menu until Phase 7 supplies
// folder-opening. Exists now so the data layer AND the Jump List category
// are both whole, per CONTEXT.md's explicit instruction.
function addRecentFolder (filePath) {
  const folders = addToCappedList(store.get('folders'), filePath)
  store.set('folders', folders)
  rebuildJumpList()
}

// Electron has no single-entry-removal API for the native recent-documents
// list -- app.clearRecentDocuments() followed by re-adding every REMAINING
// entry in order is the correct, only way to remove one entry from it.
function pruneDocument (filePath) {
  const documents = removeFromList(store.get('documents'), filePath)
  store.set('documents', documents)
  app.clearRecentDocuments()
  for (const doc of documents) app.addRecentDocument(doc)
}

function pruneFolder (filePath) {
  const folders = removeFromList(store.get('folders'), filePath)
  store.set('folders', folders)
  rebuildJumpList()
}

function clearAll () {
  store.set({ documents: [], folders: [] })
  app.clearRecentDocuments()
  rebuildJumpList()
}

function getRecents () {
  return { documents: store.get('documents'), folders: store.get('folders') }
}

// `onChanged` is a caller-supplied callback (06-06's menu-rebuild function)
// invoked after every mutating call below, so the caller can rebuild the
// native File > Open Recent submenu without this module importing menu.js.
//
// Calls rebuildJumpList() ONCE as its own first statement -- this guarantees
// the Jump List category is set at least once on every launch, regardless
// of whether any folder has ever been added yet, closing the "the call must
// exist" requirement even in the common zero-folders case.
//
// Same win-passed-explicitly discipline as theme-store.js's registerThemeIpc
// even though this module's own listeners do not close over `win` today --
// kept for signature consistency with the codebase's established
// `registerXIpc(win)` convention and so a future folder-opening handler
// (Phase 7) has it available.
function registerRecentsIpc (win, onChanged) {
  rebuildJumpList()

  // [WR-02, 06-REVIEW.md] Both handlers re-validate filePath before ever
  // touching the store or calling a native API -- a no-op (no mutation,
  // no onChanged() call) on anything that fails isPlausiblePath(), never a
  // throw, since a malformed value here is not attacker-shaped enough to
  // warrant CR-02's harder "reject and log" treatment; it just must not be
  // trusted blindly.
  ipcMain.handle('recents:add-document', (_event, filePath) => {
    if (!isPlausiblePath(filePath)) return getRecents()
    addRecentDocument(filePath)
    onChanged()
    return getRecents()
  })

  ipcMain.handle('recents:report-open-failure', (_event, filePath) => {
    if (!isPlausiblePath(filePath)) return getRecents()
    pruneDocument(filePath)
    onChanged()
    return getRecents()
  })
}

export {
  addRecentDocument,
  addRecentFolder,
  pruneDocument,
  pruneFolder,
  clearAll,
  getRecents,
  registerRecentsIpc,
  store
}
