import { marked } from 'marked';

/** HS-7855 / HS-7857 — escape raw HTML in markdown notes.
 *
 * Notes are user-supplied (or AI-supplied) text that frequently mentions
 * tag-like fragments — e.g. `<span class=foo>`, `<input type=text>` — without
 * wrapping them in backticks. By default `marked` passes raw HTML through
 * verbatim, so a stray `<span class=hide-btn-badge>` mention in a note becomes
 * an actual badge element whose absolute positioning leaks out of the notes
 * area, and an `<input>` mention becomes a real text input rendered inline
 * with the note. Override the html renderer for both block (`Tokens.HTML`) and
 * inline (`Tokens.Tag`) HTML tokens so the source text is rendered as
 * literal characters instead. Markdown-native syntax (links, images, tables,
 * etc.) is unaffected — it doesn't go through the html renderer.
 *
 * Side-effecting on import is intentional. Importing this module anywhere a
 * `marked.parse(...)` call exists is enough to switch the singleton into
 * escape-html mode.
 */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

marked.setOptions({ breaks: true });
marked.use({
  renderer: {
    html({ text }) { return escapeHtmlText(text); },
  },
});

export { escapeHtmlText };
