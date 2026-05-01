// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests as _resetHiddenForTests,
  addGroupingForProjectWithId,
  isConfiguredTerminalId,
  setActiveGroupingForProject,
} from './dashboardHiddenTerminals.js';
import {
  _flushForTests,
  _resetForTests,
  computePersistedIds,
  initPersistedHiddenTerminals,
} from './persistedHiddenTerminals.js';

/**
 * HS-7825 — pure-helper tests for the persistence layer of the
 * configured-terminal hidden state. The DOM-touching paths
 * (`initPersistedHiddenTerminals`) are exercised by e2e flows and the
 * existing dashboardHiddenTerminals tests; these focus on the filter logic
 * that decides what makes it into settings.json.
 */
describe('isConfiguredTerminalId (HS-7825)', () => {
  it('returns true for a settings-backed terminal id', () => {
    expect(isConfiguredTerminalId('default')).toBe(true);
    expect(isConfiguredTerminalId('default-1')).toBe(true);
    expect(isConfiguredTerminalId('claude')).toBe(true);
  });

  it('returns false for runtime-generated dynamic terminal ids', () => {
    expect(isConfiguredTerminalId('dyn-abc-123')).toBe(false);
    expect(isConfiguredTerminalId('dyn-moews3gs-i9y3oh')).toBe(false);
  });

  it('treats an id that contains "dyn-" but does not start with it as configured', () => {
    expect(isConfiguredTerminalId('mydyn-test')).toBe(true);
  });

  it('returns true for an empty id (defensive — caller is responsible for not feeding empty)', () => {
    expect(isConfiguredTerminalId('')).toBe(true);
  });
});

describe('computePersistedIds (HS-7825)', () => {
  it('returns an empty array when the hidden set is empty', () => {
    expect(computePersistedIds(new Set())).toEqual([]);
  });

  it('strips dynamic ids and returns the configured-only subset sorted', () => {
    const set = new Set(['default', 'dyn-abc', 'claude', 'dyn-xyz', 'shell']);
    expect(computePersistedIds(set)).toEqual(['claude', 'default', 'shell']);
  });

  it('sorts the output so byte-equal serialised payloads are stable', () => {
    const a = new Set(['z', 'a', 'm']);
    const b = new Set(['m', 'a', 'z']);
    expect(JSON.stringify(computePersistedIds(a)))
      .toEqual(JSON.stringify(computePersistedIds(b)));
  });

  it('returns an empty array when the only hidden ids are dynamic', () => {
    const set = new Set(['dyn-1', 'dyn-2']);
    expect(computePersistedIds(set)).toEqual([]);
  });
});

/**
 * HS-7947 — regression: every fetch this module makes must hit
 * `/api/file-settings`, not `/api/<secret>`. The earlier bug had the
 * arguments to `apiWithSecret(path, secret)` swapped, so the GET on boot
 * resolved to `/api/<secret>` (404 → silent catch → empty in-memory state)
 * and the subsequent PATCH wrote nothing. Visible to the user as "I created
 * a non-Default grouping, relaunched, and it's gone."
 *
 * Test by intercepting `fetch`, kicking through one full hydrate + change +
 * write cycle, and asserting the URLs.
 */
describe('initPersistedHiddenTerminals + writeNow URLs (HS-7947)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let observedUrls: string[];

  beforeEach(() => {
    observedUrls = [];
    fetchSpy = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      observedUrls.push(url);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    _resetForTests();
    _resetHiddenForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetForTests();
    _resetHiddenForTests();
  });

  it('hydration GET hits /api/file-settings (not /api/<secret>)', async () => {
    await initPersistedHiddenTerminals([
      { secret: 'sec1', name: 'p1', dataDir: '/d1' },
    ]);
    expect(observedUrls).toContain('/api/file-settings');
    // Negative — defensive: there should be no URL of the form `/api/sec1`
    // (which would mean the path/secret args to `apiWithSecret` were
    // swapped again).
    expect(observedUrls.some(u => u === '/api/sec1' || u.startsWith('/api/sec1?'))).toBe(false);
  });

  it('mutation PATCH after a grouping change also hits /api/file-settings', async () => {
    await initPersistedHiddenTerminals([
      { secret: 'sec1', name: 'p1', dataDir: '/d1' },
    ]);
    observedUrls.length = 0;
    addGroupingForProjectWithId('sec1', 'g-shared', 'Servers');
    setActiveGroupingForProject('sec1', 'g-shared');
    _flushForTests();
    // _flushForTests() schedules an async writeNow; await a microtask flush
    // so the in-test fetch settles before we assert.
    await Promise.resolve();
    await Promise.resolve();
    expect(observedUrls).toContain('/api/file-settings');
    expect(observedUrls.some(u => u === '/api/sec1' || u.startsWith('/api/sec1?'))).toBe(false);
  });
});
