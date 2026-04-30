/**
 * HS-8036 — ticket-reference auto-link detection. Scans rendered HTML
 * for ticket-number patterns matching any of the known prefixes
 * (`HS-1234`, `BUG-42`, etc.) and wraps each match in
 * `<a class="ticket-ref" data-ticket-number="HS-1234">HS-1234</a>` so
 * a global click handler can route through to the stacking ticket-
 * reference dialog (`ticketRefDialog.tsx`).
 *
 * The set of prefixes is fetched from `GET /api/tickets/prefixes` once
 * on app init and cached. Self-references (the ticket viewing its own
 * number in its notes / details) are skipped per the HS-8036 user
 * answer.
 */

import { api } from './api.js';

let cachedPrefixes: string[] | null = null;
let cachedPrefixesPromise: Promise<string[]> | null = null;

/**
 * Fetch the project's known prefixes from `/api/tickets/prefixes` and
 * cache the result for the page's lifetime. Concurrent callers share
 * the same in-flight promise. The cache is intentionally simple — the
 * set of prefixes only changes when the user creates a ticket under a
 * brand-new prefix or changes the project's `ticketPrefix` setting,
 * neither of which is hot enough to need cache invalidation logic.
 */
export async function loadTicketPrefixes(): Promise<string[]> {
  if (cachedPrefixes !== null) return cachedPrefixes;
  if (cachedPrefixesPromise !== null) return cachedPrefixesPromise;
  cachedPrefixesPromise = api<{ prefixes: string[] }>('/tickets/prefixes')
    .then(r => {
      cachedPrefixes = r.prefixes;
      cachedPrefixesPromise = null;
      return r.prefixes;
    })
    .catch(() => {
      cachedPrefixesPromise = null;
      return ['HS'];
    });
  return cachedPrefixesPromise;
}

/** Test-only — drop the cached prefix set so beforeEach can rebuild. */
export function _resetPrefixesForTesting(prefixes?: string[]): void {
  cachedPrefixes = prefixes ?? null;
  cachedPrefixesPromise = null;
}

/**
 * Build a regex that matches any ticket reference using one of `prefixes`.
 * Output: a global, case-sensitive regex that matches `(PREFIX)-(\d+)`
 * with word boundaries on both sides so e.g. `HS-1234x` doesn't match.
 *
 * Empty / null prefix list returns a regex that never matches.
 */
export function buildTicketRefRegex(prefixes: readonly string[]): RegExp {
  if (prefixes.length === 0) return /(?!)/g; // never matches
  // Escape any regex metacharacters in prefixes (defensive — prefixes
  // are user-configurable via Settings).
  const escaped = prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Sort longest-first so a `BUG-` prefix beats a hypothetical `B-` if
  // both exist (we'd want the longer match to win the regex's greedy
  // alternation).
  escaped.sort((a, b) => b.length - a.length);
  // `\b` boundary on the prefix side handles the leading non-word char;
  // the digits-followed-by-non-word-char pattern handles the trailing.
  return new RegExp(`\\b(${escaped.join('|')})-(\\d+)\\b`, 'g');
}

/**
 * Linkify ticket references inside an HTML string. Scans only the text
 * nodes (skips existing tags and their attributes) so we don't double-
 * wrap or corrupt structure. Self-reference skip via
 * `currentTicketNumber` — when set, exact matches are left as plain
 * text. Per the user's HS-8036 reply, links DO appear inside `<code>` /
 * `<pre>` blocks (no exclusion).
 *
 * Implementation note: `DOMParser` would be cleanest but the function
 * needs to run on rendered HTML strings AND is called inside markdown-
 * post-processing where the surrounding code already produces HTML
 * fragments. A regex-based scan over text-content slices is sufficient
 * here — well-formed `marked` output doesn't put angle brackets in
 * text nodes (they'd be entities like `&lt;`), so the text/tag split
 * via `<` and `>` is reliable.
 */
export function linkifyTicketRefs(
  html: string,
  prefixes: readonly string[],
  currentTicketNumber?: string,
): string {
  if (prefixes.length === 0) return html;
  const refRe = buildTicketRefRegex(prefixes);
  // Split the HTML into runs of text-content and runs of tag-content.
  // Even-indexed parts are text; odd-indexed parts are tags (including
  // their angle brackets). We only linkify the text runs.
  const parts = html.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    if (text === '') continue;
    parts[i] = text.replace(refRe, (match: string) => {
      if (currentTicketNumber !== undefined && match === currentTicketNumber) return match;
      // The match itself is the human-readable label (e.g. "HS-1234").
      // `data-ticket-number` carries the same string; the dialog's
      // click handler reads from the dataset to decide which ticket
      // to fetch.
      return `<a class="ticket-ref" data-ticket-number="${match}" href="javascript:void(0)">${match}</a>`;
    });
  }
  return parts.join('');
}

/**
 * Convenience wrapper for callers that don't want to await the
 * prefix-cache. Returns the input HTML unchanged when the cache hasn't
 * been populated yet — the caller can re-render once
 * `loadTicketPrefixes()` resolves. Pre-loaded callers should use
 * `linkifyTicketRefs(html, prefixes, currentTicketNumber)` directly.
 */
export function linkifyWithCachedPrefixes(html: string, currentTicketNumber?: string): string {
  if (cachedPrefixes === null) return html;
  return linkifyTicketRefs(html, cachedPrefixes, currentTicketNumber);
}
