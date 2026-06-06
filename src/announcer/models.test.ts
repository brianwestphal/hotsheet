/**
 * HS-8764 / HS-8790 — the Announcer model registry: the universal default is the
 * cheapest Anthropic model, the list is provider-tagged, and `providerForModel`
 * routes ids to their provider.
 */
import { describe, expect, it } from 'vitest';

import {
  ANNOUNCER_MODEL_IDS, ANNOUNCER_MODELS, announcerCost, APPLE_FOUNDATION_MODEL_ID,
  DEFAULT_ANNOUNCER_MODEL, providerForModel,
} from './models.js';

describe('announcer models (HS-8764 / HS-8790)', () => {
  it('uses the cheapest Anthropic model as the universal default', () => {
    expect(DEFAULT_ANNOUNCER_MODEL).toBe('claude-haiku-4-5');
    // HS-8790 — the list now leads with the on-device Apple option (the default
    // *when available*), so index 0 is no longer the universal default.
    expect(ANNOUNCER_MODEL_IDS[0]).toBe(APPLE_FOUNDATION_MODEL_ID);
    expect(ANNOUNCER_MODEL_IDS).toContain(DEFAULT_ANNOUNCER_MODEL);
  });

  it('keeps the id list and the labeled list in sync', () => {
    expect(ANNOUNCER_MODELS.map(m => m.id)).toEqual([...ANNOUNCER_MODEL_IDS]);
  });

  // HS-8790 — provider routing.
  it('routes each model id to its provider (unknown → anthropic)', () => {
    expect(providerForModel(APPLE_FOUNDATION_MODEL_ID)).toBe('apple');
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
    expect(providerForModel('claude-opus-4-8')).toBe('anthropic');
    expect(providerForModel('some-future-claude')).toBe('anthropic');
  });

  it('prices the on-device Apple model at $0', () => {
    expect(announcerCost(APPLE_FOUNDATION_MODEL_ID, 1_000_000, 1_000_000)).toBe(0);
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
