/**
 * HS-8638 — dashboard / stats / poll / browse / worklist / skills / glassbox /
 * print typed-API module (mirrors the grab-bag `src/routes/dashboard.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  browse, BrowseResultSchema, DashboardDataSchema, ensureSkills, getDashboard, getGlassboxStatus,
  getStats, getWorklistInfo, launchGlassbox, pollVersion, printHtml, TicketStatsSchema,
} from './dashboard.js';

const dashboardData = {
  throughput: [{ date: '2026-05-01', completed: 2, created: 3 }],
  cycleTime: [{ ticket_number: 'HS-1', title: 'x', completed_at: 't', hours: 4 }],
  categoryBreakdown: [{ category: 'bug', count: 5 }],
  categoryPeriod: [{ category: 'bug', count: 2 }],
  snapshots: [{ date: '2026-05-01', data: { not_started: 1, started: 2, completed: 3, verified: 4 } }],
  kpi: { completedThisWeek: 1, completedLastWeek: 2, wipCount: 3, createdThisWeek: 4, medianCycleTimeDays: null },
};

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('dashboard domain schemas (HS-8638)', () => {
  it('DashboardDataSchema accepts a full payload (medianCycleTimeDays nullable)', () => {
    expect(DashboardDataSchema.safeParse(dashboardData).success).toBe(true);
    expect(DashboardDataSchema.safeParse({ ...dashboardData, kpi: { ...dashboardData.kpi, medianCycleTimeDays: 1.5 } }).success).toBe(true);
    expect(DashboardDataSchema.safeParse({ ...dashboardData, throughput: 'nope' }).success).toBe(false);
  });

  it('TicketStatsSchema + BrowseResultSchema', () => {
    expect(TicketStatsSchema.safeParse({ total: 1, open: 1, up_next: 0, by_category: {}, by_status: {} }).success).toBe(true);
    expect(BrowseResultSchema.safeParse({ path: '/p', parent: null, entries: [], hasHotsheet: false }).success).toBe(true);
    expect(BrowseResultSchema.safeParse({ path: '/p', parent: '/', entries: [{ name: 'a', path: '/p/a', hasHotsheet: true }], hasHotsheet: false }).success).toBe(true);
  });
});

describe('dashboard domain callers (HS-8638)', () => {
  it('getDashboard / getStats / pollVersion / browse build the right paths', async () => {
    stub(dashboardData);
    await getDashboard(7); expect(lastCall?.path).toBe('/dashboard?days=7');
    stub({ total: 0, open: 0, up_next: 0, by_category: {}, by_status: {} });
    await getStats(); expect(lastCall?.path).toBe('/stats');
    stub({ version: 5, dataVersion: 3 });
    expect(await pollVersion(4)).toEqual({ version: 5, dataVersion: 3 });
    expect(lastCall?.path).toBe('/poll?version=4');
    stub({ path: '/home', parent: null, entries: [], hasHotsheet: false });
    await browse('/home'); expect(lastCall?.path).toBe('/browse?path=%2Fhome');
    await browse(); expect(lastCall?.path).toBe('/browse');
  });

  it('worklist-info / ensure-skills / glassbox / print', async () => {
    stub({ prompt: 'Read…', skillCreated: false });
    expect(await getWorklistInfo()).toEqual({ prompt: 'Read…', skillCreated: false });
    stub({ updated: true });
    expect(await ensureSkills()).toEqual({ updated: true });
    expect(lastCall).toEqual({ path: '/ensure-skills', opts: { method: 'POST' } });
    stub({ available: true });
    expect(await getGlassboxStatus()).toEqual({ available: true });
    stub({ ok: true });
    await launchGlassbox(); expect(lastCall).toEqual({ path: '/glassbox/launch', opts: { method: 'POST' } });
    stub({ ok: true, path: '/tmp/print.html' });
    expect(await printHtml('<h1>x</h1>')).toEqual({ ok: true, path: '/tmp/print.html' });
    expect(lastCall).toEqual({ path: '/print', opts: { method: 'POST', body: { html: '<h1>x</h1>' } } });
  });
});
