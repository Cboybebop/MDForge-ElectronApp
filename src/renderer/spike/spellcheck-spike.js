// Phase 9 decision-gate measurement harness (09-CONTEXT.md, 09-01-PLAN.md
// Task 3). Mounts a BARE CodeMirror 6 EditorView -- no basicSetup, no theme,
// no custom keymap, no syntax highlighting -- so the spike isolates "does
// CM6's contenteditable host receive Chromium's native spellcheck" from "does
// our eventual extension set interfere" (CONTEXT.md Area 2). Deliberately
// imports ONLY EditorState and EditorView; @codemirror/commands,
// @codemirror/lang-markdown and @codemirror/language are installed now for
// Phase 12 (per CONTEXT.md's locked dependency decision) but must not be
// exercised by this bare view.
//
// This module, and spike-spellcheck.html, are PERMANENT (09-01-PLAN.md's
// revision note) -- they stay in the repo and in every `npm run build`
// output so 09-02-PLAN.md's regression spec always has a real harness to
// launch Playwright against. Only the packaged installer excludes them
// (09-03-PLAN.md Task 2, via electron-builder.yml).
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

// EditorView.contentAttributes.of(...) is the exact mechanism the
// discuss.codemirror.net report itself used to set spellcheck/lang
// (09-RESEARCH.md Pattern 3) -- reusing it means this spike measures the
// same configuration surface the upstream report was built against.
// spellcheck is set to the explicit string 'true' rather than assumed,
// since CM6 manages this attribute itself and the explicit value is part
// of what this phase measures (CONTEXT.md Area 2).
function mountSpike (parent, initialDoc = '') {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      EditorView.contentAttributes.of({ spellcheck: 'true', lang: 'en-US' })
    ]
  })
  return new EditorView({ state, parent })
}

const mountPoint = document.getElementById('spike-mount')
const view = mountSpike(mountPoint)

// Deliberate test-only globals -- narrow, named seams matching this
// codebase's existing precedent (window.mdforge) rather than a broader
// capability (09-01-PLAN.md threat model, T-9-03: accepted).
window.__spikeView = view

// Orchestrator-directed addition (2026-09-14): expose the two control
// surfaces (see spike-spellcheck.html) under the same narrow-global
// convention, for tests/e2e/spellcheck-spike.spec.js's three-way control
// measurement. Both elements are plain DOM -- no mounting logic needed,
// just a named seam matching window.__spikeView above.
window.__spikeControlTextarea = document.getElementById('spike-control-textarea')
window.__spikeControlContentEditable = document.getElementById('spike-control-contenteditable')

// window.mdforge.openAtPath is the existing preload bridge method
// (src/preload/index.js), confirmed to invoke the real 'file:open-path' IPC
// channel handled by src/main/text-file.js -- the file-opened measurement
// case must go through the real open pipeline, never a paste/clipboard
// shortcut into the view (CONTEXT.md Area 2).
window.__spikeOpenFile = async (filePath) => {
  const result = await window.mdforge.openAtPath(filePath)
  if (!result || result.error) {
    return result
  }
  // src/main/text-file.js's readTextFile() returns {path, text, name,
  // mtimeMs, size} on success -- the field is `text`, not `content`.
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text }
  })
  return result
}

// [09-02, Rule 3 auto-fix] src/main/before-quit.js's app.on('before-quit')
// handler unconditionally calls event.preventDefault() and then sends
// 'app:query-dirty-state', waiting indefinitely for a renderer response over
// 'app:dirty-documents' (see quit-handshake.js's real onQueryDirtyState for
// the normal-page equivalent). This spike page never loads quit-handshake.js
// -- once Playwright's e2e helper navigates the app's single window here
// (navigateToSpikePage), any subsequent app.close()/app.quit() would hang
// forever, since nothing ever answers that query. Discovered empirically:
// app.close() took ~80s (eventually forced) against the un-patched spike
// page, vs ~1s for the real index.html. The spike tracks no documents at
// all, so the correct, honest answer is always an empty dirty list --
// mirrors quit-handshake.js's own shape (onQueryDirtyState -> sendDirtyDocuments)
// with no draft-flush step, since the spike never creates drafts either.
window.mdforge.onQueryDirtyState(() => {
  window.mdforge.sendDirtyDocuments([])
})

export { mountSpike }
