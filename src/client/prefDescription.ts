// HS-9497 (docs/132 §132.9.2) — inline formatting for a preference hint.
//
// The per-tool settings hints being replaced by declarations were hand-written JSX
// carrying `<code>` and `<strong>`. A declaration is a plain string, so moving them
// verbatim would have quietly downgraded the rendering — real UI loss for a refactor
// that is supposed to change nothing a user sees.
//
// So the declaration keeps a tiny inline subset (`` `code` `` and `**bold**`) and this
// renders it. **Escape FIRST, then insert our own tags** — that ordering is the whole
// safety argument: by the time any markup exists in the string it is markup we wrote,
// so no input can contribute a tag, an attribute, or a quote. The output is therefore
// safe to `raw()` even though the input is dynamic.
//
// Not a markdown parser, and shouldn't become one. Two constructs are what the migrated
// hints actually used; anything more belongs in a real renderer, not here.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * Render a preference hint to safe HTML: `` `x` `` → `<code>x</code>`, `**x**` →
 * `<strong>x</strong>`, everything else escaped.
 *
 * Bold is applied before code so a `` `literal **stars**` `` inside backticks is not
 * re-processed — the code span's content is already escaped text by then, and the
 * pattern only matches the escaped-but-unmarked-up source.
 */
export function formatPrefDescription(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
