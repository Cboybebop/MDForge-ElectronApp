// The single command-dispatch path (04-CONTEXT.md "One command-dispatch
// path"). Every native Menu accelerator resolves through this one registry
// -- and, once 04-06 registers real handlers, so will any remaining UI
// action -- replacing shortcuts.js's deleted document-level keydown
// dispatch entirely. Two paths that happen to agree today is not the same
// as one dispatch path; this file IS the one path.
//
// Module-level state lives in a closure, never bare-exported -- same
// getter/setter-only discipline documents.js already establishes.
let commands = new Map()

export function registerCommand (id, handler) {
  commands.set(id, handler)
}

export function dispatch (id) {
  const handler = commands.get(id)
  if (handler) handler()
  // Unregistered id: silent no-op by design. A menu accelerator firing
  // before its handler is registered (or for a command this build doesn't
  // support) must never throw and take down the renderer.
}

// For test/introspection use only -- not consumed by any production logic.
export function getRegisteredCommandIds () {
  return Array.from(commands.keys())
}

// Self-wiring at module load time: subscribe to the main process's
// 'menu:command' IPC event via the preload bridge, mirroring
// src/preload/index.js's own onSystemThemeChanged subscription shape
// (ipcRenderer.on(channel, (_e, arg) => callback(arg))).
window.mdforge.onMenuCommand(dispatch)
