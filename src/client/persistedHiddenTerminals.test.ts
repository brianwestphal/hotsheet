// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests as _resetHiddenForTests,
  addGrouping,
  isConfiguredTerminalId,
  setActiveGrouping,
} from './dashboardHiddenTerminals.js';
import {
  _flushForTests,
  _resetForTests,
  computePersistedGroupings,
  initPersistedHiddenTerminals,
} from './persistedHiddenTerminals.js';
import type { VisibilityGrouping } from './visibilityGroupings.js';

describe('isConfiguredTerminalId', () => {
  it('returns true for a settings-backed terminal id', () => {
    expect(isConfiguredTerminalId('default')).toBe(true);
    expect(isConfiguredTerminalId('claude')).toBe(true);
  });

  it('returns false for runtime-generated dynamic terminal ids', () => {
    expect(isConfiguredTerminalId('dyn-abc-123')).toBe(false);
  });
});

describe('computePersistedGroupings (HS-8290)', () => {
  it('drops dynamic ids and sorts each project entry for byte-stable serialisation', () => {
    const groupings: VisibilityGrouping[] = [
      {
        id: 'g-1',
        name: 'X',
        hiddenByProject: { s1: ['dyn-x', 'b', 'a'], s2: ['z', 'dyn-y'] },
      },
    ];
    const persisted = computePersistedGroupings(groupings);
    expect(persisted[0].hiddenByProject).toEqual({ s1: ['a', 'b'], s2: ['z'] });
  });

  it('drops empty per-project entries entirely', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'g-1', name: 'X', hiddenByProject: { s1: ['dyn-only'] } },
    ];
    expect(computePersistedGroupings(groupings)[0].hiddenByProject).toEqual({});
  });
});

/**
 * HS-8290 — persistence layer hits the global config endpoint, not the
 * per-project file-settings endpoint. Pre-HS-8290 a per-project debounce
 * loop fired N PATCHes (one per project); post-HS-8290 a single global
 * PATCH covers everything.
 */
describe('initPersistedHiddenTerminals (HS-8290 — global endpoint)', () => {
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

  it('hydration GET hits /api/dashboard/global-config', async () => {
    await initPersistedHiddenTerminals();
    expect(observedUrls).toContain('/api/dashboard/global-config');
    expect(observedUrls.some(u => u.startsWith('/api/file-settings'))).toBe(false);
  });

  it('mutation PATCH after a grouping change also hits /api/dashboard/global-config', async () => {
    await initPersistedHiddenTerminals();
    observedUrls.length = 0;
    const g = addGrouping('Servers');
    setActiveGrouping(g.id);
    _flushForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(observedUrls).toContain('/api/dashboard/global-config');
    expect(observedUrls.some(u => u.startsWith('/api/file-settings'))).toBe(false);
  });
});
