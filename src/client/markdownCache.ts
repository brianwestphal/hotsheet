/**
 * HS-9539 — memoize `marked.parse()` for note and Details bodies.
 *
 * ## Why
 *
 * The HS-9538 audit measured the detail panel re-rendering to byte-identical output
 * 89 % of the time (8 of 9 renders of `#detail-notes`). A redundant `morph()` is
 * cheap by design — the byte-equal fast path is the point — but the parse runs
 * BEFORE `morph` ever sees the template. A ticket with 20 notes re-parsed 20
 * markdown documents to produce what was already on screen.
 *
 * Markdown → HTML is a pure function of the text, so the fix is a cache rather than
 * a render-skip guard: it needs no invalidation key, and it cannot go stale or leave
 * old notes on screen. (Option 2 in the ticket — guarding the `morph` call — would
 * also skip the JSX build, but `detail.tsx` re-renders for reasons other than note
 * content and a wrong key there means stale notes.)
 *
 * ## Bounded, deliberately
 *
 * Keyed by note text, so an unbounded map would grow with everything the user has
 * ever looked at, and the values are rendered HTML — bigger than the keys. That is
 * the docs/128 lesson at small scale: a cache nothing evicts is a leak with a
 * respectable name. Insertion-ordered eviction (a `Map` iterates in insertion order,
 * and re-inserting on a hit promotes the entry) gives LRU without a second structure.
 *
 * ## Not project-scoped
 *
 * `src/client/**` module-level caches are usually a docs/125 leak waiting to happen,
 * but this one is keyed by CONTENT and holds no project data: the same text renders
 * to the same HTML in every project, so a cross-project hit is correct rather than
 * stale. That is why it is on the HS-9417 eslint allowlist rather than wrapped in
 * `projectScoped`. It is not reset on a project switch on purpose.
 */

import './markdownSetup.js';

import { marked } from 'marked';

/**
 * Maximum entries retained.
 *
 * Sized against the workload rather than a round number: the panel re-renders one
 * ticket's notes at a time, and tickets here run to a few dozen notes, so a few
 * hundred entries covers switching among recently-viewed tickets without holding
 * rendered HTML for everything ever opened.
 */
export const MARKDOWN_CACHE_MAX = 500;

const cache = new Map<string, string>();

/** Hits/misses, for tests and for the HS-9538 audit to report against. */
let hits = 0;
let misses = 0;

/**
 * `marked.parse(text, { async: false })`, memoized.
 *
 * Identical output to calling `marked` directly — the point is only that repeat
 * calls with the same text stop re-parsing.
 */
export function parseMarkdownCached(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) {
    hits += 1;
    // Re-insert to move this key to the end, so eviction below drops the
    // least-recently-USED entry rather than the oldest-inserted one.
    cache.delete(text);
    cache.set(text, cached);
    return cached;
  }
  misses += 1;
  const html = marked.parse(text, { async: false });
  cache.set(text, html);
  if (cache.size > MARKDOWN_CACHE_MAX) {
    // `Map` iterates in insertion order, so the first key is the least recent.
    const oldest = cache.keys().next();
    if (!(oldest.done ?? false)) cache.delete(oldest.value);
  }
  return html;
}

/** Cache instrumentation. Cheap enough to leave on — two counters. */
export function markdownCacheStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size };
}

/** Drop everything. For tests; there is no product reason to call this. */
export function resetMarkdownCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}
