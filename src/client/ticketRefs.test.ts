import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetPrefixesForTesting,
  buildTicketRefRegex,
  linkifyTicketRefs,
  linkifyWithCachedPrefixes,
  loadTicketPrefixes,
  reloadTicketPrefixes,
} from './ticketRefs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('./api.js', () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

afterEach(() => {
  _resetPrefixesForTesting();
  apiMock.mockReset();
});

describe('buildTicketRefRegex (HS-8036)', () => {
  it('returns a regex that never matches when prefixes is empty', () => {
    const re = buildTicketRefRegex([]);
    expect(re.test('HS-1234')).toBe(false);
  });

  it('matches the ticket-number shape with the given prefix', () => {
    const re = buildTicketRefRegex(['HS']);
    expect('HS-1234'.match(re)?.[0]).toBe('HS-1234');
  });

  it('matches multiple prefixes in alternation', () => {
    const re = buildTicketRefRegex(['HS', 'BUG']);
    const matches = 'See HS-1 and BUG-42'.match(re);
    expect(matches).toEqual(['HS-1', 'BUG-42']);
  });

  it('respects word boundaries — does NOT match "HS-1234x" or "fooHS-1234"', () => {
    const re = buildTicketRefRegex(['HS']);
    expect('HS-1234x'.match(re)).toBeNull();
    expect('fooHS-1234'.match(re)).toBeNull();
  });

  it('preserves longest-prefix-wins on alternation order', () => {
    // If both `B` and `BUG` are valid prefixes, a `BUG-42` token should
    // resolve as the BUG-42 reference, not the B-UG-42 split. Sorting
    // by length-descending in the regex builder ensures the longer
    // alternative wins the alternation.
    const re = buildTicketRefRegex(['B', 'BUG']);
    const m = 'BUG-42'.match(re);
    expect(m?.[0]).toBe('BUG-42');
  });

  it('escapes regex metacharacters in custom prefixes', () => {
    // Hypothetical (and weird) prefix with a regex meta — defensive
    // since prefix is user-configurable via Settings.
    const re = buildTicketRefRegex(['A.B']);
    expect('A.B-1'.match(re)?.[0]).toBe('A.B-1');
    expect('AxB-1'.match(re)).toBeNull();
  });
});

describe('linkifyTicketRefs (HS-8036)', () => {
  it('wraps a single match with the canonical anchor shape', () => {
    const html = '<p>See HS-42</p>';
    const out = linkifyTicketRefs(html, ['HS']);
    expect(out).toBe(
      '<p>See <a class="ticket-ref" data-ticket-number="HS-42" href="javascript:void(0)">HS-42</a></p>',
    );
  });

  it('wraps multiple matches in the same text node', () => {
    const html = '<p>HS-1 and BUG-2 should both link</p>';
    const out = linkifyTicketRefs(html, ['HS', 'BUG']);
    expect(out).toContain('data-ticket-number="HS-1"');
    expect(out).toContain('data-ticket-number="BUG-2"');
  });

  it('does NOT wrap inside attribute values (only text content)', () => {
    // The regex-based text/tag split via `<...>` keeps attribute values
    // off-limits — even when an attribute value happens to contain a
    // ticket-number-shaped substring.
    const html = '<a href="HS-1234.example.com">link</a>';
    const out = linkifyTicketRefs(html, ['HS']);
    // The attribute stays untouched.
    expect(out).toContain('href="HS-1234.example.com"');
    // The visible text "link" doesn't get linkified (no match in it).
    expect(out).not.toContain('class="ticket-ref"');
  });

  it('skips a self-reference when currentTicketNumber matches', () => {
    const html = '<p>This is HS-99 referencing itself</p>';
    const out = linkifyTicketRefs(html, ['HS'], 'HS-99');
    expect(out).toBe('<p>This is HS-99 referencing itself</p>');
  });

  it('still links siblings when currentTicketNumber is set', () => {
    const html = '<p>HS-99 references HS-100</p>';
    const out = linkifyTicketRefs(html, ['HS'], 'HS-99');
    // HS-99 (self) stays plain text.
    expect(out).toContain('HS-99 references');
    expect(out).not.toContain('data-ticket-number="HS-99"');
    // HS-100 (sibling) links normally.
    expect(out).toContain('data-ticket-number="HS-100"');
  });

  it('returns the input unchanged when prefixes is empty', () => {
    const html = '<p>HS-1 not linkified because no prefixes registered</p>';
    expect(linkifyTicketRefs(html, [])).toBe(html);
  });

  it('LINKS inside <code> / <pre> per the HS-8036 user answer (no exclusion)', () => {
    const html = '<pre><code>npm test HS-42</code></pre>';
    const out = linkifyTicketRefs(html, ['HS']);
    expect(out).toContain('data-ticket-number="HS-42"');
  });
});

/**
 * HS-8053 — `cachedPrefixes` is a module-private cache populated once by
 * `loadTicketPrefixes()`. Pre-fix the cache was never invalidated on
 * project switch, so a project with a non-`HS` prefix (e.g. Domotion's
 * `DM`) never had its prefixes picked up — `DM-123` references in
 * Domotion tickets stayed plain text. Fix: `reloadTicketPrefixes()`
 * drops the cache + re-runs the fetch.
 */
describe('reloadTicketPrefixes (HS-8053)', () => {
  beforeEach(() => {
    apiMock.mockReset();
    _resetPrefixesForTesting();
  });

  it('re-fetches prefixes when called even if the cache is already populated', async () => {
    // Seed the cache with the previous project's prefixes (HS only).
    _resetPrefixesForTesting(['HS']);
    expect(linkifyWithCachedPrefixes('See DM-1', undefined)).toBe('See DM-1');
    // Project switched. New project has DM. The cache is stale; the
    // first render returns input unchanged. After reload it picks up.
    apiMock.mockResolvedValueOnce({ prefixes: ['DM', 'HS'] });
    const out = await reloadTicketPrefixes();
    expect(out).toEqual(['DM', 'HS']);
    expect(linkifyWithCachedPrefixes('See DM-1', undefined))
      .toContain('data-ticket-number="DM-1"');
  });

  it('clears the cache synchronously so concurrent renders see null between clear and resolve', async () => {
    _resetPrefixesForTesting(['HS']);
    apiMock.mockReturnValueOnce(new Promise(resolve => {
      // Delay the resolve by a microtask so the synchronous
      // assertion below runs while the fetch is still in flight.
      void Promise.resolve().then(() => resolve({ prefixes: ['DM', 'HS'] }));
    }));
    const reloadPromise = reloadTicketPrefixes();
    // Mid-flight: cache is null, so `linkifyWithCachedPrefixes` should
    // be a no-op — pre-fix this would have linked against the STALE
    // ['HS'] cache.
    expect(linkifyWithCachedPrefixes('DM-9', undefined)).toBe('DM-9');
    await reloadPromise;
    // After resolve: linkify works for the new prefix.
    expect(linkifyWithCachedPrefixes('DM-9', undefined))
      .toContain('data-ticket-number="DM-9"');
  });

  it('falls back to ["HS"] when the network fails (matches loadTicketPrefixes back-compat)', async () => {
    _resetPrefixesForTesting(['HS', 'BUG']);
    apiMock.mockRejectedValueOnce(new Error('network down'));
    const out = await reloadTicketPrefixes();
    expect(out).toEqual(['HS']);
  });

  it('subsequent reload picks up another change (Domotion → SmallTale → Hot Sheet round-trip)', async () => {
    _resetPrefixesForTesting(['HS']);
    apiMock.mockResolvedValueOnce({ prefixes: ['DM', 'HS'] });
    await reloadTicketPrefixes();
    expect(linkifyWithCachedPrefixes('DM-1', undefined))
      .toContain('data-ticket-number="DM-1"');

    // User clicks back to Hot Sheet — DM should drop out.
    apiMock.mockResolvedValueOnce({ prefixes: ['HS'] });
    await reloadTicketPrefixes();
    expect(linkifyWithCachedPrefixes('DM-1', undefined)).toBe('DM-1');
    expect(linkifyWithCachedPrefixes('HS-99', undefined))
      .toContain('data-ticket-number="HS-99"');
  });

  // Sanity-check that `loadTicketPrefixes` itself still respects the
  // cache (it must — `reloadTicketPrefixes` is the bypass; the cached
  // path is what the per-render hot path uses).
  it('loadTicketPrefixes returns the cached value without re-fetching', async () => {
    _resetPrefixesForTesting(['HS', 'BUG']);
    const out = await loadTicketPrefixes();
    expect(out).toEqual(['HS', 'BUG']);
    expect(apiMock).not.toHaveBeenCalled();
  });
});
