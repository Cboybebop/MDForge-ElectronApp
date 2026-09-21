// Serialise/rehydrate a single CM6 tab's undo history via CM6's OWN
// `EditorState.toJSON`/`fromJSON` with the history field -- per
// 15-CONTEXT.md's locked decision, "do not hand-roll a history format".
//
// Pure composition, no I/O -- mirrors restore-plan.js's own "ordering/dedup
// only, not validation... err, in this case: validation only, no I/O" -- this
// module takes already-resolved values as parameters (a real EditorState to
// serialize; a JSON string + the current document text to restore against)
// and never imports documents.js or anything Electron/IPC-shaped.
//
// The non-negotiable this module exists to satisfy (15-CONTEXT.md, Area 2):
// "Every failure path degrades to empty history, never to a failed restore,
// and never to a wrong document." Every one of restoreHistoryState's guard
// steps below independently returns null rather than throwing or guessing --
// mirroring drafts-store.js's scanDraftsDir() "skip and count, console.error/
// console.warn, never throw" corrupt-entry discipline, applied to history
// instead of drafts.
import { historyField } from '@codemirror/commands'
import { createEditorStateFromJSON } from '../markdown/cm-view.js'

// [T-15-02] `history()`'s own default `minDepth: 100` bounds the NUMBER of
// retained undo events but not the byte size of any single one (e.g. one
// huge paste) -- an unbounded serialized history could make the session
// file (written on every quit, per 15-CONTEXT.md's "session write must not
// become the thing that makes quitting slow") arbitrarily large. 256 KiB is
// generous headroom for a realistic editing session's undo stack while
// keeping a multi-tab session file's total write small enough that quitting
// never becomes noticeably slow. Exceeding this drops the tab's history
// (returns null from serializeHistoryForTab) rather than truncating it --
// truncating mid-structure would itself just be a malformed-shape input on
// the next restore, defeating the point (see this plan's own threat model).
export const MAX_HISTORY_JSON_BYTES = 262144

/**
 * Serialises a real CM6 EditorState's document, selection, and history into
 * a JSON string, via CM6's own `state.toJSON({ history: historyField })` --
 * not a hand-rolled format.
 *
 * Returns `null` (never throws) for:
 * - a missing/not-yet-real state (defensive -- a caller may pass one before
 *   a tab's EditorState exists yet), silently.
 * - a serialized result exceeding MAX_HISTORY_JSON_BYTES [T-15-02] -- logged
 *   via console.warn (naming the actual byte length and the cap) so the drop
 *   decision is recorded, not silently degraded.
 *
 * @param {import('@codemirror/state').EditorState | null | undefined} state
 * @returns {string | null}
 */
export function serializeHistoryForTab (state) {
  if (!state) return null

  const json = JSON.stringify(state.toJSON({ history: historyField }))
  if (json.length > MAX_HISTORY_JSON_BYTES) {
    console.warn(
      `history-serialization: serialized history is ${json.length} bytes, exceeding the ${MAX_HISTORY_JSON_BYTES}-byte cap -- dropping this tab's history rather than writing an oversized session file`
    )
    return null
  }
  return json
}

// Walks every HistEvent in a rehydrated HistoryState's `.done`/`.undone`
// arrays, checking every buried selection position (both the event's own
// `startSelection` and every entry of `selectionsAfter`) against the
// CURRENT document's length. [Source-verified gap, 15-01-PLAN.md
// <source_findings>] CM6's own `checkSelection()` (called inside
// `EditorState.create()`, which `fromJSON()` calls internally) only
// validates the state's own TOP-LEVEL selection against `doc.length` -- it
// never validates positions buried inside a HistEvent's own
// startSelection/selectionsAfter. Those pass EditorSelection.fromJSON's own
// shape-only check (numbers present, no bounds check) and materialize
// successfully even when wildly out of range relative to the CURRENT doc.
// This function supplies the missing validation CM6 does not provide.
function hasOutOfBoundsHistoryPosition (state) {
  const docLength = state.doc.length
  const hist = state.field(historyField)

  const rangesOutOfBounds = (selection) => {
    if (!selection || !Array.isArray(selection.ranges)) return false
    return selection.ranges.some((range) => range.to > docLength)
  }

  const eventOutOfBounds = (event) => {
    if (rangesOutOfBounds(event.startSelection)) return true
    const selectionsAfter = event.selectionsAfter ?? []
    return selectionsAfter.some((selection) => rangesOutOfBounds(selection))
  }

  return [...hist.done, ...hist.undone].some(eventOutOfBounds)
}

/**
 * Rehydrates a real CM6 EditorState (with restored history) from a
 * `serializeHistoryForTab()`-shaped JSON string, or returns `null` on ANY
 * failure -- never throws, never applies a partially-trusted state.
 *
 * Each step below is independently guarded, per this plan's own
 * <source_findings> and 15-CONTEXT.md's Area 2 "every failure path degrades
 * to empty history, never... a wrong document" rule:
 *
 * 1. Not a string -> null, no warning (the common "no history was ever
 *    saved" case, not a failure).
 * 2. Absurdly long on-disk string -> null + warning, checked BEFORE
 *    JSON.parse is ever called on it (defense in depth against a tampered/
 *    enlarged on-disk value).
 * 3. JSON.parse failure (truncated JSON) -> null + warning.
 * 4. Wrong shape (`doc` not a string, or `history` not an object) -> null +
 *    warning.
 * 5. Doc-match guard: the persisted snapshot's own document text no longer
 *    matches what is about to be restored -> null + warning. Applying that
 *    history would risk exactly the "wrong document" outcome 15-CONTEXT.md
 *    names as the worst possible result.
 * 6. `createEditorStateFromJSON` throws (covers both CM6-rejected shapes and
 *    the version-mismatch failure mode) -> null + warning.
 * 7. Explicit post-construction bounds check (source-required; CM6 does not
 *    provide this) -> null + warning.
 *
 * @param {unknown} historyJson
 * @param {string} currentContent
 * @param {import('@codemirror/state').Extension[]} [extraExtensions]
 * @returns {import('@codemirror/state').EditorState | null}
 */
export function restoreHistoryState (historyJson, currentContent, extraExtensions = []) {
  if (typeof historyJson !== 'string') return null

  if (historyJson.length > MAX_HISTORY_JSON_BYTES * 2) {
    console.warn(
      `history-serialization: stored history string is ${historyJson.length} bytes, exceeding the read-side cap of ${MAX_HISTORY_JSON_BYTES * 2} -- discarding without parsing`
    )
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(historyJson)
  } catch (err) {
    console.warn('history-serialization: failed to parse stored history JSON -- discarding this tab\'s history', err)
    return null
  }

  if (!parsed || typeof parsed.doc !== 'string' || !parsed.history || typeof parsed.history !== 'object') {
    console.warn('history-serialization: stored history JSON has the wrong shape -- discarding this tab\'s history')
    return null
  }

  if (parsed.doc !== currentContent) {
    console.warn('history-serialization: stored history\'s own document text does not match the current document -- discarding this tab\'s history rather than risking a wrong-document apply')
    return null
  }

  let state
  try {
    state = createEditorStateFromJSON(parsed, extraExtensions)
  } catch (err) {
    console.warn('history-serialization: failed to construct EditorState from stored history (shape rejected by CM6, or a version-mismatched history format) -- discarding this tab\'s history', err)
    return null
  }

  if (hasOutOfBoundsHistoryPosition(state)) {
    console.warn('history-serialization: stored history references a position past the end of the current document -- discarding this tab\'s history')
    return null
  }

  return state
}
