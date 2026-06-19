/**
 * HS-8853 — `resolveAnnouncerModel` applies the best-effort same-family upgrade:
 * a saved Anthropic model the active key no longer offers resolves to the newest
 * available model in the SAME family (not the default, not another family).
 * Discovery failure (no key / empty list) leaves the saved id untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetAnthropicModelsForTesting, _setAnthropicModelsForTesting } from './anthropicModels.js';

// Deterministic config + key + Apple/local availability (no dependence on the dev box).
const { mockConfig, mockState } = vi.hoisted(() => {
  const mockConfig: { announcerModel?: string } = {};
  const mockState: { key: string | null; apple: boolean; local: boolean; localModel: string } =
    { key: 'sk-test', apple: false, local: false, localModel: '' };
  return { mockConfig, mockState };
});
vi.mock('../global-config.js', () => ({ readGlobalConfig: () => mockConfig }));
vi.mock('./key.js', () => ({ resolveAnnouncerKey: () => Promise.resolve(mockState.key) }));
vi.mock('./appleFoundation.js', () => ({ isAppleFoundationAvailable: () => Promise.resolve(mockState.apple) }));
vi.mock('./localProvider.js', () => ({
  isLocalProviderAvailable: () => Promise.resolve(mockState.local),
  resolveLocalModel: () => mockState.localModel,
}));

// Imported AFTER the mocks are declared so it picks them up.
const { resolveAnnouncerModel, decideAnnouncerFallback } = await import('./generate.js');

const AVAILABLE = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
];

beforeEach(() => {
  delete mockConfig.announcerModel;
  mockState.key = 'sk-test';
  mockState.apple = false;
  mockState.local = false;
  mockState.localModel = '';
  _setAnthropicModelsForTesting({ lister: () => Promise.resolve(AVAILABLE) });
});
afterEach(() => { _resetAnthropicModelsForTesting(); });

describe('resolveAnnouncerModel (HS-8853)', () => {
  it('keeps an explicit Anthropic choice that is still available', async () => {
    mockConfig.announcerModel = 'claude-sonnet-4-6';
    expect(await resolveAnnouncerModel()).toBe('claude-sonnet-4-6');
  });

  it('upgrades a retired model to the newest in the same family', async () => {
    mockConfig.announcerModel = 'claude-sonnet-4-5';
    expect(await resolveAnnouncerModel()).toBe('claude-sonnet-4-6'); // not opus-4-8
  });

  it('leaves the saved id untouched when discovery is empty (no key)', async () => {
    mockState.key = null;
    mockConfig.announcerModel = 'claude-sonnet-4-5';
    expect(await resolveAnnouncerModel()).toBe('claude-sonnet-4-5');
  });

  it('keeps an explicit local choice when the endpoint is ready', async () => {
    mockState.local = true;
    mockState.localModel = 'gemma:12b';
    mockConfig.announcerModel = 'local';
    expect(await resolveAnnouncerModel()).toBe('local');
  });

  it('keeps an explicit Apple choice when Apple is available', async () => {
    mockState.apple = true;
    mockConfig.announcerModel = 'apple-foundation';
    expect(await resolveAnnouncerModel()).toBe('apple-foundation');
  });

  it('defaults to Apple when available + nothing chosen, else cheapest', async () => {
    mockState.apple = true;
    expect(await resolveAnnouncerModel()).toBe('apple-foundation');
    mockState.apple = false;
    expect(await resolveAnnouncerModel()).toBe('claude-haiku-4-5');
  });
});

// HS-8872 — an explicitly-chosen on-device provider that's no longer available
// (different machine / beta build missing the helper / local endpoint down) must
// NOT lock the announcer into a hard-failing model. It falls back to the first
// working provider, preferring the other free option before paid Anthropic.
describe('resolveAnnouncerModel on-device unavailable fallback (HS-8872)', () => {
  it('falls back from an unavailable Apple choice to a ready local endpoint', async () => {
    mockConfig.announcerModel = 'apple-foundation';
    mockState.apple = false;
    mockState.local = true;
    mockState.localModel = 'gemma:12b';
    expect(await resolveAnnouncerModel()).toBe('local');
  });

  it('falls back from an unavailable Apple choice to cheapest Anthropic when no local', async () => {
    mockConfig.announcerModel = 'apple-foundation';
    mockState.apple = false;
    mockState.local = false;
    expect(await resolveAnnouncerModel()).toBe('claude-haiku-4-5');
  });

  it('treats a reachable local endpoint with no model configured as not ready', async () => {
    mockConfig.announcerModel = 'local';
    mockState.local = true;
    mockState.localModel = ''; // endpoint up, but no model picked
    expect(await resolveAnnouncerModel()).toBe('claude-haiku-4-5'); // -> Anthropic default
  });

  it('falls back from an unavailable local choice to available Apple', async () => {
    mockConfig.announcerModel = 'local';
    mockState.local = false;
    mockState.apple = true;
    expect(await resolveAnnouncerModel()).toBe('apple-foundation');
  });

  it('leaves the unavailable on-device id untouched when nothing else works', async () => {
    // No Apple, no local, no Anthropic key -> nothing ready; surface the original
    // (accurate) provider error rather than masking it behind a different model.
    mockConfig.announcerModel = 'apple-foundation';
    mockState.apple = false;
    mockState.local = false;
    mockState.key = null;
    expect(await resolveAnnouncerModel()).toBe('apple-foundation');
  });
});

// HS-8891 — the pure fallback policy: auto-on-device → Anthropic default;
// explicit Apple + configured fallback → that model (key only for Anthropic);
// explicit on-device with no configured fallback → none (respect the choice).
describe('decideAnnouncerFallback (HS-8805 / HS-8891)', () => {
  it('auto-selected on-device falls back to the Anthropic default (key needed)', () => {
    expect(decideAnnouncerFallback('apple', true, undefined)).toEqual({ fallbackModel: undefined, needsAnthropicKey: true });
    expect(decideAnnouncerFallback('local', true, undefined)).toEqual({ fallbackModel: undefined, needsAnthropicKey: true });
  });

  it('explicit Apple + configured Anthropic fallback uses that model and needs the key', () => {
    expect(decideAnnouncerFallback('apple', false, 'claude-sonnet-4-6')).toEqual({ fallbackModel: 'claude-sonnet-4-6', needsAnthropicKey: true });
  });

  it('explicit Apple + configured LOCAL fallback uses it without a key', () => {
    expect(decideAnnouncerFallback('apple', false, 'local')).toEqual({ fallbackModel: 'local', needsAnthropicKey: false });
  });

  it('explicit Apple with no configured fallback → none (respect the privacy/cost choice)', () => {
    expect(decideAnnouncerFallback('apple', false, undefined)).toEqual({ fallbackModel: undefined, needsAnthropicKey: false });
    expect(decideAnnouncerFallback('apple', false, '')).toEqual({ fallbackModel: undefined, needsAnthropicKey: false });
  });

  it('a configured fallback is ignored for a non-Apple primary (scope = Apple only)', () => {
    // An explicit local primary doesn't get the configured fallback (HS-8891 #2b).
    expect(decideAnnouncerFallback('local', false, 'claude-sonnet-4-6')).toEqual({ fallbackModel: undefined, needsAnthropicKey: false });
    // An Anthropic primary never falls back.
    expect(decideAnnouncerFallback('anthropic', false, 'claude-sonnet-4-6')).toEqual({ fallbackModel: undefined, needsAnthropicKey: false });
  });
});
