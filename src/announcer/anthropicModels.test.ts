/**
 * HS-8853 — dynamic Anthropic model discovery: the Models API list is filtered
 * to `claude-*`, labeled from `display_name`, cached per-key with a TTL, and
 * degrades to [] on error so callers fall back to the static defaults.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetAnthropicModelsForTesting, _setAnthropicModelsForTesting, ANTHROPIC_MODELS_TTL_MS,
  listAnthropicModels,
} from './anthropicModels.js';

afterEach(() => { _resetAnthropicModelsForTesting(); });

describe('listAnthropicModels (HS-8853)', () => {
  it('returns [] without a network call when the key is empty', async () => {
    const lister = vi.fn();
    _setAnthropicModelsForTesting({ lister });
    expect(await listAnthropicModels('')).toEqual([]);
    expect(lister).not.toHaveBeenCalled();
  });

  it('keeps only claude-* ids and labels them from display_name (id fallback)', async () => {
    _setAnthropicModelsForTesting({
      lister: () => Promise.resolve([
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        { id: 'claude-haiku-4-5', display_name: null },
        { id: 'not-a-claude-model', display_name: 'Some Other Model' },
      ]),
    });
    expect(await listAnthropicModels('sk-test')).toEqual([
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
    ]);
  });

  it('returns [] when the list call throws (revoked key / network)', async () => {
    _setAnthropicModelsForTesting({ lister: () => Promise.reject(new Error('401')) });
    expect(await listAnthropicModels('sk-bad')).toEqual([]);
  });

  it('caches per-key within the TTL and re-fetches after it / on a key change', async () => {
    let t = 1_000;
    const lister = vi.fn((apiKey: string) => Promise.resolve([{ id: `claude-${apiKey}-1-0` }]));
    _setAnthropicModelsForTesting({ lister, now: () => t });

    await listAnthropicModels('sk-a');
    await listAnthropicModels('sk-a');
    expect(lister).toHaveBeenCalledTimes(1); // second served from cache

    // A different key bypasses the cache.
    await listAnthropicModels('sk-b');
    expect(lister).toHaveBeenCalledTimes(2);

    // Past the TTL, the same key re-fetches.
    t += ANTHROPIC_MODELS_TTL_MS + 1;
    await listAnthropicModels('sk-b');
    expect(lister).toHaveBeenCalledTimes(3);
  });
});
