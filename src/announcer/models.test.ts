/**
 * HS-8764 — the Announcer model registry: the default must be the cheapest
 * model, and the list must stay ordered cheapest-first.
 */
import { describe, expect, it } from 'vitest';

import { ANNOUNCER_MODEL_IDS, ANNOUNCER_MODELS, announcerCost, DEFAULT_ANNOUNCER_MODEL } from './models.js';

describe('announcer models (HS-8764)', () => {
  it('defaults to the cheapest model (Haiku), first in the list', () => {
    expect(DEFAULT_ANNOUNCER_MODEL).toBe('claude-haiku-4-5');
    expect(ANNOUNCER_MODEL_IDS[0]).toBe(DEFAULT_ANNOUNCER_MODEL);
  });

  it('keeps the id list and the labeled list in sync', () => {
    expect(ANNOUNCER_MODELS.map(m => m.id)).toEqual([...ANNOUNCER_MODEL_IDS]);
  });

  // HS-8766 — cost math (per-1M-token pricing).
  it('computes cost from model pricing', () => {
    // Haiku $1/$5 per 1M: 1M in + 1M out = $1 + $5 = $6.
    expect(announcerCost('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(6, 6);
    // Opus $5/$25: 100k in + 20k out = 0.5 + 0.5 = $1.
    expect(announcerCost('claude-opus-4-8', 100_000, 20_000)).toBeCloseTo(1, 6);
    expect(announcerCost('claude-haiku-4-5', 0, 0)).toBe(0);
  });

  it('falls back to the default model pricing for an unknown model', () => {
    expect(announcerCost('some-future-model', 1_000_000, 0))
      .toBeCloseTo(announcerCost(DEFAULT_ANNOUNCER_MODEL, 1_000_000, 0), 6);
  });
});
