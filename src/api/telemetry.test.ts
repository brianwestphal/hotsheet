/**
 * HS-8632 — telemetry typed-API module. Verifies the callers hit the right
 * path + method (and forward `skipProjectScope` for the cross-project
 * dashboard read), unwrap the small wrapper responses, and that the payload
 * schemas accept a real shape / reject a malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  clearProjectTelemetry, DashboardPayloadSchema, getPerTicketRollup, getProjectRollup,
  getPromptTimeline, getTelemetryDashboard, getTelemetryDebug, getTodayCost,
  getTodayCostByProject, isTelemetryEnabledAnywhere, PromptTimelineResponseSchema,
  TicketRollupSchema, WindowTotalsSchema,
} from './telemetry.js';

const wt = { cost: 1, tokens: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, promptCount: 1 };
const wtb = { today: wt, week: wt, month: wt, allTime: wt };
const dashboard = { window: 'month', windowTotals: wtb, costByProject: [], costByModel: [], hourlyActivity: [], costOverTime: [] };
const rollup = { window: 'month', windowTotals: wtb, costByModel: [], toolLatencyHistogram: [], recentPrompts: [], costOverTime: [] };
const timeline = { promptId: 'p', projectSecret: null, firstTs: null, lastTs: null, model: null, entries: [], spans: [], tracesEnabled: false };
const ticket = { ticketNumber: 'HS-1', promptCount: 0, totalCost: 0, totalTokens: 0, totalDurationSeconds: 0 };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('telemetry schemas (HS-8632)', () => {
  it('accepts valid payloads and rejects malformed ones', () => {
    expect(WindowTotalsSchema.safeParse(wt).success).toBe(true);
    expect(DashboardPayloadSchema.safeParse(dashboard).success).toBe(true);
    expect(PromptTimelineResponseSchema.safeParse(timeline).success).toBe(true);
    expect(TicketRollupSchema.safeParse(ticket).success).toBe(true);
    // Bad window enum.
    expect(DashboardPayloadSchema.safeParse({ ...dashboard, window: 'decade' }).success).toBe(false);
    // Wrong-typed totals.
    expect(WindowTotalsSchema.safeParse({ ...wt, cost: '1' }).success).toBe(false);
    // PromptTimeline missing the required tracesEnabled flag.
    expect(PromptTimelineResponseSchema.safeParse({ ...timeline, tracesEnabled: undefined }).success).toBe(false);
  });
});

describe('telemetry callers route to the right endpoint (HS-8632)', () => {
  it('getTodayCost → GET /telemetry/today-cost, unwrapped', async () => {
    stub({ cost: 4.2 });
    expect(await getTodayCost()).toBe(4.2);
    expect(lastCall?.path).toBe('/telemetry/today-cost');
  });

  it('getTodayCostByProject → GET …, unwrapped to the map', async () => {
    stub({ costs: { a: 1, b: 2 } });
    expect(await getTodayCostByProject()).toEqual({ a: 1, b: 2 });
    expect(lastCall?.path).toBe('/telemetry/today-cost-by-project');
  });

  it('getPromptTimeline → GET /telemetry/prompt/:id', async () => {
    stub(timeline);
    await getPromptTimeline('p 1/x');
    expect(lastCall?.path).toBe('/telemetry/prompt/p%201%2Fx');
  });

  it('getPerTicketRollup → GET /telemetry/ticket/:number', async () => {
    stub(ticket);
    expect(await getPerTicketRollup('HS-1')).toEqual(ticket);
    expect(lastCall?.path).toBe('/telemetry/ticket/HS-1');
  });

  it('isTelemetryEnabledAnywhere → GET …, unwrapped to boolean', async () => {
    stub({ enabled: true });
    expect(await isTelemetryEnabledAnywhere()).toBe(true);
    expect(lastCall?.path).toBe('/telemetry/enabled-anywhere');
  });

  it('getTelemetryDashboard → GET /telemetry/dashboard?window=&tz= with skipProjectScope', async () => {
    stub(dashboard);
    await getTelemetryDashboard('week', 'America/Los_Angeles');
    expect(lastCall?.path).toBe('/telemetry/dashboard?window=week&tz=America%2FLos_Angeles');
    expect(lastCall?.opts.skipProjectScope).toBe(true);
  });

  it('getProjectRollup → GET /telemetry/project-rollup?window=&tz= (project-scoped)', async () => {
    stub(rollup);
    await getProjectRollup('today', 'UTC');
    expect(lastCall?.path).toBe('/telemetry/project-rollup?window=today&tz=UTC');
    expect(lastCall?.opts.skipProjectScope).toBeUndefined();
  });

  it('clearProjectTelemetry → DELETE /telemetry/project-data', async () => {
    stub({ deleted: 12 });
    expect(await clearProjectTelemetry()).toEqual({ deleted: 12 });
    expect(lastCall).toEqual({ path: '/telemetry/project-data', opts: { method: 'DELETE' } });
  });

  it('getTelemetryDebug → GET /telemetry/_debug', async () => {
    stub({
      eventNames: [], tokenTypes: [], totalEvents: 0, distinctPromptIds: 0, distinctSessions: 0,
      markerEventsByName: [], distinctTicketMarkers: [], apiRequestAttrKeys: [],
    });
    await getTelemetryDebug();
    expect(lastCall?.path).toBe('/telemetry/_debug');
  });

  it('rejects a dashboard response that fails schema validation', async () => {
    stub({ ...dashboard, window: 'bogus' });
    await expect(getTelemetryDashboard('month', 'UTC')).rejects.toThrow(/response shape mismatch/);
  });
});
