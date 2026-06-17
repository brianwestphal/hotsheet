/**
 * HS-8764 / HS-8790 — the Announcer model registry: the universal default is the
 * cheapest Anthropic model, the list is provider-tagged, and `providerForModel`
 * routes ids to their provider.
 */
import { describe, expect, it } from 'vitest';

import {
  ANNOUNCER_MODEL_IDS, ANNOUNCER_MODELS, announcerCost, APPLE_FOUNDATION_MODEL_ID,
  DEFAULT_ANNOUNCER_MODEL, LOCAL_MODEL_ID, parseAnthropicModel, providerForModel,
  resolveBestModelForSelection,
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

  // HS-8790 / HS-8792 — provider routing.
  it('routes each model id to its provider (unknown → anthropic)', () => {
    expect(providerForModel(APPLE_FOUNDATION_MODEL_ID)).toBe('apple');
    expect(providerForModel(LOCAL_MODEL_ID)).toBe('local');
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
    expect(providerForModel('claude-opus-4-8')).toBe('anthropic');
    expect(providerForModel('some-future-claude')).toBe('anthropic');
  });

  it('prices the on-device providers (Apple + local) at $0', () => {
    expect(announcerCost(APPLE_FOUNDATION_MODEL_ID, 1_000_000, 1_000_000)).toBe(0);
    expect(announcerCost(LOCAL_MODEL_ID, 1_000_000, 1_000_000)).toBe(0);
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

  // HS-8853 — family parsing.
  describe('parseAnthropicModel (HS-8853)', () => {
    it('parses family + version from a current-scheme id', () => {
      expect(parseAnthropicModel('claude-sonnet-4-6')).toEqual({ family: 'sonnet', major: 4, minor: 6 });
      expect(parseAnthropicModel('claude-haiku-4-5')).toEqual({ family: 'haiku', major: 4, minor: 5 });
      expect(parseAnthropicModel('claude-opus-4-8')).toEqual({ family: 'opus', major: 4, minor: 8 });
    });
    it('returns null for pseudo-ids and non-matching schemes', () => {
      expect(parseAnthropicModel(APPLE_FOUNDATION_MODEL_ID)).toBeNull();
      expect(parseAnthropicModel(LOCAL_MODEL_ID)).toBeNull();
      expect(parseAnthropicModel('claude-fable-5')).toBeNull();
      expect(parseAnthropicModel('claude-3-5-sonnet-20241022')).toBeNull();
    });
  });

  // HS-8853 — best-effort same-family upgrade (the core of the user's ask).
  describe('resolveBestModelForSelection (HS-8853)', () => {
    const available = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'];

    it('keeps the saved id when it is still available', () => {
      expect(resolveBestModelForSelection('claude-sonnet-4-6', available)).toBe('claude-sonnet-4-6');
    });

    it('upgrades a retired model to the newest in the SAME family, not another family', () => {
      // The user's example: saved sonnet-4-5, only sonnet-4-6 available → sonnet-4-6 (NOT opus-4-8).
      expect(resolveBestModelForSelection('claude-sonnet-4-5', available)).toBe('claude-sonnet-4-6');
      expect(resolveBestModelForSelection('claude-haiku-4-1', available)).toBe('claude-haiku-4-5');
      expect(resolveBestModelForSelection('claude-opus-4-6', available)).toBe('claude-opus-4-8');
    });

    it('picks the highest version when several of the same family are available', () => {
      const many = ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5-0'];
      expect(resolveBestModelForSelection('claude-sonnet-4-1', many)).toBe('claude-sonnet-5-0');
    });

    it('returns null when no same-family model is available (caller falls back to default)', () => {
      expect(resolveBestModelForSelection('claude-sonnet-4-5', ['claude-haiku-4-5'])).toBeNull();
      // An unparseable saved id can't be family-matched.
      expect(resolveBestModelForSelection('claude-fable-5', available)).toBeNull();
    });
  });

  // HS-8853 — pricing falls back by family for an unlisted Anthropic id.
  it('prices an unlisted same-family model at its family rate, not the flat default', () => {
    // A hypothetical future sonnet not in ANNOUNCER_PRICING → sonnet rates ($3/$15),
    // NOT the default (haiku, $1/$5).
    expect(announcerCost('claude-sonnet-4-7', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    expect(announcerCost('claude-opus-5-0', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
    // A truly unknown (non-claude) id still falls back to the default model price.
    expect(announcerCost('mystery-model', 1_000_000, 0))
      .toBeCloseTo(announcerCost(DEFAULT_ANNOUNCER_MODEL, 1_000_000, 0), 6);
  });
});
