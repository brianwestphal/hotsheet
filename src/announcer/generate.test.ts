/**
 * HS-8853 — `resolveAnnouncerModel` applies the best-effort same-family upgrade:
 * a saved Anthropic model the active key no longer offers resolves to the newest
 * available model in the SAME family (not the default, not another family).
 * Discovery failure (no key / empty list) leaves the saved id untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetAnthropicModelsForTesting, _setAnthropicModelsForTesting } from './anthropicModels.js';

// Deterministic config + key + Apple availability (no dependence on the dev box).
const { mockConfig, mockState } = vi.hoisted(() => {
  const mockConfig: { announcerModel?: string } = {};
  const mockState: { key: string | null; apple: boolean } = { key: 'sk-test', apple: false };
  return { mockConfig, mockState };
});
vi.mock('../global-config.js', () => ({ readGlobalConfig: () => mockConfig }));
vi.mock('./key.js', () => ({ resolveAnnouncerKey: () => Promise.resolve(mockState.key) }));
vi.mock('./appleFoundation.js', () => ({ isAppleFoundationAvailable: () => Promise.resolve(mockState.apple) }));

// Imported AFTER the mocks are declared so it picks them up.
const { resolveAnnouncerModel } = await import('./generate.js');

const AVAILABLE = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
];

beforeEach(() => {
  delete mockConfig.announcerModel;
  mockState.key = 'sk-test';
  mockState.apple = false;
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

  it('does not touch on-device pseudo-ids', async () => {
    mockConfig.announcerModel = 'local';
    expect(await resolveAnnouncerModel()).toBe('local');
  });

  it('defaults to Apple when available + nothing chosen, else cheapest', async () => {
    mockState.apple = true;
    expect(await resolveAnnouncerModel()).toBe('apple-foundation');
    mockState.apple = false;
    expect(await resolveAnnouncerModel()).toBe('claude-haiku-4-5');
  });
});
