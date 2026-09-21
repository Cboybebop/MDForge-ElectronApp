// DOC-07's depth-10 reopen stack -- the last N closed documents, LIFO,
// restoring file path, content and dirty state, but NEVER undo history
// (05-CONTEXT.md "Document Model & Tab State": "keeps a stack of the last
// 10 closed documents, restoring file path, content and dirty state — but
// not undo history"). A textarea's undo buffer is browser-owned and cannot
// be serialised; a reopened document always gets a brand-new <textarea>
// with an empty native undo stack. This module makes no attempt to
// preserve or fake undo history, and callers must not imply otherwise.
//
// Private module-level state, exposed only via pushClosed()/popClosed() --
// the same getter/setter-only discipline as preview/selection.js's
// savedSelection (05-PATTERNS.md Pattern Assignment for this exact file):
// no bare exported array, ever.
let closedStack = []; // oldest first, most-recently-closed last

const MAX_DEPTH = 10;

// entry shape: { filePath, content, dirty }
export function pushClosed(entry) {
  closedStack.push(entry);
  if (closedStack.length > MAX_DEPTH) closedStack.shift(); // evict oldest
}

// Returns undefined on an empty stack -- DOC-07's "silent no-op" contract
// (Ctrl+Shift+T with nothing to reopen does nothing, no error, no new tab).
export function popClosed() {
  return closedStack.pop();
}
