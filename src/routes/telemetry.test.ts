/**
 * HS-8561 — unit coverage for `src/routes/telemetry.ts`. Pre-fix
 * coverage was 18.6%; this suite exercises every public route handler
 * + the private `anyProjectHasTelemetryEnabled` helper indirectly via
 * the `/enabled-anywhere` route. Mocks cover the `db/otelQueries`
 * surface + `file-settings` + `project-list` + `projects` so each
 * route's HTTP-shape contract is pinned without standing up PGLite.
 *
 * The assertions focus on the JSON response shape + parameter
 * defaulting (`window` defaults to `'month'`, `tz` defaults to
 * `'UTC'`, unknown windows fall back to `'month'`), since that's the
 * client-facing contract a future refactor needs to preserve.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

// --- Mocks ---
// Explicit return-type annotations keep `@typescript-eslint/no-unsafe-return`
// quiet (vi.fn defaults to `any`).

const mockTodayCost = vi.fn<(secret: string) => Promise<number>>();
const mockTodayCostByProject = vi.fn<() => Promise<Record<string, number>>>();
const mockPromptTimeline = vi.fn<(id: string) => Promise<unknown>>();
const mockPerTicketRollup = vi.fn<(num: string) => Promise<unknown>>();
const mockDashboardPayload = vi.fn<(window: string, tz: string, allowedSecrets: readonly string[] | null) => Promise<unknown>>();
const mockProjectRollup = vi.fn<(secret: string, window: string, tz: string) => Promise<unknown>>();
const mockClearProjectTelemetry = vi.fn<(secret: string) => Promise<{ deleted: number }>>();
const mockReadProjectList = vi.fn<() => string[]>();
const mockReadFileSettings = vi.fn<(dir: string) => Record<string, unknown>>();
const mockGetProjectBySecret = vi.fn<(s: string) => { dataDir: string; name: string; secret: string } | undefined>();
const mockGetAllProjects = vi.fn<() => Array<{ secret: string; dataDir: string; name: string }>>();

vi.mock('../db/otelQueries.js', () => ({
  getTodayCost: (secret: string): Promise<number> => mockTodayCost(secret),
  getTodayCostByProject: (): Promise<Record<string, number>> => mockTodayCostByProject(),
  getPromptTimeline: (id: string): Promise<unknown> => mockPromptTimeline(id),
  getPerTicketRollup: (num: string): Promise<unknown> => mockPerTicketRollup(num),
  getDashboardPayload: (window: string, tz: string, allowedSecrets: readonly string[] | null): Promise<unknown> => mockDashboardPayload(window, tz, allowedSecrets),
  getProjectRollupPayload: (secret: string, window: string, tz: string): Promise<unknown> => mockProjectRollup(secret, window, tz),
  clearProjectTelemetry: (secret: string): Promise<{ deleted: number }> => mockClearProjectTelemetry(secret),
}));

vi.mock('../project-list.js', () => ({
  readProjectList: (): string[] => mockReadProjectList(),
}));

vi.mock('../file-settings.js', () => ({
  readFileSettings: (dir: string): Record<string, unknown> => mockReadFileSettings(dir),
}));

vi.mock('../projects.js', () => ({
  getProjectBySecret: (s: string): { dataDir: string; name: string; secret: string } | undefined => mockGetProjectBySecret(s),
  getAllProjects: (): Array<{ secret: string; dataDir: string; name: string }> => mockGetAllProjects(),
}));

const { telemetryRoutes } = await import('./telemetry.js');

function buildApp(opts: { dataDir?: string; projectSecret?: string } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', (c, next) => {
    c.set('dataDir', opts.dataDir ?? '/tmp/proj/.hotsheet');
    c.set('projectSecret', opts.projectSecret ?? 'active-secret-123');
    return next();
  });
  app.route('/api', telemetryRoutes);
  return app;
}

beforeEach(() => {
  mockTodayCost.mockReset();
  mockTodayCostByProject.mockReset();
  mockPromptTimeline.mockReset();
  mockPerTicketRollup.mockReset();
  mockDashboardPayload.mockReset();
  mockProjectRollup.mockReset();
  mockClearProjectTelemetry.mockReset();
  mockReadProjectList.mockReset().mockReturnValue([]);
  mockReadFileSettings.mockReset().mockReturnValue({});
  mockGetProjectBySecret.mockReset().mockReturnValue(undefined);
  mockGetAllProjects.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /telemetry/today-cost', () => {
  it('returns the active project\'s single-number cost from getTodayCost', async () => {
    mockTodayCost.mockResolvedValue(1.23);
    const res = await buildApp().request('/api/telemetry/today-cost');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cost: 1.23 });
    expect(mockTodayCost).toHaveBeenCalledWith('active-secret-123');
  });

  it('returns zero when the project has no telemetry yet', async () => {
    mockTodayCost.mockResolvedValue(0);
    const res = await buildApp().request('/api/telemetry/today-cost');
    expect(await res.json()).toEqual({ cost: 0 });
  });
});

describe('GET /telemetry/today-cost-by-project', () => {
  it('returns the bulk by-project costs map verbatim', async () => {
    const costs = { 'secret-A': 0.5, 'secret-B': 2.7 };
    mockTodayCostByProject.mockResolvedValue(costs);
    const res = await buildApp().request('/api/telemetry/today-cost-by-project');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ costs });
  });

  it('returns an empty costs map when no project has cost today', async () => {
    mockTodayCostByProject.mockResolvedValue({});
    const res = await buildApp().request('/api/telemetry/today-cost-by-project');
    expect(await res.json()).toEqual({ costs: {} });
  });
});

describe('GET /telemetry/prompt/:id', () => {
  it('returns the timeline + tracesEnabled flag (project found, traces ON)', async () => {
    mockGetProjectBySecret.mockReturnValue({ dataDir: '/tmp/proj/.hotsheet', name: 'P', secret: 'active-secret-123' });
    mockReadFileSettings.mockReturnValue({ telemetry_traces_enabled: true });
    mockPromptTimeline.mockResolvedValue({ entries: [{ ts: '2026-01-01T00:00:00Z', event: 'prompt' }], spans: [] });
    const res = await buildApp().request('/api/telemetry/prompt/abc-def-123');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [{ ts: '2026-01-01T00:00:00Z', event: 'prompt' }],
      spans: [],
      tracesEnabled: true,
    });
    expect(mockPromptTimeline).toHaveBeenCalledWith('abc-def-123');
  });

  it('returns tracesEnabled:false when the project is registered but traces are off', async () => {
    mockGetProjectBySecret.mockReturnValue({ dataDir: '/tmp/proj/.hotsheet', name: 'P', secret: 'active-secret-123' });
    mockReadFileSettings.mockReturnValue({});
    mockPromptTimeline.mockResolvedValue({ entries: [], spans: [] });
    const res = await buildApp().request('/api/telemetry/prompt/xyz');
    expect(await res.json()).toEqual({ entries: [], spans: [], tracesEnabled: false });
  });

  it('returns tracesEnabled:false when the active secret matches no registered project', async () => {
    mockGetProjectBySecret.mockReturnValue(undefined);
    mockPromptTimeline.mockResolvedValue({ entries: [], spans: [] });
    const res = await buildApp().request('/api/telemetry/prompt/xyz');
    expect(await res.json()).toEqual({ entries: [], spans: [], tracesEnabled: false });
    // The settings read is skipped when the project isn't found — keeps
    // the route from hitting a missing dataDir.
    expect(mockReadFileSettings).not.toHaveBeenCalled();
  });
});

describe('GET /telemetry/ticket/:number', () => {
  it('returns the per-ticket rollup verbatim', async () => {
    const rollup = { ticketNumber: 'HS-1234', promptCount: 3, totalCost: 0.42, totalTokens: 5000, totalDurationSeconds: 47.3 };
    mockPerTicketRollup.mockResolvedValue(rollup);
    const res = await buildApp().request('/api/telemetry/ticket/HS-1234');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rollup);
    expect(mockPerTicketRollup).toHaveBeenCalledWith('HS-1234');
  });

  it('returns zero-shape when the ticket has no attributed prompts', async () => {
    const zero = { ticketNumber: 'HS-9999', promptCount: 0, totalCost: 0, totalTokens: 0, totalDurationSeconds: 0 };
    mockPerTicketRollup.mockResolvedValue(zero);
    const res = await buildApp().request('/api/telemetry/ticket/HS-9999');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(zero);
  });
});

describe('GET /telemetry/enabled-anywhere', () => {
  it('returns enabled:false when no project has telemetry on', async () => {
    mockReadProjectList.mockReturnValue(['/tmp/A/.hotsheet', '/tmp/B/.hotsheet']);
    mockReadFileSettings.mockReturnValue({}); // neither has telemetry_enabled
    const res = await buildApp().request('/api/telemetry/enabled-anywhere');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it('returns enabled:true when ANY project has telemetry on', async () => {
    mockReadProjectList.mockReturnValue(['/tmp/A/.hotsheet', '/tmp/B/.hotsheet']);
    mockReadFileSettings.mockImplementation((dir: string) => dir === '/tmp/B/.hotsheet' ? { telemetry_enabled: true } : {});
    const res = await buildApp().request('/api/telemetry/enabled-anywhere');
    expect(await res.json()).toEqual({ enabled: true });
  });

  it('returns enabled:false when the project list is empty', async () => {
    mockReadProjectList.mockReturnValue([]);
    const res = await buildApp().request('/api/telemetry/enabled-anywhere');
    expect(await res.json()).toEqual({ enabled: false });
  });

  it('short-circuits on first match (does NOT read every project after a hit)', async () => {
    mockReadProjectList.mockReturnValue(['/tmp/A/.hotsheet', '/tmp/B/.hotsheet', '/tmp/C/.hotsheet']);
    mockReadFileSettings.mockReturnValue({ telemetry_enabled: true });
    const res = await buildApp().request('/api/telemetry/enabled-anywhere');
    expect(await res.json()).toEqual({ enabled: true });
    // First call returns true → loop exits → only 1 readFileSettings call.
    expect(mockReadFileSettings).toHaveBeenCalledTimes(1);
  });
});

describe('GET /telemetry/dashboard', () => {
  it('passes window=month and tz=UTC as defaults when no query params are given', async () => {
    mockDashboardPayload.mockResolvedValue({ window: 'month', windowTotals: {}, costByProject: [], costByModel: [], hourlyActivity: [], costOverTime: [] });
    await buildApp().request('/api/telemetry/dashboard');
    expect(mockDashboardPayload).toHaveBeenCalledWith('month', 'UTC', expect.any(Array));
  });

  it('honors known window values', async () => {
    mockDashboardPayload.mockResolvedValue({});
    await buildApp().request('/api/telemetry/dashboard?window=week&tz=America/Los_Angeles');
    expect(mockDashboardPayload).toHaveBeenCalledWith('week', 'America/Los_Angeles', expect.any(Array));
  });

  it('coerces unknown window values back to month (defensive default)', async () => {
    mockDashboardPayload.mockResolvedValue({});
    await buildApp().request('/api/telemetry/dashboard?window=garbage');
    expect(mockDashboardPayload).toHaveBeenCalledWith('month', 'UTC', expect.any(Array));
  });

  // HS-8625 — the route scopes the cross-project payload to currently-loaded
  // project tabs by passing `getAllProjects()` secrets as allowedSecrets.
  it('passes the registered projects\' secrets as allowedSecrets (HS-8625)', async () => {
    mockGetAllProjects.mockReturnValue([
      { secret: 'sec-loaded-1', dataDir: '/a', name: 'A' },
      { secret: 'sec-loaded-2', dataDir: '/b', name: 'B' },
    ]);
    mockDashboardPayload.mockResolvedValue({});
    await buildApp().request('/api/telemetry/dashboard?window=all');
    expect(mockDashboardPayload).toHaveBeenCalledWith('all', 'UTC', ['sec-loaded-1', 'sec-loaded-2']);
  });

  it('accepts all five known windows', async () => {
    mockDashboardPayload.mockResolvedValue({});
    const app = buildApp();
    for (const w of ['today', 'week', 'month', '90d', 'all']) {
      await app.request(`/api/telemetry/dashboard?window=${w}`);
    }
    expect(mockDashboardPayload).toHaveBeenCalledTimes(5);
    expect(mockDashboardPayload.mock.calls.map(c => c[0])).toEqual(['today', 'week', 'month', '90d', 'all']);
  });

  it('returns the payload verbatim', async () => {
    const payload = { window: 'month', windowTotals: { today: { cost: 1 } } };
    mockDashboardPayload.mockResolvedValue(payload);
    const res = await buildApp().request('/api/telemetry/dashboard');
    expect(await res.json()).toEqual(payload);
  });
});

describe('GET /telemetry/project-rollup', () => {
  it('passes the active project secret + window=month + tz=UTC by default', async () => {
    mockProjectRollup.mockResolvedValue({});
    await buildApp().request('/api/telemetry/project-rollup');
    expect(mockProjectRollup).toHaveBeenCalledWith('active-secret-123', 'month', 'UTC');
  });

  it('honors window + tz query params', async () => {
    mockProjectRollup.mockResolvedValue({});
    await buildApp({ projectSecret: 'other-secret' }).request('/api/telemetry/project-rollup?window=90d&tz=Europe/Berlin');
    expect(mockProjectRollup).toHaveBeenCalledWith('other-secret', '90d', 'Europe/Berlin');
  });

  it('coerces unknown windows back to month', async () => {
    mockProjectRollup.mockResolvedValue({});
    await buildApp().request('/api/telemetry/project-rollup?window=zzz');
    expect(mockProjectRollup).toHaveBeenCalledWith('active-secret-123', 'month', 'UTC');
  });

  it('returns the payload verbatim', async () => {
    const payload = { window: 'month', windowTotals: { today: { cost: 0.05 } }, costByModel: [], toolLatencyHistogram: [], recentPrompts: [], costOverTime: [] };
    mockProjectRollup.mockResolvedValue(payload);
    const res = await buildApp().request('/api/telemetry/project-rollup');
    expect(await res.json()).toEqual(payload);
  });
});

describe('DELETE /telemetry/project-data (HS-8606 / §74)', () => {
  it('clears the active project\'s telemetry and returns the deleted count', async () => {
    mockClearProjectTelemetry.mockResolvedValue({ deleted: 42 });
    const res = await buildApp().request('/api/telemetry/project-data', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 42 });
    // Scoped to the active project's secret — never an unscoped wipe.
    expect(mockClearProjectTelemetry).toHaveBeenCalledWith('active-secret-123');
  });

  it('scopes the clear to whichever project secret is active', async () => {
    mockClearProjectTelemetry.mockResolvedValue({ deleted: 0 });
    await buildApp({ projectSecret: 'other-secret' }).request('/api/telemetry/project-data', { method: 'DELETE' });
    expect(mockClearProjectTelemetry).toHaveBeenCalledWith('other-secret');
  });

  it('refuses to clear when no project secret is resolved (no unscoped wipe)', async () => {
    const res = await buildApp({ projectSecret: '' }).request('/api/telemetry/project-data', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(mockClearProjectTelemetry).not.toHaveBeenCalled();
  });
});
