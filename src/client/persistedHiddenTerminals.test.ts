// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests as _resetHiddenForTests,
  addGrouping,
  DASHBOARD_SCOPE,
  getGlobalVisibilityState,
  isConfiguredTerminalId,
  setActiveGrouping,
  setTerminalHiddenInGrouping,
} from './dashboardHiddenTerminals.js';
import {
  _flushForTests,
  _resetForTests,
  computePersistedGroupings,
  initPersistedHiddenTerminals,
} from './persistedHiddenTerminals.js';
import { DEFAULT_GROUPING_ID, type VisibilityGrouping } from './visibilityGroupings.js';

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

  it('hydration GET hits /api/global-config (the actual dashboardRoutes mount path)', async () => {
    await initPersistedHiddenTerminals();
    // HS-8290 follow-up: dashboardRoutes is mounted at `/` inside apiRoutes
    // (apiRoutes itself is mounted at `/api`), so the global-config endpoint
    // lives at `/api/global-config`, NOT `/api/dashboard/global-config`. The
    // earlier path 404'd in production while passing tests because the test
    // only inspected the URL fetched, never the actual server route.
    expect(observedUrls.some(u => u.startsWith('/api/global-config'))).toBe(true);
    expect(observedUrls.some(u => u.startsWith('/api/dashboard/global-config'))).toBe(false);
    expect(observedUrls.some(u => u.startsWith('/api/file-settings'))).toBe(false);
  });

  it('mutation PATCH after a grouping change also hits /api/global-config', async () => {
    await initPersistedHiddenTerminals();
    observedUrls.length = 0;
    const g = addGrouping('Servers');
    setActiveGrouping(DASHBOARD_SCOPE, g.id);
    _flushForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(observedUrls.some(u => u.startsWith('/api/global-config'))).toBe(true);
    expect(observedUrls.some(u => u.startsWith('/api/dashboard/global-config'))).toBe(false);
    expect(observedUrls.some(u => u.startsWith('/api/file-settings'))).toBe(false);
  });
});

/**
 * HS-8293 — pre-fix `refreshProjectTabs` re-ran `initPersistedHiddenTerminals`
 * on every poll cycle, which re-fetched `/api/global-config` and re-hydrated
 * the in-memory state. If the user toggled a row between the moment the
 * previous PATCH landed and the next poll's hydrate fired, the hydrate
 * clobbered the toggle with the (now-stale) server snapshot, and the
 * next debounced write's `lastPersisted` short-circuit suppressed the
 * PATCH that would have rescued it.
 */
describe('initPersistedHiddenTerminals — idempotency (HS-8293)', () => {
  let getCount: number;
  let patchCount: number;
  let serverState: { dashboard?: { visibilityGroupings?: VisibilityGrouping[]; activeVisibilityGroupingId?: string } };

  beforeEach(() => {
    getCount = 0;
    patchCount = 0;
    serverState = {};
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        getCount++;
        return Promise.resolve(new Response(JSON.stringify(serverState), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      patchCount++;
      // Crudely apply the PATCH to the in-test server state so a later
      // GET reflects what we just sent.
      try {
        const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
        const body = JSON.parse(bodyStr) as Partial<typeof serverState>;
        if (body.dashboard !== undefined) {
          serverState = { ...serverState, dashboard: { ...(serverState.dashboard ?? {}), ...body.dashboard } };
        }
      } catch { /* ignore */ }
      return Promise.resolve(new Response(JSON.stringify(serverState), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
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

  it('a second init call after the subscription is wired does NOT re-fetch /global-config', async () => {
    await initPersistedHiddenTerminals();
    expect(getCount).toBe(1);
    await initPersistedHiddenTerminals();
    await initPersistedHiddenTerminals();
    expect(getCount).toBe(1);
  });

  it('a second init call does NOT re-hydrate (in-memory state survives)', async () => {
    await initPersistedHiddenTerminals();
    // Simulate a user-driven in-memory toggle (the kind that lives only
    // on the client until the debounced PATCH fires).
    setTerminalHiddenInGrouping('s1', DEFAULT_GROUPING_ID, 'tA', true);
    expect(getGlobalVisibilityState().groupings[0].hiddenByProject.s1).toEqual(['tA']);
    // A fresh init (the pre-fix `refreshProjectTabs` call path) MUST NOT
    // re-hydrate — the server doesn't yet know about `tA` because the
    // debounce hasn't fired.
    await initPersistedHiddenTerminals();
    expect(getGlobalVisibilityState().groupings[0].hiddenByProject.s1).toEqual(['tA']);
  });

  it('rapid toggles + simulated re-init do NOT lose changes from the eventual PATCH', async () => {
    await initPersistedHiddenTerminals();
    // First toggle, debounce immediately flushed → server records `tA`.
    setTerminalHiddenInGrouping('s1', DEFAULT_GROUPING_ID, 'tA', true);
    _flushForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(patchCount).toBe(1);
    expect(serverState.dashboard?.visibilityGroupings?.[0]?.hiddenByProject?.s1).toEqual(['tA']);

    // User toggles `tB` BEFORE the next debounce fires; meanwhile the
    // poll-driven `refreshProjectTabs` re-runs init. Pre-fix the GET
    // would return `[tA]`, hydrate clobbered the in-memory `[tA, tB]`
    // back to `[tA]`, and the next debounce-flushed PATCH was
    // short-circuited by `lastPersisted`. Post-fix the second init is
    // a no-op so `tB` survives and the debounced write lands.
    setTerminalHiddenInGrouping('s1', DEFAULT_GROUPING_ID, 'tB', true);
    await initPersistedHiddenTerminals(); // simulated poll re-init
    _flushForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(patchCount).toBe(2);
    expect(serverState.dashboard?.visibilityGroupings?.[0]?.hiddenByProject?.s1?.sort())
      .toEqual(['tA', 'tB']);
  });
});
