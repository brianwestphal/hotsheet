/**
 * HS-8792 — the local (OpenAI-compatible) Announcer provider: availability probe
 * + model listing (with TTL caching), endpoint resolution, and the chat call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLocalProviderForTesting, _setLocalProviderForTesting, DEFAULT_LOCAL_ENDPOINT,
  type FetchLike, isLocalProviderAvailable, listLocalModels, LOCAL_PROBE_TTL_MS,
  resolveLocalEndpoint, runLocalSummarize,
} from './localProvider.js';

// Control the global config so endpoint resolution is deterministic (no
// dependence on the dev machine's ~/.hotsheet/config.json). `vi.hoisted` makes
// `mockConfig` available to the (hoisted) `vi.mock` factory before the module
// under test loads its `../global-config.js` dependency.
const { mockConfig } = vi.hoisted((): { mockConfig: { announcerLocalEndpoint?: string; announcerLocalModel?: string } } => ({ mockConfig: {} }));
vi.mock('../global-config.js', () => ({ readGlobalConfig: () => mockConfig }));

interface Call { url: string; init?: { method?: string; body?: string } }

/** A fake fetch that records calls and returns canned responses by URL suffix. */
function fakeFetch(handlers: { models?: () => unknown; chat?: () => unknown; throwOn?: 'models' | 'chat'; status?: number }): { fn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, init });
    const isModels = url.endsWith('/models');
    const which = isModels ? 'models' : 'chat';
    if (handlers.throwOn === which) return Promise.reject(new Error('connection refused'));
    const ok = (handlers.status ?? 200) < 400;
    const body = isModels ? handlers.models?.() : handlers.chat?.();
    return Promise.resolve({ ok, status: handlers.status ?? 200, json: () => Promise.resolve(body ?? {}) });
  };
  return { fn, calls };
}

beforeEach(() => { delete mockConfig.announcerLocalEndpoint; delete mockConfig.announcerLocalModel; });
afterEach(() => { _resetLocalProviderForTesting(); });

describe('resolveLocalEndpoint', () => {
  it('defaults to the Ollama OpenAI-compatible base URL', () => {
    expect(resolveLocalEndpoint()).toBe(DEFAULT_LOCAL_ENDPOINT);
  });

  it('uses the configured endpoint and strips a trailing slash', () => {
    mockConfig.announcerLocalEndpoint = 'http://localhost:1234/v1/';
    expect(resolveLocalEndpoint()).toBe('http://localhost:1234/v1');
  });
});

describe('availability + model listing', () => {
  it('is available when the endpoint lists ≥1 model', async () => {
    const { fn } = fakeFetch({ models: () => ({ data: [{ id: 'llama3.1' }, { id: 'qwen2.5' }] }) });
    _setLocalProviderForTesting({ fetch: fn });
    expect(await isLocalProviderAvailable()).toBe(true);
    expect(await listLocalModels()).toEqual(['llama3.1', 'qwen2.5']);
  });

  it('is NOT available when the endpoint is reachable but lists no models', async () => {
    const { fn } = fakeFetch({ models: () => ({ data: [] }) });
    _setLocalProviderForTesting({ fetch: fn });
    expect(await isLocalProviderAvailable()).toBe(false);
    expect(await listLocalModels()).toEqual([]);
  });

  it('is NOT available when the endpoint is unreachable', async () => {
    const { fn } = fakeFetch({ throwOn: 'models' });
    _setLocalProviderForTesting({ fetch: fn });
    expect(await isLocalProviderAvailable()).toBe(false);
  });

  it('is NOT available on a non-2xx /models response', async () => {
    const { fn } = fakeFetch({ status: 500 });
    _setLocalProviderForTesting({ fetch: fn });
    expect(await isLocalProviderAvailable()).toBe(false);
  });

  it('caches the probe within the TTL, then re-probes after it elapses', async () => {
    let t = 1_000;
    const { fn, calls } = fakeFetch({ models: () => ({ data: [{ id: 'm' }] }) });
    _setLocalProviderForTesting({ fetch: fn, now: () => t });
    await isLocalProviderAvailable();
    await listLocalModels();           // within TTL → served from cache
    expect(calls.length).toBe(1);
    t += LOCAL_PROBE_TTL_MS + 1;         // TTL elapsed
    await isLocalProviderAvailable();
    expect(calls.length).toBe(2);
  });
});

describe('runLocalSummarize', () => {
  it('POSTs to {endpoint}/chat/completions and returns the message content', async () => {
    const { fn, calls } = fakeFetch({ chat: () => ({ choices: [{ message: { content: '{"entries":[]}' } }] }) });
    _setLocalProviderForTesting({ fetch: fn });
    const out = await runLocalSummarize('sys', 'material', { endpoint: 'http://localhost:11434/v1/', model: 'llama3.1' });
    expect(out).toBe('{"entries":[]}');
    // Trailing slash on the endpoint is normalized.
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body ?? '{}') as { model: string; messages: { role: string }[] };
    expect(body.model).toBe('llama3.1');
    expect(body.messages.map(m => m.role)).toEqual(['system', 'user']);
  });

  it('throws when no model is configured (so generation surfaces a clear error)', async () => {
    const { fn } = fakeFetch({ chat: () => ({}) });
    _setLocalProviderForTesting({ fetch: fn });
    await expect(runLocalSummarize('sys', 'material', { endpoint: DEFAULT_LOCAL_ENDPOINT, model: '' })).rejects.toThrow(/model/i);
  });

  it('throws on a non-2xx chat response', async () => {
    const { fn } = fakeFetch({ status: 503 });
    _setLocalProviderForTesting({ fetch: fn });
    await expect(runLocalSummarize('sys', 'material', { endpoint: DEFAULT_LOCAL_ENDPOINT, model: 'm' })).rejects.toThrow(/HTTP 503/);
  });

  it('returns empty string on a malformed (no-choices) response — caller parses to []', async () => {
    const { fn } = fakeFetch({ chat: () => ({ unexpected: true }) });
    _setLocalProviderForTesting({ fetch: fn });
    expect(await runLocalSummarize('sys', 'material', { endpoint: DEFAULT_LOCAL_ENDPOINT, model: 'm' })).toBe('');
  });
});
