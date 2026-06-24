// HS-8963 — AI-suggested worker count: pure helpers (digest, clamp, parse,
// heuristic). The live Anthropic call + DB fetch are exercised via the app; here
// we cover the deterministic logic (docs/91 §91.6, §91.8).
import { describe, expect, it } from 'vitest';

import {
  buildSuggestDigest, clampN, heuristicSuggestion, parseSuggestion,
  type PendingTicketDigest, poolMax,
} from './suggestN.js';

const t = (over: Partial<PendingTicketDigest> = {}): PendingTicketDigest => ({
  ticketNumber: 'HS-1', title: 'a', category: 'feature', tags: [], blocked: false, ...over,
});

describe('clampN (HS-8963)', () => {
  it('clamps into [1, max], rounds, and returns 0 when there is no work', () => {
    expect(clampN(3, 8, true)).toBe(3);
    expect(clampN(99, 8, true)).toBe(8);
    expect(clampN(0, 8, true)).toBe(1);
    expect(clampN(2.6, 8, true)).toBe(3);
    expect(clampN(5, 8, false)).toBe(0);
    expect(clampN(NaN, 8, true)).toBe(1);
  });
});

describe('poolMax (HS-8963)', () => {
  it('is a small positive cap', () => {
    const m = poolMax();
    expect(m).toBeGreaterThanOrEqual(1);
    expect(m).toBeLessThanOrEqual(8);
  });
});

describe('buildSuggestDigest (HS-8963)', () => {
  it('lists unblocked tickets with category/tags and notes blocked ones', () => {
    const digest = buildSuggestDigest([
      t({ ticketNumber: 'HS-1', title: 'export bug', category: 'bug', tags: ['export'] }),
      t({ ticketNumber: 'HS-2', title: 'blocked one', blocked: true }),
    ]);
    expect(digest).toContain('1 unblocked');
    expect(digest).toContain('HS-1 [bug, export] export bug');
    expect(digest).toContain('1 more');     // blocked-count note
    expect(digest).not.toContain('HS-2');   // blocked tickets aren't listed
  });

  it('handles an all-blocked / empty set', () => {
    expect(buildSuggestDigest([])).toContain('No unblocked');
    expect(buildSuggestDigest([t({ blocked: true })])).toMatch(/No unblocked.*1 blocked/);
  });
});

describe('heuristicSuggestion (HS-8963)', () => {
  it('groups by shared category/tag into clusters', () => {
    // Two feature tickets sharing the "auth" tag = 1 cluster; one unrelated bug = +1.
    const r = heuristicSuggestion([
      t({ ticketNumber: 'HS-1', category: 'feature', tags: ['auth'] }),
      t({ ticketNumber: 'HS-2', category: 'feature', tags: ['auth'] }),
      t({ ticketNumber: 'HS-3', category: 'bug', tags: ['export'] }),
    ], 8);
    expect(r.source).toBe('heuristic');
    expect(r.n).toBe(2);
    expect(r.rationale).toContain('no AI key');
  });

  it('returns 0 when nothing is unblocked', () => {
    expect(heuristicSuggestion([t({ blocked: true })], 8).n).toBe(0);
  });
});

describe('parseSuggestion (HS-8963)', () => {
  it('parses + clamps the model JSON (tolerates a code fence)', () => {
    const r = parseSuggestion('```json\n{"n": 12, "rationale": "lots"}\n```', 8, true);
    expect(r).toEqual({ n: 8, rationale: 'lots', source: 'ai' });
  });
  it('returns null on malformed output (caller falls back)', () => {
    expect(parseSuggestion('not json', 8, true)).toBeNull();
  });
});
