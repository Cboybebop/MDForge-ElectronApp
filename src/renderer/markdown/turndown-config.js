// Turndown configuration — ported from index.html:663-675.
//
// Import swap is the entire point of this module: the cdnjs <script> tag at
// index.html:22 (Turndown 7.1.2 as a global) is replaced by an npm ESM import
// (turndown 7.2.4, pinned in package.json).
//
// Phase 2 (02-CONTEXT.md, amended by 02-RESEARCH.md 2026-08-18) repairs the
// asymmetric marked/Turndown configuration that was the root cause of 9 of
// the 21 documented round-trip losses (PITFALLS.md #1). Five mechanisms land
// here, each verified against the exact pinned package versions:
//
//   1. turndown.use(gfm) from @joplin/turndown-plugin-gfm@1.0.67 -- adds
//      table/task-list/strike-through rules so Turndown can read back
//      everything marked's gfm:true can write. Supersedes and replaces the
//      hand-rolled ~~text~~ rule this file used to carry for <del>/<s>.
//   2. emDelimiter: '*' -- fixes `2*3*4` corrupting to `2_3_4`. This is an
//      emphasis-rule fix, not an escape() fix: marked already turns `2*3*4`
//      into a real <em> element before Turndown ever runs, and only
//      emDelimiter controls how that element serialises back out
//      (02-RESEARCH.md Major Correction 2 / Pitfall 2).
//   3. defaultReplacement -- preserves unrecognised block-level HTML
//      (e.g. `<div class="note">`) as verbatim outerHTML instead of
//      stripping it to bare text content. Silent deletion is the bug being
//      fixed; ugly HTML in the source is not a bug.
//   4. keep([...]) -- elements with no Markdown equivalent (u, ins, mark,
//      sub, sup, iframe, details, summary) survive as raw HTML rather than
//      being silently deleted. Resolves CONV-08's Underline decision in the
//      user's favour.
//   5. A narrowed escape() override -- Turndown's default escape() is
//      unconditional for `*`/`_`/`[`/`]`, which produces backslash noise on
//      constructs CommonMark would never re-parse as markup anyway
//      (`get_user_name()`, an isolated `[^1]` marker). Only non-intraword `_`
//      is narrowed (CommonMark forbids intraword `_` emphasis, so this is
//      genuinely safe); `*` is ALWAYS escaped, because CommonMark's
//      flanking-delimiter rules -- unlike `_` -- explicitly PERMIT intraword
//      `*` emphasis, so a narrowed `*` rule can let a literal asterisk pair
//      with an unrelated genuine emphasis delimiter elsewhere in the same
//      document (02-REVIEW.md CR-02). `[`/`]` are left unescaped entirely
//      (02-RESEARCH.md Pattern 4).
//   6. hr: '---' -- discovered empirically while building 02-04-PLAN.md's
//      real-document corpus (this repo's own ROADMAP.md/PITFALLS.md/etc. all
//      use `---` thematic breaks). Turndown's own default is the string
//      '* * *'; left at the default, every horizontal rule in the app's own
//      documentation would be silently rewritten on the first round trip.
//      Turndown's own first-class option, no custom rule required.
//
// Two further additions, verified NOT to be needed as originally scoped:
//   - The GFM table pipe-escape "patch" CONTEXT.md called for is NOT applied
//     here -- @joplin/turndown-plugin-gfm@1.0.67's own cell() function
//     already escapes `|` correctly (02-RESEARCH.md Major Correction 1).
//     02-01-PLAN.md Task 3 locks this with a named regression test instead.
//   - Two whitespace-only-diff overrides (tableCell, taskListItems) ARE
//     added below, per 02-CONTEXT.md's Post-Research Amendments: the GFM
//     plugin's own table-cell/task-list rules are non-destructive but
//     introduce whitespace differences (3-char cell padding; doubled space
//     after a checkbox marker) not covered by the 8 accepted normalisations.
//     These two thin rule overrides are a verified-starting-point HYPOTHESIS
//     reverse-engineered from the plugin's source, not a guaranteed-final
//     diff -- Task 3's identity tests are the actual proof.
//
// The commentPlaceholder rule (mechanism 6) is registered here but owned by
// comment-preserve.js -- see that file's header for the call-site contract.

import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';
import { decodeCommentPlaceholder } from './comment-preserve.js';

const turndown = new TurndownService({
  headingStyle: 'atx',      // Use # style headings
  codeBlockStyle: 'fenced', // Use ``` code fences
  bulletListMarker: '-',
  emDelimiter: '*',         // fixes 2*3*4 -> stays 2*3*4; escape() narrowing alone does not (see header)
  hr: '---',                // Turndown's own default is '* * *' -- discovered during 02-04-PLAN.md's
                             // real-document corpus construction: every `---` horizontal rule in this
                             // repo's own Markdown (ROADMAP.md, PITFALLS.md, etc.) was being silently
                             // rewritten to a different-but-equivalent thematic-break style on every
                             // round trip. A real CONV-06 regression this repo's own docs would have
                             // tripped. Fixed via Turndown's own first-class `hr` option -- no custom
                             // rule needed.
  defaultReplacement(content, node) {
    // Preserve unrecognised block-level HTML verbatim rather than stripping
    // it to text content. Inline elements with no matching rule still fall
    // through to plain text content, which is correct -- only blocks need
    // their structure preserved.
    return node.isBlock ? '\n\n' + node.outerHTML + '\n\n' : content;
  },
});

// Tables, strike-through text, task-list checkboxes -- the root fix for the
// gfm:true (marked) / no-gfm (Turndown) asymmetry that destroyed GFM tables
// and task lists on every round trip (PITFALLS.md #1).
turndown.use(gfm);

// Elements with no Markdown equivalent survive as raw HTML instead of being
// silently deleted (PITFALLS.md #1 recommendation 5; CONV-08's Underline
// resolution).
//
// script/style/textarea (added during Gap A closure, 02-VERIFICATION.md
// human_verification item 1): Turndown's own internal `blockElements` list
// (node_modules/turndown/lib/turndown.cjs.js) omits SCRIPT, STYLE and
// TEXTAREA, so the `defaultReplacement` block-preservation rule above never
// fires for them (`node.isBlock` is false) and they fell through to plain
// text-content flattening -- verbatim `<script>` bodies (e.g. JS containing
// underscores) were even being corrupted a second time by escape(), since
// flattened text content is still markdown-escaped. `keep()`'s own
// `keepReplacement` (verified by reading turndown.cjs.js) always emits
// `node.outerHTML` regardless of `isBlock` -- it only changes whether
// blank-line padding is added around it -- so adding these three tag names
// here preserves them byte-identically the same way `iframe` already does,
// with no change to the DOMPurify display-sanitisation path (render.js still
// strips `<script>`/`<style>` for display; only the serialised Markdown
// model, which convert.js's htmlToMarkdown never routes through DOMPurify,
// keeps the raw HTML -- the same preserve/sanitise split CONTEXT.md
// documents for iframe/div).
turndown.keep(['u', 'ins', 'mark', 'sub', 'sup', 'iframe', 'details', 'summary', 'script', 'style', 'textarea']);

// --- Whitespace-trim overrides for the GFM plugin's own tableCell/taskListItems rules ---
//
// Turndown's Rules.prototype.add does `this.array.unshift(rule)` (verified in
// node_modules/turndown/lib/turndown.cjs.js), so registering a rule of the
// same name AFTER turndown.use(gfm) overrides the plugin's rule rather than
// duplicating it.

turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  // Replicates @joplin/turndown-plugin-gfm@1.0.67's own cell() function
  // (lib/turndown-plugin-gfm.cjs.js) exactly -- index-based '| '/' ' prefix,
  // \n normalisation to <br>, pipe-escaping, colspan padding (handleColSpan
  // re-implemented locally since it is not exported) -- MINUS the plugin's
  // own loop that right-pads short cell content out to a 3-character
  // minimum. That padding loop is the exact source of the whitespace-only
  // table-cell diff 02-RESEARCH.md Pitfall 1 measured; omitting it is the
  // whole point of this override.
  replacement(content, node) {
    const parent = node.parentNode;
    const index = Array.prototype.indexOf.call(parent.childNodes, node);
    let prefix = ' ';
    if (index === 0) prefix = '| ';

    // WR-01: this must be \r\n (CRLF, the real line ending a Windows paste
    // produces), not \n\r as the upstream plugin's own cell() has it -- that
    // reversed order is a bug the plugin carries too (verified directly in
    // @joplin/turndown-plugin-gfm@1.0.67's lib/turndown-plugin-gfm.cjs.js),
    // and this phase's whole purpose is to stop reproducing exactly this
    // class of regex defect. Currently inert for <br>-generated content
    // (Turndown's own <br> rule emits plain \n, caught by the second
    // .replace below) but would otherwise leave a bare \r embedded in the
    // generated cell for any DOM text node containing a literal CRLF.
    let filteredContent = content.trim().replace(/\r\n/g, '<br>').replace(/\n/g, '<br>');
    // Deliberately /\|/g, NOT /\|+/g (the plugin's own regex, reproduced
    // faithfully at first -- see 02-04-PLAN.md's real-document corpus,
    // which discovered this exact bug in a real cell containing two literal
    // pipes, e.g. "^5.0.0 || ^6.0.0"). /\|+/g collapses a RUN of pipe
    // characters into a SINGLE escaped pipe, silently dropping every pipe
    // after the first in any cell with 2+ literal pipes -- verified present
    // in @joplin/turndown-plugin-gfm@1.0.67's own cell() function too, not
    // something this override introduced. Escaping each pipe individually
    // fixes it with no behavioural change for the already-tested
    // single-pipe case.
    filteredContent = filteredContent.replace(/\|/g, '\\|');

    // Re-implements the plugin's handleColSpan(content, node, ' ') helper:
    // for a colspan > 1, append ' | ' + '   ' once per extra column.
    const colspan = node.getAttribute('colspan') || 1;
    for (let i = 1; i < colspan; i++) {
      filteredContent += ' | ' + '   ';
    }

    return prefix + filteredContent + ' |';
  },
});

turndown.addRule('taskListItems', {
  // Same filter shape as the plugin: a checkbox input/role="checkbox"
  // element whose parent is LI, or whose parent is LABEL/SPAN with a
  // grandparent LI.
  filter(node) {
    const parent = node.parentNode;
    const grandparent = parent.parentNode;
    const grandparentIsListItem = !!grandparent && grandparent.nodeName === 'LI';
    return (
      (node.type === 'checkbox' || node.getAttribute('role') === 'checkbox') &&
      (parent.nodeName === 'LI' ||
        (parent.nodeName === 'LABEL' && grandparentIsListItem) ||
        (parent.nodeName === 'SPAN' && grandparentIsListItem))
    );
  },
  // No trailing space: the plugin's own '[ ] '/'[x] ' trailing space
  // combines with the DOM's own separating text node before the label text
  // to produce a doubled-space diff (02-RESEARCH.md Pitfall 1).
  replacement(content, node) {
    const checked = node.nodeName === 'INPUT' ? node.checked : node.getAttribute('aria-checked') === 'true';
    return checked ? '[x]' : '[ ]';
  },
});

// 02-05-PLAN.md's CONV-08 toolbar-command round-trip audit found a genuine
// gap here: Turndown's own default fencedCodeBlock rule only fires for
// `<pre>` whose FIRST CHILD is a `<code>` element (node_modules/turndown/
// lib/turndown.cjs.js) -- which is exactly what marked always emits, but
// NOT what the toolbar's own formatBlock('<PRE>') produces via
// document.execCommand, which wraps the caret's block in a bare
// `<pre>text</pre>` with no nested `<code>`. Without this rule, a bare
// `<pre>` falls through to the defaultReplacement fallback above and is
// preserved as literal `<pre>...</pre>` HTML in the Markdown source --
// not deleted, but exactly the "residual wrapper HTML" the PRE format-block
// command must not leave behind, and the two-tag combination CONTEXT.md
// names as a known suspect (`formatBlock('<PRE>')` nested inside an
// existing blockquote) would otherwise produce an invalid-looking `<pre>`
// tag embedded inside `>`-prefixed Markdown. This rule treats a bare
// `<pre>` exactly like marked's `<pre><code>` shape -- a fenced code block
// -- since HTML's <pre> already means "preformatted" independent of a
// <code> child.
turndown.addRule('bareFencedCodeBlock', {
  filter: (node) => node.nodeName === 'PRE' && !(node.firstChild && node.firstChild.nodeName === 'CODE'),
  replacement: (content, node) => '\n\n```\n' + node.textContent.replace(/\n$/, '') + '\n```\n\n',
});

// HTML comments never reach Turndown's rule pipeline as comment nodes
// (verified by reading process() in turndown.cjs.js -- it only dispatches
// nodeType 1/3). comment-preserve.js's protectComments() converts them to
// <mdforge-comment> placeholder elements BEFORE Turndown ever parses the
// HTML string; this rule converts the placeholder back to a literal
// comment. See comment-preserve.js's header for the mandatory call-site
// contract -- this rule is a no-op without that pre-processing pass.
//
// WR-03: decoding goes through decodeCommentPlaceholder(), NOT a raw
// Buffer.from(content, 'base64') call -- a literal <mdforge-comment>
// element already present in the user's OWN document (a custom element, or
// a technical writeup discussing this very mechanism) would otherwise be
// blindly base64-decoded (Node's base64 decoder is lenient and does not
// throw on invalid input) into garbled text wrapped in a fabricated HTML
// comment. decodeCommentPlaceholder() validates a per-session marker first;
// content that doesn't carry it is not one of this module's own
// placeholders and is preserved verbatim as literal element content instead.
turndown.addRule('commentPlaceholder', {
  filter: 'mdforge-comment',
  replacement: (content) => {
    const decoded = decodeCommentPlaceholder(content);
    return decoded.isPlaceholder ? '<!--' + decoded.text + '-->' : content;
  },
});

// Narrowed escape() override -- Turndown's default is 13 unconditional-or-
// anchored regex replacements; 7 are already ^-anchored (leading-position-
// only) and correctly precise, left unchanged below. The other two --
// unconditional /\*/g and /_/g -- escape every asterisk/underscore anywhere,
// including intraword ones CommonMark would never re-parse as emphasis
// (`get_user_name()`, `snake_case`). Narrowed here to non-intraword only via
// lookaround. `[`/`]` escaping is dropped entirely, fixing the isolated
// footnote-marker case (`[^1]` with no matching definition stays literal
// text under marked and was being falsely bracket-escaped). Reproduced
// verbatim from 02-RESEARCH.md Pattern 4 -- do not re-derive the regexes.
turndown.escape = function (string) {
  return string
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')   // ALWAYS escape * -- unlike _, CommonMark's flanking-
                              // delimiter rules explicitly PERMIT intraword *
                              // emphasis (see 02-REVIEW.md CR-01/02-04 corpus's
                              // 2*3*4 case). A literal intraword * left unescaped
                              // can pair with a genuine emphasis delimiter
                              // elsewhere in the same document on the next parse,
                              // wrapping an arbitrary span of unrelated text in
                              // emphasis (CR-02). The 2*3*4 corruption itself is
                              // fixed by emDelimiter, not this function -- that
                              // case never reaches escape() because marked has
                              // already turned it into a real <em> element by the
                              // time Turndown runs. _ is genuinely safe to narrow
                              // (below) because CommonMark forbids intraword _
                              // emphasis -- the two characters are NOT symmetric
                              // and must not share a rule.
    .replace(/^-/, '\\-').replace(/^\+ /, '\\+ ')
    .replace(/^(=+)/, '\\$1').replace(/^(#{1,6}) /, '\\$1 ')
    .replace(/`/g, '\\`').replace(/^~~~/, '\\~~~')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')     // only non-intraword _
    .replace(/^>/, '\\>')
    .replace(/^(\d+)\. /, '$1\\. ');
    // [ and ] deliberately left unescaped here for the isolated-marker
    // footnote case -- see 02-RESEARCH.md Open Questions for why the
    // paired-definition footnote case needs a different, upstream fix.
};

export { turndown };
