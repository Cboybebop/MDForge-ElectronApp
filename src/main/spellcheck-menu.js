// EDIT-03's right-click half.
//
// Chromium's own spellchecker is enabled by default in Electron, which is why
// misspellings are already underlined without any code. What it does NOT do on
// its own is offer corrections: suggestions arrive on the 'context-menu' event
// as `params.dictionarySuggestions`, and an app that never listens for that
// event simply has no right-click menu at all.
//
// 05-CONTEXT.md locked EDIT-03 as "rely on Chromium's built-in dictionary and
// the existing right-click context menu". That decision rested on an
// assumption that turned out to be false -- there was no existing context
// menu anywhere in this app, so underlines appeared and right-clicking did
// nothing. Found in v1.0 UAT. This file is the smallest thing that makes the
// locked decision true, rather than a re-litigation of it.
//
// Deliberately NOT included: "Add to Dictionary". 05-CONTEXT.md explicitly
// scopes EDIT-03 to underline-and-suggest with "no custom-dictionary UI", and
// dictionary management is exactly that. Surfacing Chromium's own suggestions
// is relying on the built-in dictionary; letting the user edit it is not.
import { Menu } from 'electron'

/**
 * Builds the context-menu template for one right-click.
 *
 * Pure and exported so the shape can be unit-tested without a real
 * BrowserWindow -- the same testing seam dialogs.js and menu.js already use.
 *
 * @param {{misspelledWord?: string, dictionarySuggestions?: string[],
 *          isEditable?: boolean, editFlags?: object, selectionText?: string}} params
 *   Electron's own 'context-menu' event params.
 * @returns {Array<object>} A Menu.buildFromTemplate-compatible template.
 *   Empty when there is nothing useful to offer, so the caller can skip
 *   popping an empty menu.
 */
export function buildSpellcheckMenuTemplate (params = {}) {
  const {
    misspelledWord = '',
    dictionarySuggestions = [],
    isEditable = false,
    editFlags = {},
    selectionText = ''
  } = params

  const template = []

  // Suggestions first -- they are the reason this menu exists, and putting
  // them at the top means the correction is one click away rather than a
  // scan past Cut/Copy/Paste every time.
  if (misspelledWord && dictionarySuggestions.length > 0) {
    for (const suggestion of dictionarySuggestions) {
      template.push({ label: suggestion, spellingSuggestion: suggestion })
    }
    template.push({ type: 'separator' })
  } else if (misspelledWord) {
    // Chromium found the word misspelled but has nothing to offer. Saying so
    // is better than an empty menu that reads as a broken right-click.
    template.push({ label: 'No suggestions', enabled: false })
    template.push({ type: 'separator' })
  }

  // Standard editing actions, gated on what Chromium says is actually
  // possible right now -- a disabled Paste on a read-only surface is more
  // honest than one that silently does nothing.
  if (isEditable || selectionText) {
    template.push({ role: 'cut', enabled: Boolean(editFlags.canCut) })
    template.push({ role: 'copy', enabled: Boolean(editFlags.canCopy) })
    template.push({ role: 'paste', enabled: Boolean(editFlags.canPaste) })
    template.push({ type: 'separator' })
    template.push({ role: 'selectAll' })
  }

  return template
}

/**
 * Attaches the context-menu handler to one window's webContents.
 *
 * Follows the same registerXIpc(win) lifecycle convention as dialogs.js and
 * theme-store.js. The listener lives on this window's own webContents, so it
 * goes away with the window rather than leaking on a global emitter.
 */
export function registerSpellcheckMenu (win) {
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildSpellcheckMenuTemplate(params)
    if (template.length === 0) return

    // `spellingSuggestion` is this module's own bookkeeping field, not
    // something Electron understands -- Electron 43 REJECTS unknown keys
    // passed to Menu.buildFromTemplate() (the same trap menu.js has hit
    // three separate times). Strip it and attach the real click handler here,
    // where webContents is in scope.
    const menuTemplate = template.map((item) => {
      const { spellingSuggestion, ...rest } = item
      if (!spellingSuggestion) return rest
      return {
        ...rest,
        click: () => win.webContents.replaceMisspelling(spellingSuggestion)
      }
    })

    if (win.isDestroyed()) return
    Menu.buildFromTemplate(menuTemplate).popup({ window: win })
  })
}
