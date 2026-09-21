// A minimal custom @lezer/markdown grammar extension recognising a leading
// `---`...`---` block as a distinct `FrontMatter` node, tagged tags.meta
// (17-01-PLAN.md Task 2; EDIT-14).
//
// Deliberately NOT a reuse of front-matter.js's own regex or its "next line
// must be non-blank" heuristic (see that file's FRONT_MATTER_RE) --
// front-matter.js operates on raw strings pre-parse (the conversion core's
// own notion of where front matter begins/ends, used to strip it out of
// band before marked/Turndown ever see it), while this module operates on
// CM6's LIVE parse tree, purely for display highlighting. The two are
// allowed to disagree at the edges -- already accepted in REQUIREMENTS.md
// Future Requirements as a cosmetic-only, non-data-path gap. Do not attempt
// to unify them.
//
// DoS posture (T-17-03): this scan loop terminates deterministically --
// cx.nextLine() returns false at EOF (bounded by document length), and the
// unclosed-block case commits to EOF rather than looping further. Unlike
// front-matter.js's own regex (a `[\s\S]*?` lazy quantifier), this line
// scan uses no backtracking regex at all -- zero ReDoS surface.
import { styleTags, tags } from '@lezer/highlight'

/**
 * @type {import('@lezer/markdown').MarkdownExtension}
 */
export const frontMatterExtension = {
  defineNodes: ['FrontMatter'],
  props: [styleTags({ FrontMatter: tags.meta })],
  parseBlock: [
    {
      name: 'FrontMatter',
      // Installs directly before the default HorizontalRule block parser --
      // otherwise a leading bare `---` would be consumed as a thematic
      // break before this parser ever gets a chance to look at it.
      before: 'HorizontalRule',
      parse (cx, line) {
        // Front matter must open the document. A bare `---` anywhere else
        // is a thematic break, untouched by this parser.
        if (cx.lineStart !== 0 || line.text.trim() !== '---') return false

        const from = cx.lineStart

        // Mirrors @lezer/markdown's own FencedCode block parser pattern
        // (a proven precedent in this exact dependency): loop calling
        // cx.nextLine(), which mutates `line` in place to reflect the new
        // current line on each iteration.
        while (cx.nextLine()) {
          if (line.text.trim() === '---') {
            // Consume the closing delimiter line itself, then close the
            // node at cx.prevLineEnd() -- the end of that line, excluding
            // its own trailing newline (same pattern FencedCode uses for
            // its own closing fence).
            cx.nextLine()
            cx.addElement(cx.elt('FrontMatter', from, cx.prevLineEnd()))
            return true
          }
        }

        // EOF reached with no closing delimiter. A BlockParser.parse that
        // has already called nextLine() cannot cleanly "undo" that advance
        // by returning false -- mirroring @lezer/markdown's own
        // unclosed-fenced-code-block precedent, commit to EOF instead.
        // cx.prevLineEnd() correctly resolves to the document end here,
        // since cx is now at end (its own atEnd branch).
        cx.addElement(cx.elt('FrontMatter', from, cx.prevLineEnd()))
        return true
      }
    }
  ]
}
