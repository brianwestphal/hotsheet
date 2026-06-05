// @vitest-environment happy-dom
/**
 * HS-8572 — coverage for the cache + live-refresh poll added to the
 * cross-project stats page. Exercises `fetchAndRender` directly via
 * the `_testingHS8572` escape hatch (which is also where the cache
 * reset hook lives, so each test starts from a clean slate). The
 * `api` import is mocked so we control payload shape + timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from '../api/_runner.js';
import { _testingHS8572,type DashboardPayload } from './crossProjectStatsPage.js';
import type * as MainSurfaceStateNS from './mainSurfaceState.js';

interface WindowTotals { cost: number; tokens: number; inputTokens: number; outputTokens: number; promptCount: number }
function totals(cost = 1): WindowTotals { return { cost, tokens: 1000, inputTokens: 700, outputTokens: 300, promptCount: 5 } }
function makePayload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  const base: DashboardPayload = {
    window: 'month',
    windowTotals: { today: totals(), week: totals(2), month: totals(5), allTime: totals(10) },
    costByProject: [],
    costByModel: [],
    hourlyActivity: [],
    costOverTime: [],
  };
  return { ...base, ...overrides };
}

const mockApi = vi.fn<(path: string, opts?: unknown) => Promise<unknown>>();
vi.mock('./api.js', () => ({
  api: (path: string, opts?: unknown): Promise<unknown> => mockApi(path, opts),
}));

// `mainSurfaceState.isCrossProjectStatsPageActive` gates the poll's
// self-stop branch. Forcing it true means the poll keeps ticking.
const mockIsActive = vi.fn<() => boolean>().mockReturnValue(true);
vi.mock('./mainSurfaceState.js', async () => {
  const actual = await vi.importActual<typeof MainSurfaceStateNS>('./mainSurfaceState.js');
  return {
    ...actual,
    isCrossProjectStatsPageActive: (): boolean => mockIsActive(),
  };
});

beforeEach(() => {
  mockApi.mockReset();
  // HS-8632 — the page now fetches via the typed `getTelemetryDashboard`, which
  // routes through the `_runner` transport; point it at `mockApi` so the
  // existing payload + timing control still drives it.
  setApiTransport((path, opts) => mockApi(path, opts));
  mockIsActive.mockReturnValue(true);
  _testingHS8572.reset();
  document.body.innerHTML = '';
});

afterEach(() => {
  _testingHS8572.reset();
  setApiTransport(null as unknown as ApiTransport);
  vi.useRealTimers();
});

describe('fetchAndRender — cache behavior', () => {
  it('shows "Loading dashboard…" placeholder on the first fetch (no cache)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    // Hang the API so the loading placeholder stays visible long
    // enough to assert on.
    mockApi.mockReturnValue(new Promise(() => { /* never resolves */ }));

    void _testingHS8572.fetchAndRender(container, 'month');

    expect(container.querySelector('.telemetry-dashboard-loading')?.textContent).toBe('Loading dashboard…');
  });

  it('caches the payload after a successful fetch', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload());

    expect(_testingHS8572.hasCached('month')).toBe(false);
    await _testingHS8572.fetchAndRender(container, 'month');

    expect(_testingHS8572.hasCached('month')).toBe(true);
    expect(_testingHS8572.getCacheSize()).toBe(1);
  });

  it('paints the cached payload immediately on re-entry (no Loading placeholder)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload({ window: 'month' }));
    await _testingHS8572.fetchAndRender(container, 'month');

    // Re-entry — hang the next fetch so cached must be what's painted.
    mockApi.mockReturnValue(new Promise(() => { /* never resolves */ }));
    void _testingHS8572.fetchAndRender(container, 'month');

    expect(container.querySelector('.telemetry-dashboard-loading')).toBeNull();
    expect(container.querySelector('.telemetry-dashboard-title')?.textContent).toBe('Cross-Project Stats');
  });

  it('keeps per-window cache entries independent', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValueOnce(makePayload({ window: 'week' }));
    mockApi.mockResolvedValueOnce(makePayload({ window: '90d' }));

    await _testingHS8572.fetchAndRender(container, 'week');
    await _testingHS8572.fetchAndRender(container, '90d');

    expect(_testingHS8572.hasCached('week')).toBe(true);
    expect(_testingHS8572.hasCached('90d')).toBe(true);
    expect(_testingHS8572.hasCached('month')).toBe(false);
    expect(_testingHS8572.getCacheSize()).toBe(2);
  });

  it('skips re-render when the fresh payload is identical to cached', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const fixed = makePayload();
    mockApi.mockResolvedValue(fixed);

    await _testingHS8572.fetchAndRender(container, 'month');
    // Mark the rendered shell with a sentinel marker; if the second
    // call re-renders, the marker is wiped.
    const shell = container.querySelector('.cross-project-stats-page') as HTMLElement;
    shell.setAttribute('data-test-marker', '1');

    // Identical payload returned again.
    await _testingHS8572.fetchAndRender(container, 'month');

    expect(container.querySelector('.cross-project-stats-page')?.getAttribute('data-test-marker')).toBe('1');
  });

  it('re-renders when the fresh payload differs from cached', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValueOnce(makePayload({ windowTotals: { today: totals(1), week: totals(2), month: totals(3), allTime: totals(10) } }));
    await _testingHS8572.fetchAndRender(container, 'month');
    const shell = container.querySelector('.cross-project-stats-page') as HTMLElement;
    shell.setAttribute('data-test-marker', '1');

    // Different payload (different all-time cost) returned on the
    // background poll.
    mockApi.mockResolvedValueOnce(makePayload({ windowTotals: { today: totals(1), week: totals(2), month: totals(3), allTime: totals(99) } }));
    await _testingHS8572.fetchAndRender(container, 'month');

    // Shell was rebuilt — marker is gone.
    expect(container.querySelector('.cross-project-stats-page')?.getAttribute('data-test-marker')).toBeNull();
  });

  it('keeps showing the cached payload when a background fetch errors', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValueOnce(makePayload());
    await _testingHS8572.fetchAndRender(container, 'month');
    const shell = container.querySelector('.cross-project-stats-page') as HTMLElement;
    shell.setAttribute('data-test-marker', '1');

    // Background poll fails — cached should remain visible.
    mockApi.mockRejectedValueOnce(new Error('boom'));
    await _testingHS8572.fetchAndRender(container, 'month');

    expect(container.querySelector('.telemetry-dashboard-error')).toBeNull();
    expect(container.querySelector('.cross-project-stats-page')?.getAttribute('data-test-marker')).toBe('1');
  });

  it('paints the error state when the FIRST fetch fails (no cache to fall back on)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockRejectedValueOnce(new Error('first fail'));

    await _testingHS8572.fetchAndRender(container, 'month');

    expect(container.querySelector('.telemetry-dashboard-error')).not.toBeNull();
    expect(container.querySelector('.telemetry-dashboard-error-detail')?.textContent).toBe('first fail');
  });

  it('tracks the currently-rendered window for the poll to pick up', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload({ window: 'week' }));

    await _testingHS8572.fetchAndRender(container, 'week');
    expect(_testingHS8572.getCurrentWindow()).toBe('week');
  });
});

describe('startPolling + stopPolling', () => {
  it('starts a 30s interval and re-fetches on each tick with the current window', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload());

    _testingHS8572.startPolling(container, () => 'month');
    expect(_testingHS8572.isPolling()).toBe(true);
    expect(mockApi).not.toHaveBeenCalled();

    // First tick.
    vi.advanceTimersByTime(30_000);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(
      expect.stringContaining('window=month'),
      expect.objectContaining({ skipProjectScope: true }),
    );

    // Second tick (60s mark).
    vi.advanceTimersByTime(30_000);
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  it('stops polling when isCrossProjectStatsPageActive returns false at a tick', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload());

    _testingHS8572.startPolling(container, () => 'month');
    mockIsActive.mockReturnValue(false); // user navigated away
    vi.advanceTimersByTime(30_000);

    expect(mockApi).not.toHaveBeenCalled();
    expect(_testingHS8572.isPolling()).toBe(false);
  });

  it('stopPolling() halts further ticks', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload());

    _testingHS8572.startPolling(container, () => 'month');
    _testingHS8572.stopPolling();
    vi.advanceTimersByTime(30_000 * 5);

    expect(mockApi).not.toHaveBeenCalled();
    expect(_testingHS8572.isPolling()).toBe(false);
  });

  it('startPolling() replaces a prior interval (no leak)', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload());

    _testingHS8572.startPolling(container, () => 'month');
    _testingHS8572.startPolling(container, () => 'month'); // second call

    vi.advanceTimersByTime(30_000);
    // Only ONE fetch per tick — the prior interval was cleared.
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('reset() clears both the cache and the running interval', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockApi.mockResolvedValue(makePayload());

    await _testingHS8572.fetchAndRender(container, 'month');
    _testingHS8572.startPolling(container, () => 'month');
    expect(_testingHS8572.hasCached('month')).toBe(true);
    expect(_testingHS8572.isPolling()).toBe(true);

    _testingHS8572.reset();

    expect(_testingHS8572.hasCached('month')).toBe(false);
    expect(_testingHS8572.isPolling()).toBe(false);
    expect(_testingHS8572.getCacheSize()).toBe(0);
  });
});
