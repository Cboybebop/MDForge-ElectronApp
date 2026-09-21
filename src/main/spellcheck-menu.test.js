// EDIT-03's right-click half. buildSpellcheckMenuTemplate is pure, so the
// menu's shape is testable without a real BrowserWindow -- the same seam
// dialogs.test.js uses.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() } }))

const { buildSpellcheckMenuTemplate } = await import('./spellcheck-menu.js')

const labels = (t) => t.filter((i) => i.label).map((i) => i.label)

describe('buildSpellcheckMenuTemplate', () => {
  it('offers every suggestion Chromium returned, in order, at the top', () => {
    const t = buildSpellcheckMenuTemplate({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech', 'ten'],
      isEditable: true,
      editFlags: {}
    })
    expect(labels(t).slice(0, 3)).toEqual(['the', 'tech', 'ten'])
  })

  it('tags suggestions so the caller can wire replaceMisspelling', () => {
    const t = buildSpellcheckMenuTemplate({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      isEditable: true,
      editFlags: {}
    })
    expect(t[0].spellingSuggestion).toBe('the')
  })

  it('says so rather than showing an empty menu when there are no suggestions', () => {
    const t = buildSpellcheckMenuTemplate({
      misspelledWord: 'zzzqx',
      dictionarySuggestions: [],
      isEditable: true,
      editFlags: {}
    })
    expect(labels(t)).toContain('No suggestions')
    expect(t.find((i) => i.label === 'No suggestions').enabled).toBe(false)
  })

  it('offers no dictionary-management item -- 05-CONTEXT.md scopes EDIT-03 to underline-and-suggest', () => {
    const t = buildSpellcheckMenuTemplate({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      isEditable: true,
      editFlags: {}
    })
    expect(labels(t).join(' ')).not.toMatch(/dictionar/i)
  })

  it('gates edit actions on what Chromium says is currently possible', () => {
    const t = buildSpellcheckMenuTemplate({
      isEditable: true,
      editFlags: { canCut: false, canCopy: false, canPaste: true }
    })
    const byRole = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i]))
    expect(byRole.cut.enabled).toBe(false)
    expect(byRole.paste.enabled).toBe(true)
  })

  it('returns nothing for a right-click with no word and nothing editable', () => {
    expect(buildSpellcheckMenuTemplate({})).toEqual([])
  })
})
