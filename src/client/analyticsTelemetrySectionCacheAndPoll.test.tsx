// @vitest-environment happy-dom
/**
 * HS-8572 — coverage for the cache + live-refresh poll added to the
 * per-project analytics-dashboard telemetry section. Mirrors the
 * cross-project page's `crossProjectStatsPageCacheAndPoll.test.tsx`
 * but targets the analytics-section module + its `(projectSecret, window)`
 * cache key shape. `api` + `getActiveProject` are mocked so the
 * project secret + payload shape are controlled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _testing } from './analyticsTelemetrySection.js';
import type * as StateNS from './state.js';
import type { CostOverTimePoint } from './telemetryCostOverTimeChart.js';
import type { RecentPromptRow } from './telemetryRecentPromptsList.js';
import type { ToolLatencyHistogramRow } from './telemetryToolHistogram.js';

type TelemetryWindow = 'today' | 'week' | 'month' | '90d' | 'all';

interface WindowTotals { cost: number; tokens: number; promptCount: number }
interface ModelRollupRow { model: string; cost: number; tokens: number; promptCount: number }
interface ProjectRollupPayload {
  window: TelemetryWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByModel: ModelRollupRow[];
  toolLatencyHistogram: ToolLatencyHistogramRow[];
  recentPrompts: RecentPromptRow[];
  costOverTime: CostOverTimePoint[];
}

function totals(cost = 1): WindowTotals { return { cost, tokens: 1000, promptCount: 5 } }
function makePayload(overrides: Partial<ProjectRollupPayload> = {}): ProjectRollupPayload {
  const base: ProjectRollupPayload = {
    window: 'month',
    windowTotals: { today: totals(), week: totals(2), month: totals(5), allTime: totals(10) },
    costByModel: [],
    toolLatencyHistogram: [],
    recentPrompts: [],
    costOverTime: [],
  };
  return { ...base, ...overrides } as ProjectRollupPayload;
}

const mockApi = vi.fn<(path: string) => Promise<unknown>>();
vi.mock('./api.js', () => ({
  api: (path: string): Promise<unknown> => mockApi(path),
}));

const mockGetActiveProject = vi.fn<() => { secret: string } | null>();
vi.mock('./state.js', async () => {
  const actual = await vi.importActual<typeof StateNS>('./state.js');
  return {
    ...actual,
    getActiveProject: (): { secret: string } | null => mockGetActiveProject(),
  };
});

// Make the shared chart / list renderers no-op stubs so we don't have
// to wire their full DOM contracts here — the cache + poll surface
// doesn't depend on them.
vi.mock('./telemetryCostOverTimeChart.js', () => ({
  renderCostOverTimeChart: () => document.createElement('div'),
}));
vi.mock('./telemetryModelDonut.js', () => ({
  renderCostByModelDonut: () => document.createElement('div'),
}));
vi.mock('./telemetryToolHistogram.js', () => ({
  renderToolHistogramRow: () => document.createElement('div'),
}));
vi.mock('./telemetryRecentPromptsList.js', () => ({
  renderRecentPromptsList: () => document.createElement('div'),
}));
vi.mock('./telemetrySubscriptionDisclaimer.js', () => ({
  renderSubscriptionDisclaimer: () => document.createElement('div'),
}));

beforeEach(() => {
  mockApi.mockReset();
  mockGetActiveProject.mockReturnValue({ secret: 'proj-1' });
  _testing.resetHS8572();
  document.body.innerHTML = '';
});

afterEach(() => {
  _testing.resetHS8572();
  vi.useRealTimers();
});

describe('fetchAndPopulate — cache behavior', () => {
  it('shows "Loading Claude usage…" placeholder on the first fetch (no cache)', () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockReturnValue(new Promise(() => { /* never resolves */ }));

    void _testing.fetchAndPopulate(bodySlot, 'month');

    expect(bodySlot.querySelector('.analytics-telemetry-loading')?.textContent).toBe('Loading Claude usage…');
  });

  it('caches the payload after a successful fetch — keyed by (projectSecret, window)', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    expect(_testing.hasCachedHS8572('proj-1', 'month')).toBe(false);
    await _testing.fetchAndPopulate(bodySlot, 'month');

    expect(_testing.hasCachedHS8572('proj-1', 'month')).toBe(true);
    expect(_testing.getCacheSizeHS8572()).toBe(1);
  });

  it('paints the cached payload immediately on re-entry (no Loading placeholder)', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());
    await _testing.fetchAndPopulate(bodySlot, 'month');

    // Re-entry — hang the next fetch so cached must be what's painted.
    mockApi.mockReturnValue(new Promise(() => { /* never resolves */ }));
    void _testing.fetchAndPopulate(bodySlot, 'month');

    expect(bodySlot.querySelector('.analytics-telemetry-loading')).toBeNull();
    expect(bodySlot.querySelector('.analytics-telemetry-body')).not.toBeNull();
  });

  it('keeps cache entries independent across projects', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);

    mockGetActiveProject.mockReturnValue({ secret: 'proj-1' });
    mockApi.mockResolvedValueOnce(makePayload());
    await _testing.fetchAndPopulate(bodySlot, 'month');

    mockGetActiveProject.mockReturnValue({ secret: 'proj-2' });
    mockApi.mockResolvedValueOnce(makePayload());
    await _testing.fetchAndPopulate(bodySlot, 'month');

    expect(_testing.hasCachedHS8572('proj-1', 'month')).toBe(true);
    expect(_testing.hasCachedHS8572('proj-2', 'month')).toBe(true);
    expect(_testing.getCacheSizeHS8572()).toBe(2);
  });

  it('keeps cache entries independent across windows', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValueOnce(makePayload());
    mockApi.mockResolvedValueOnce(makePayload());

    await _testing.fetchAndPopulate(bodySlot, 'week');
    await _testing.fetchAndPopulate(bodySlot, '90d');

    expect(_testing.hasCachedHS8572('proj-1', 'week')).toBe(true);
    expect(_testing.hasCachedHS8572('proj-1', '90d')).toBe(true);
    expect(_testing.getCacheSizeHS8572()).toBe(2);
  });

  it('skips re-render when the fresh payload is identical to cached', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    const fixed = makePayload();
    mockApi.mockResolvedValue(fixed);

    await _testing.fetchAndPopulate(bodySlot, 'month');
    const body = bodySlot.querySelector('.analytics-telemetry-body') as HTMLElement;
    body.setAttribute('data-test-marker', '1');

    // Identical payload on the background tick.
    await _testing.fetchAndPopulate(bodySlot, 'month');

    expect(bodySlot.querySelector('.analytics-telemetry-body')?.getAttribute('data-test-marker')).toBe('1');
  });

  it('keeps showing cached when a background fetch errors', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValueOnce(makePayload());
    await _testing.fetchAndPopulate(bodySlot, 'month');
    const body = bodySlot.querySelector('.analytics-telemetry-body') as HTMLElement;
    body.setAttribute('data-test-marker', '1');

    mockApi.mockRejectedValueOnce(new Error('boom'));
    await _testing.fetchAndPopulate(bodySlot, 'month');

    expect(bodySlot.querySelector('.analytics-telemetry-error')).toBeNull();
    expect(bodySlot.querySelector('.analytics-telemetry-body')?.getAttribute('data-test-marker')).toBe('1');
  });

  it('paints the error state when the FIRST fetch fails (no cache to fall back on)', async () => {
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockRejectedValueOnce(new Error('first fail'));

    await _testing.fetchAndPopulate(bodySlot, 'month');

    expect(bodySlot.querySelector('.analytics-telemetry-error')).not.toBeNull();
    expect(bodySlot.querySelector('.analytics-telemetry-error-detail')?.textContent).toBe('first fail');
  });

  it('shows the empty placeholder when there is no active project', async () => {
    mockGetActiveProject.mockReturnValue(null);
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);

    await _testing.fetchAndPopulate(bodySlot, 'month');

    expect(bodySlot.querySelector('.analytics-telemetry-empty')).not.toBeNull();
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe('startAnalyticsPolling + stopAnalyticsPolling', () => {
  it('starts a 30 s interval and re-fetches on each tick', () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    expect(_testing.isPollingHS8572()).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(expect.stringContaining('window=month'));

    vi.advanceTimersByTime(30_000);
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  it('self-stops when the bodySlot leaves the document', () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    bodySlot.remove();
    vi.advanceTimersByTime(30_000);

    expect(mockApi).not.toHaveBeenCalled();
    expect(_testing.isPollingHS8572()).toBe(false);
  });

  it('self-stops when the active project changes', () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    mockGetActiveProject.mockReturnValue({ secret: 'proj-2' });
    vi.advanceTimersByTime(30_000);

    expect(mockApi).not.toHaveBeenCalled();
    expect(_testing.isPollingHS8572()).toBe(false);
  });

  it('self-stops when no active project', () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    mockGetActiveProject.mockReturnValue(null);
    vi.advanceTimersByTime(30_000);

    expect(mockApi).not.toHaveBeenCalled();
    expect(_testing.isPollingHS8572()).toBe(false);
  });

  it('stopAnalyticsPolling halts further ticks', () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    _testing.stopAnalyticsPolling();
    vi.advanceTimersByTime(30_000 * 5);

    expect(mockApi).not.toHaveBeenCalled();
    expect(_testing.isPollingHS8572()).toBe(false);
  });

  it('startAnalyticsPolling replaces a prior interval (no leak)', () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');

    vi.advanceTimersByTime(30_000);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('resetHS8572 clears cache + running interval', async () => {
    vi.useFakeTimers();
    const bodySlot = document.createElement('div');
    document.body.appendChild(bodySlot);
    mockApi.mockResolvedValue(makePayload());

    await _testing.fetchAndPopulate(bodySlot, 'month');
    _testing.startAnalyticsPolling(bodySlot, () => 'month', 'proj-1');
    expect(_testing.hasCachedHS8572('proj-1', 'month')).toBe(true);
    expect(_testing.isPollingHS8572()).toBe(true);

    _testing.resetHS8572();

    expect(_testing.hasCachedHS8572('proj-1', 'month')).toBe(false);
    expect(_testing.isPollingHS8572()).toBe(false);
  });
});
