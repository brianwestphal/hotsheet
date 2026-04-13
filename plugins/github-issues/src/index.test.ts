/**
 * HS-5060 part (b): rate-limit handling in the github-issues plugin.
 *
 * These tests stub global.fetch so we can assert the plugin's behavior under
 * simulated GitHub rate-limit responses without hitting the real API.
 *
 * User expectations:
 *   - If GitHub reports "remaining < 10" on a response, the plugin logs a
 *     warning and waits until the reset time before the next call.
 *   - If GitHub returns 403 with "remaining = 0", the plugin throws a clear
 *     "rate limit exceeded" error.
 *   - Under normal conditions (remaining well above 10), nothing is logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext } from './types.js';

// Import the plugin entry point after we've set up fetch stubs per test.
// Because activate() captures global.fetch at call time (via ghFetch's
// closure), we can swap fetch out before each test.
import { activate } from './index.js';

interface MockFetchCall { url: string; init: RequestInit | undefined }
let fetchCalls: MockFetchCall[];
let originalFetch: typeof fetch;

function installFetchStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeContext(settings: Record<string, string>): {
  context: PluginContext;
  logs: { level: string; message: string }[];
} {
  const logs: { level: string; message: string }[] = [];
  const context: PluginContext = {
    config: {},
    log: (level, message) => logs.push({ level, message }),
    getSetting: async (key) => settings[key] ?? null,
    setSetting: async () => { /* no-op */ },
    registerUI: () => { /* no-op */ },
    updateConfigLabel: () => { /* no-op */ },
  };
  return { context, logs };
}

describe('github-issues plugin — rate-limit handling (HS-5060)', () => {
  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    restoreFetch();
  });

  it('logs a warning and waits when x-ratelimit-remaining < 10', async () => {
    // First fetch (inside checkConnection) returns a response with low remaining
    // and a near-future reset time. Second fetch returns a normal response.
    let callIndex = 0;
    installFetchStub((_url) => {
      callIndex++;
      if (callIndex === 1) {
        // Simulated near-future reset: now + 50ms (in seconds since epoch)
        const resetSec = Math.floor((Date.now() + 50) / 1000);
        return makeResponse(200, { id: 1, name: 'repo' }, {
          'x-ratelimit-remaining': '5',
          'x-ratelimit-reset': String(resetSec),
        });
      }
      return makeResponse(200, { id: 1, name: 'repo' }, {
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
    });

    const { context, logs } = makeContext({
      token: 'ghp_test',
      owner: 'octocat',
      repo: 'hello-world',
    });

    const backend = await activate(context);
    expect(backend).toBeTruthy();

    const start = Date.now();
    const status = await backend!.checkConnection();
    const elapsed = Date.now() - start;

    expect(status.connected).toBe(true);
    expect(logs.some(l => l.level === 'warn' && l.message.includes('Rate limit low'))).toBe(true);
    // The plugin's wait is waitMs = max(0, resetTime - now) + 1000, so at
    // least ~1s of delay. Use a generous lower bound to avoid flakiness.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('throws "rate limit exceeded" on 403 with remaining=0', async () => {
    // Note: because remaining=0 is also <10, ghFetch first takes the "wait for
    // reset" branch before throwing. Use a near-future reset so the test
    // doesn't sit for an hour. (This does mean the test exercises both the
    // wait AND the throw in one run.)
    installFetchStub(() => makeResponse(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor((Date.now() + 50) / 1000)),
    }));

    const { context } = makeContext({
      token: 'ghp_test',
      owner: 'octocat',
      repo: 'hello-world',
    });

    const backend = await activate(context);
    const status = await backend!.checkConnection();
    // checkConnection catches the throw and reports connected: false with the message.
    expect(status.connected).toBe(false);
    expect(status.error ?? '').toContain('rate limit exceeded');
  });

  it('does not log a warning when remaining is well above 10', async () => {
    installFetchStub(() => makeResponse(200, { id: 1, name: 'repo' }, {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    }));

    const { context, logs } = makeContext({
      token: 'ghp_test',
      owner: 'octocat',
      repo: 'hello-world',
    });

    const backend = await activate(context);
    await backend!.checkConnection();

    expect(logs.some(l => l.message.includes('Rate limit low'))).toBe(false);
  });
});
