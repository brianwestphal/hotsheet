// @vitest-environment happy-dom
/**
 * HS-9539 — the memoized markdown parse.
 *
 * Two things have to hold and they pull in opposite directions: the output must be
 * IDENTICAL to calling `marked` directly (a cache that changes rendering is a bug,
 * not an optimization), and repeat calls must actually stop parsing. The second is
 * the easy one to fake — a test that only checks the return value passes just as
 * happily against a cache that never hits.
 */

import { marked } from 'marked';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MARKDOWN_CACHE_MAX, markdownCacheStats, parseMarkdownCached, resetMarkdownCache } from './markdownCache.js';

beforeEach(() => { resetMarkdownCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('output fidelity', () => {
  it('returns exactly what `marked.parse` returns', () => {
    for (const md of ['**bold**', '# heading', '- a\n- b', 'plain', '`code`', '| a | b |\n|---|---|\n| 1 | 2 |']) {
      expect(parseMarkdownCached(md)).toBe(marked.parse(md, { async: false }));
    }
  });

  it('returns the same value on a hit as on the miss that populated it', () => {
    const first = parseMarkdownCached('**same**');
    expect(parseMarkdownCached('**same**')).toBe(first);
  });

  it('handles the empty string as a real key rather than a cache miss forever', () => {
    // `''` is falsy, so a `if (cached)` implementation would re-parse it every time —
    // and empty notes are common.
    parseMarkdownCached('');
    parseMarkdownCached('');
    expect(markdownCacheStats().hits).toBe(1);
  });
});

describe('it actually avoids the parse', () => {
  it('calls `marked.parse` ONCE for repeated identical text', () => {
    // The assertion that makes the whole thing worth having: without it, a no-op
    // cache passes every other test in this file.
    const spy = vi.spyOn(marked, 'parse');
    for (let i = 0; i < 10; i++) parseMarkdownCached('# repeated');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(markdownCacheStats()).toMatchObject({ hits: 9, misses: 1 });
  });

  it('still parses text it has not seen', () => {
    const spy = vi.spyOn(marked, 'parse');
    parseMarkdownCached('one');
    parseMarkdownCached('two');
    parseMarkdownCached('one');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('models the reported workload — 20 notes re-rendered 9 times parses 20 times, not 180', () => {
    // HS-9538 measured 8 of 9 renders of `#detail-notes` as byte-identical.
    const notes = Array.from({ length: 20 }, (_, i) => `note ${String(i)} body`);
    const spy = vi.spyOn(marked, 'parse');
    for (let render = 0; render < 9; render++) for (const n of notes) parseMarkdownCached(n);
    expect(spy).toHaveBeenCalledTimes(20);
  });
});

describe('bounding', () => {
  it('evicts so the cache cannot grow without limit', () => {
    for (let i = 0; i < MARKDOWN_CACHE_MAX + 50; i++) parseMarkdownCached(`entry ${String(i)}`);
    expect(markdownCacheStats().size).toBeLessThanOrEqual(MARKDOWN_CACHE_MAX);
  });

  it('evicts the least-recently-USED entry, not the oldest-inserted', () => {
    // The distinction matters for the actual access pattern: one ticket's notes are
    // re-rendered over and over while the user opens other tickets in between. Under
    // insertion-order eviction the notes being looked at right now are the FIRST to
    // go, which would defeat the cache exactly when it is being used.
    parseMarkdownCached('keep-me');
    for (let i = 0; i < MARKDOWN_CACHE_MAX - 1; i++) parseMarkdownCached(`filler ${String(i)}`);

    parseMarkdownCached('keep-me');       // promote: now the most recent
    parseMarkdownCached('overflow');      // forces one eviction

    const spy = vi.spyOn(marked, 'parse');
    parseMarkdownCached('keep-me');
    expect(spy, 'the promoted entry must have survived').not.toHaveBeenCalled();

    parseMarkdownCached('filler 0');
    expect(spy, 'the genuinely least-recent entry is the one that went').toHaveBeenCalledTimes(1);
  });
});
