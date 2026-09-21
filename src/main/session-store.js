// Hand-rolled session-state persistence over `electron-store` -- mirrors
// `window-state.js`'s shape exactly: a bare `new Store({ defaults })`, a
// read-side guard that never trusts a malformed stored shape, and a
// fire-and-forget IPC registration. See 06-CONTEXT.md "Session Restore
// (PERS-04, PERS-06)" and 06-PATTERNS.md's pattern assignment for this file.
//
// Stores the open-tab list, tab order (implicit in array order), the active
// tab index, and per-tab scroll position. Each tabs[] entry:
// { filePath: string|null, draftUuid: string|null, scrollTop: number } --
// a durable identity across process restarts. docIds are ephemeral
// per-process and are never persisted here.
//
// This module does no composition/dedup/validation of restore semantics --
// that is restore-plan.js's job (a separate plan). This module's only job is
// "read/write electron-store faithfully," per 06-RESEARCH.md's Architectural
// Responsibility Map.
import { ipcMain } from 'electron'
import Store from 'electron-store'

const store = new Store({ defaults: { tabs: [], activeIndex: 0 } })

// Never trust a hand-edited/corrupt store file blindly -- same discipline
// window-state.js's boundsFitOnADisplay applies to stored bounds. A
// malformed `tabs` value (not an array) falls back to an empty session
// rather than propagating garbage into restore-plan.js.
function getSessionState () {
  const tabs = store.get('tabs')
  if (!Array.isArray(tabs)) {
    return { tabs: [], activeIndex: 0 }
  }
  return { tabs, activeIndex: store.get('activeIndex') }
}

// The caller (session-writer.js, built in a later plan) is responsible for
// producing a well-shaped array; this function does only a minimal
// Array.isArray guard before writing, falling back to [] rather than
// persisting a non-array.
function setSessionState ({ tabs, activeIndex }) {
  store.set({
    tabs: Array.isArray(tabs) ? tabs : [],
    activeIndex
  })
}

// One-way, no reply needed -- mirrors setWindowTitleInfo's fire-and-forget
// shape in window.js.
function registerSessionIpc () {
  ipcMain.on('session:save', (_event, state) => setSessionState(state))
}

export { getSessionState, setSessionState, registerSessionIpc, store }
