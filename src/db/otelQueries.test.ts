/**
 * HS-8148 — rollup query tests. Seed `otel_metrics` / `otel_events`
 * rows for a known project, then assert each rollup function returns
 * the expected shape.
 */
import { rmSync } from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDataDir, getDb, getDbForDir, getRollupDb, getTelemetryDb, runWithDataDir, telemetryClusterDataDir } from './connection.js';
import { appendOtelJsonl } from './otelJsonlStore.js';
import {
  clearProjectTelemetry,
  getCostByModel,
  getCostByProject,
  getCostOverTime,
  getDashboardPayload,
  getHourlyActivityHeatmap,
  getIngestedDates,
  getPerTicketRollup,
  getProjectRollupPayload,
  getPromptTimeline,
  getQuerySourceRollup,
  getRecentPrompts,
  getTelemetryDebugInfo,
  getTodayCost,
  getToolLatencyHistogram,
  getToolRollup,
  getWindowTotals,
  resolveDashboardWindowSinceTs,
  sanitizePromptSnippet,
} from './otelQueries.js';
import { backfillTicketPromptSpansForDir, backfillTicketsForDir } from './otelRollupBackfill.js';
import { markDailySeen, markHourlySeenPrompt, recordHourCost, recordToolActivity, updateDailyRollup } from './otelRollupIngest.js';

// HS-8874 — isolate the central store to a temp dir so the cross-project
// fan-out (which also reads central) can't pick up rows from the developer's
// real `~/.hotsheet/telemetry` (see otelWriters.test.ts).
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

const SECRET_A = 'secret-A';
const SECRET_B = 'secret-B';

async function insertCostMetric(opts: {
  ts: Date;
  projectSecret: string;
  model?: string;
  source?: string;
  cost: number;
  // HS-8708 — optional OTLP temporality columns. Omitted ⇒ NULL (the legacy
  // pre-HS-8600 shape Hot Sheet's own delta-forcing spawn env always produced).
  temporality?: 'delta' | 'cumulative';
  isMonotonic?: boolean;
}): Promise<void> {
  const db = await getTelemetryDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
  if (opts.source !== undefined) attrs['query.source'] = opts.source;
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [opts.ts, opts.projectSecret, 'session-1', 'claude_code.cost.usage', JSON.stringify(attrs), JSON.stringify({ asDouble: opts.cost }), opts.temporality ?? null, opts.isMonotonic ?? null],
  );
  // HS-9235 — mirror ingest's rollup dual-write so the repointed reads (which now
  // read the rollup tables in the main db) see the seeded data. `mainDb` resolves
  // to the same context the read will use, so per-project isolation is preserved.
  const mainDb = await getRollupDb();
  await updateDailyRollup(mainDb, opts.projectSecret, opts.ts, 'claude_code.cost.usage', opts.cost, attrs, { temporality: opts.temporality ?? null, isMonotonic: opts.isMonotonic ?? null });
  await markDailySeen(mainDb, opts.projectSecret, opts.ts, 'session', typeof attrs['session.id'] === 'string' ? attrs['session.id'] : null);
  // HS-9278 — getTelemetryDebugInfo reads metrics from the JSONL store; mirror ingest.
  await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'metrics', opts.ts, {
    ts: opts.ts.toISOString(), project_secret: opts.projectSecret, session_id: 'session-1',
    metric_name: 'claude_code.cost.usage', attributes_json: attrs, value_json: { asDouble: opts.cost },
    aggregation_temporality: opts.temporality ?? null, is_monotonic: opts.isMonotonic ?? null,
  });
  // HS-9279 — getHourlyActivityHeatmap reads the kind='hour' cost rollup; mirror ingest
  // (delta cost only, like the writer). Cumulative-monotonic rows are excluded there.
  if (opts.temporality !== 'cumulative' || opts.isMonotonic !== true) {
    await recordHourCost(mainDb, opts.projectSecret, opts.ts, opts.cost);
  }
}

async function insertTokenMetric(opts: {
  ts: Date;
  projectSecret: string;
  model?: string;
  type?: string;
  tokens: number;
  // HS-8708 — see insertCostMetric.
  temporality?: 'delta' | 'cumulative';
  isMonotonic?: boolean;
}): Promise<void> {
  const db = await getTelemetryDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
  if (opts.type !== undefined) attrs.type = opts.type;
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [opts.ts, opts.projectSecret, 'session-1', 'claude_code.token.usage', JSON.stringify(attrs), JSON.stringify({ asInt: opts.tokens }), opts.temporality ?? null, opts.isMonotonic ?? null],
  );
  // HS-9235 — dual-write the daily rollup (mirrors ingest).
  const mainDb = await getRollupDb();
  await updateDailyRollup(mainDb, opts.projectSecret, opts.ts, 'claude_code.token.usage', opts.tokens, attrs, { temporality: opts.temporality ?? null, isMonotonic: opts.isMonotonic ?? null });
  await markDailySeen(mainDb, opts.projectSecret, opts.ts, 'session', typeof attrs['session.id'] === 'string' ? attrs['session.id'] : null);
  // HS-9278 — getTelemetryDebugInfo reads metrics from the JSONL store; mirror ingest.
  await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'metrics', opts.ts, {
    ts: opts.ts.toISOString(), project_secret: opts.projectSecret, session_id: 'session-1',
    metric_name: 'claude_code.token.usage', attributes_json: attrs, value_json: { asInt: opts.tokens },
    aggregation_temporality: opts.temporality ?? null, is_monotonic: opts.isMonotonic ?? null,
  });
}

async function insertPromptEvent(opts: {
  ts: Date;
  projectSecret: string;
  promptId: string;
  model?: string;
}): Promise<void> {
  const db = await getTelemetryDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
  await db.query(
    `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [opts.ts, opts.projectSecret, 'session-1', opts.promptId, 'claude_code.user_prompt', JSON.stringify(attrs), JSON.stringify({})],
  );
  // HS-9235 — mark this prompt seen (mirrors ingest; every event with a prompt_id).
  await markDailySeen(await getRollupDb(), opts.projectSecret, opts.ts, 'prompt', opts.promptId);
  // HS-9278 — getRecentPrompts now reads the JSONL store, so mirror ingest's
  // dual-write into the ambient cluster dir.
  await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'events', opts.ts, {
    ts: opts.ts.toISOString(), project_secret: opts.projectSecret, session_id: 'session-1',
    prompt_id: opts.promptId, event_name: 'claude_code.user_prompt', attributes_json: attrs, body_json: {},
  });
  // HS-9279 — getHourlyActivityHeatmap's distinct-prompt count reads otel_hourly_seen;
  // a user_prompt marks the (day, hour) dedup (mirrors ingest).
  await markHourlySeenPrompt(await getRollupDb(), opts.projectSecret, opts.ts, opts.promptId);
}

async function insertToolResultEvent(opts: {
  ts: Date;
  projectSecret: string;
  toolName: string;
  durationMs?: number;
}): Promise<void> {
  const db = await getTelemetryDb();
  const attrs: Record<string, unknown> = { tool_name: opts.toolName };
  if (opts.durationMs !== undefined) attrs.duration_ms = opts.durationMs;
  await db.query(
    `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [opts.ts, opts.projectSecret, 'session-1', 'prompt-1', 'claude_code.tool_result', JSON.stringify(attrs), JSON.stringify({})],
  );
  // HS-9235 — mark this prompt seen (mirrors ingest; counts distinct prompt_id
  // across ALL event names, so a tool_result's prompt_id counts like any other).
  await markDailySeen(await getRollupDb(), opts.projectSecret, opts.ts, 'prompt', 'prompt-1');
  // HS-9278 — getTelemetryDebugInfo / getRecentPrompts read events from JSONL.
  await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'events', opts.ts, {
    ts: opts.ts.toISOString(), project_secret: opts.projectSecret, session_id: 'session-1',
    prompt_id: 'prompt-1', event_name: 'claude_code.tool_result', attributes_json: attrs, body_json: {},
  });
  // HS-9279 — getToolRollup now reads the otel_rollup_activity rollup; mirror ingest.
  await recordToolActivity(await getRollupDb(), opts.projectSecret, opts.ts, attrs);
}

// HS-9235 — the dashboard aggregate reads (getWindowTotals / getCostByModel /
// getCostByProject / getCostOverTime / getTodayCost / getIngestedDates) now read
// the daily ROLLUP tables in the MAIN db. The `insert*` helpers above dual-write
// those rollups (mirroring ingest) so seeding populates both raw and rollup in
// the SAME db context the read uses — preserving per-project isolation and the
// clear-telemetry behavior without any per-test backfill call.

describe('otel rollup queries (HS-8148 / §67.10.2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb(tempDir);
  });

  describe('getWindowTotals', () => {
    it('sums cost + tokens + counts distinct prompts across a project', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.25 });
      // HS-9235 — `type: 'input'` (real Claude token.usage always carries a type;
      // the rollup buckets real-work tokens into input/output columns, so an
      // untyped token would land in datapoint_count only).
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 1000 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1' });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p2' });

      const result = await getWindowTotals(SECRET_A, null);
      expect(result.cost).toBe(0.75);
      expect(result.tokens).toBe(1000);
      expect(result.promptCount).toBe(2);
    });

    it('isolates rows by project_secret', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 5.0 });

      const a = await getWindowTotals(SECRET_A, null);
      expect(a.cost).toBe(0.5);
      const b = await getWindowTotals(SECRET_B, null);
      expect(b.cost).toBe(5.0);
    });

    it('null projectSecret aggregates across every project', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 1.0 });

      const all = await getWindowTotals(null, null);
      expect(all.cost).toBe(1.5);
    });

    it('respects the sinceTs window filter', async () => {
      const now = new Date();
      const longAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: longAgo, projectSecret: SECRET_A, cost: 99.0 });

      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const recent = await getWindowTotals(SECRET_A, oneHourAgo);
      expect(recent.cost).toBe(0.5);
    });

    it('splits real-work tokens into input + output, excluding cache (HS-8628)', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 700 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'output', tokens: 300 });
      // cacheRead must NOT inflate the total nor count toward input/output.
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cacheRead', tokens: 50_000 });

      const result = await getWindowTotals(SECRET_A, null);
      expect(result.tokens).toBe(1000); // input + output only (HS-8627)
      expect(result.inputTokens).toBe(700);
      expect(result.outputTokens).toBe(300);
    });

    // HS-8639 — the cache pieces are surfaced (excluded from `tokens`, but
    // shown so the authoritative cost reconciles). Both camelCase + snake_case.
    it('surfaces cacheRead + cacheCreation tokens without inflating the total (HS-8639)', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 700 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'output', tokens: 300 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cacheRead', tokens: 50_000 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cache_creation', tokens: 12_000 });

      const result = await getWindowTotals(SECRET_A, null);
      expect(result.tokens).toBe(1000); // unchanged — cache still excluded
      expect(result.cacheReadTokens).toBe(50_000);
      expect(result.cacheCreationTokens).toBe(12_000);
    });

    // HS-8639 — prompt count counts distinct prompt_id across ALL event types,
    // not only `claude_code.user_prompt`, so it stays correct when that
    // specific event doesn't flush but api_request / tool_result events do.
    it('counts distinct prompt_id across all event types (HS-8639)', async () => {
      const now = new Date();
      // No user_prompt events at all — only a tool_result carrying a prompt_id.
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Bash' }); // prompt-1
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 1 });

      const result = await getWindowTotals(SECRET_A, null);
      expect(result.promptCount).toBe(1); // from tool_result's prompt_id, not the session fallback
    });

    // HS-8639 — when NO event carries a prompt_id (log events not flowing),
    // fall back to the session-count proxy from the metrics table. Claude Code
    // stamps `session.id` on each cost.usage data-point's attributes.
    it('falls back to distinct session count when no event has a prompt_id (HS-8639)', async () => {
      const now = new Date();
      const db = await getTelemetryDb();
      const mainDb = await getRollupDb();
      for (const sid of ['sess-1', 'sess-1', 'sess-2']) {
        await db.query(
          `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [now, SECRET_A, null, 'claude_code.cost.usage', JSON.stringify({ 'session.id': sid }), JSON.stringify({ asDouble: 1 })],
        );
        // HS-9235 — this test seeds raw directly (bypassing the dual-writing
        // helper), so mark the session seen + roll up the cost as ingest would.
        await updateDailyRollup(mainDb, SECRET_A, now, 'claude_code.cost.usage', 1, { 'session.id': sid }, { temporality: null, isMonotonic: null });
        await markDailySeen(mainDb, SECRET_A, now, 'session', sid);
      }
      const result = await getWindowTotals(SECRET_A, null);
      expect(result.promptCount).toBe(2); // 2 distinct session.id, no prompt_id events
    });
  });

  // HS-8639 — the read-only diagnostic that pins whether log events arrive.
  describe('getTelemetryDebugInfo', () => {
    it('reports the event_name + token-type distributions for the project', async () => {
      const now = new Date();
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1' });
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Bash' });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 700 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cacheRead', tokens: 50_000 });
      // Different project — must not leak in.
      await insertPromptEvent({ ts: now, projectSecret: SECRET_B, promptId: 'other' });

      const info = await getTelemetryDebugInfo(SECRET_A);
      const names = Object.fromEntries(info.eventNames.map(e => [e.eventName, e]));
      expect(names['claude_code.user_prompt'].count).toBe(1);
      expect(names['claude_code.user_prompt'].withPromptId).toBe(1);
      expect(names['claude_code.tool_result'].count).toBe(1);
      expect(info.totalEvents).toBe(2);
      expect(info.distinctPromptIds).toBe(2); // p1 + prompt-1 (tool_result)
      const types = Object.fromEntries(info.tokenTypes.map(t => [t.type, t.tokens]));
      expect(types['input']).toBe(700);
      expect(types['cacheRead']).toBe(50_000);
    });

    // HS-8537 — the per-ticket-rollup diagnosis fields: marker presence by
    // event_name, distinct ticket markers, and api_request attribute keys.
    it('surfaces marker presence + api_request attribute keys (HS-8537)', async () => {
      const now = new Date();
      const db = await getTelemetryDb();
      // A user_prompt event whose body carries the ticket marker (the shape the
      // rollup keys on) + an api_request event carrying cost / token attrs.
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [now, SECRET_A, 'session-1', 'pm', 'user_prompt', '{}', JSON.stringify({ body: '<!-- hotsheet:ticket=HS-42 --> do it' })],
      );
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [now, SECRET_A, 'session-1', 'pm', 'api_request', JSON.stringify({ cost: 0.5, tokens: 100, model: 'opus' }), '{}'],
      );
      // HS-9278 — getTelemetryDebugInfo reads events from the JSONL store.
      const clusterDir = telemetryClusterDataDir(getDataDir());
      await appendOtelJsonl(clusterDir, 'events', now, {
        ts: now.toISOString(), project_secret: SECRET_A, session_id: 'session-1',
        prompt_id: 'pm', event_name: 'user_prompt', attributes_json: {}, body_json: { body: '<!-- hotsheet:ticket=HS-42 --> do it' },
      });
      await appendOtelJsonl(clusterDir, 'events', now, {
        ts: now.toISOString(), project_secret: SECRET_A, session_id: 'session-1',
        prompt_id: 'pm', event_name: 'api_request', attributes_json: { cost: 0.5, tokens: 100, model: 'opus' }, body_json: {},
      });

      const info = await getTelemetryDebugInfo(SECRET_A);
      const markerByName = Object.fromEntries(info.markerEventsByName.map(m => [m.eventName, m.count]));
      expect(markerByName['user_prompt']).toBe(1);
      expect(info.distinctTicketMarkers).toContain('HS-42');
      expect(info.apiRequestAttrKeys).toEqual(expect.arrayContaining(['cost', 'tokens', 'model']));
    });

    // HS-8793 — `dailyMetricCounts` is the "why is day X empty" diagnostic: a
    // GLOBAL (cross-project), per-local-day raw row count. It must (a) count
    // rows on a day that HAS data, (b) include OTHER projects' rows even when
    // called with one project's secret (so orphaned-secret data is visible),
    // and (c) NOT invent a row for a day with no metrics (the gap).
    it('reports global per-day metric counts across projects (HS-8793 / HS-8874 fan-out)', async () => {
      const dayWith = new Date();                                    // today — has data
      const yesterday = new Date(dayWith.getTime() - 24 * 60 * 60 * 1000);
      await insertCostMetric({ ts: dayWith, projectSecret: SECRET_A, cost: 1.0 });
      await insertTokenMetric({ ts: dayWith, projectSecret: SECRET_A, type: 'input', tokens: 100 });
      // A different project's row on the SAME day — must appear even though we
      // query with SECRET_A (the orphaned-secret detection case). Both rows live
      // in the same (test) DB here.
      await insertCostMetric({ ts: dayWith, projectSecret: SECRET_B, cost: 2.0 });
      // `yesterday` deliberately has NO rows — it must be absent from the result.

      // HS-8874 — `dailyMetricCounts` now fans out across `getAllProjects()` DBs
      // + central. Register the test DB as a project so the fan-out includes it.
      registerExistingProject(tempDir, SECRET_A, await getDb());
      try {
        const info = await getTelemetryDebugInfo(SECRET_A, 'UTC');
        const todayStr = info.dailyMetricCounts[0]?.date ?? '';
        const onToday = info.dailyMetricCounts.filter(r => r.date === todayStr);
        // cost.usage(A) + token.usage(A) + cost.usage(B) = 3 distinct (date,metric,secret) rows.
        expect(onToday).toHaveLength(3);
        expect(onToday.some(r => r.projectSecret === SECRET_B && r.metricName === 'claude_code.cost.usage')).toBe(true);
        expect(onToday.some(r => r.projectSecret === SECRET_A && r.metricName === 'claude_code.token.usage')).toBe(true);
        // The empty day is simply not present — the chart fills it with 0 / "No cost".
        const yStr = yesterday.toISOString().slice(0, 10);
        if (yStr !== todayStr) expect(info.dailyMetricCounts.some(r => r.date === yStr)).toBe(false);
      } finally {
        unregisterProject(SECRET_A);
      }
    });
  });

  describe('getCostByModel', () => {
    it('groups cost + tokens by model attribute', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', cost: 1.0 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'opus-4', cost: 4.0 });
      // HS-9235 — typed tokens (the rollup buckets real-work tokens by type).
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', type: 'input', tokens: 2000 });

      const rollup = await getCostByModel(SECRET_A, null);
      // Ordered by cost DESC.
      expect(rollup).toHaveLength(2);
      expect(rollup[0]).toMatchObject({ model: 'opus-4', cost: 4.0 });
      expect(rollup[1]).toMatchObject({ model: 'sonnet-4', cost: 1.5, tokens: 2000 });
    });

    it('splits per-model tokens into input + output, excluding cache (HS-8628)', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', cost: 3.0 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', type: 'input', tokens: 800 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', type: 'output', tokens: 200 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', type: 'cacheRead', tokens: 90_000 });

      const rollup = await getCostByModel(SECRET_A, null);
      expect(rollup).toHaveLength(1);
      expect(rollup[0]).toMatchObject({
        model: 'sonnet-4', cost: 3.0, tokens: 1000, inputTokens: 800, outputTokens: 200,
      });
    });
  });

  describe('getToolRollup', () => {
    it('counts tool_result events by tool_name + averages duration', async () => {
      const now = new Date();
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 100 });
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 200 });
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Read', durationMs: 50 });

      const rollup = await getToolRollup(SECRET_A, null);
      expect(rollup).toHaveLength(2);
      // Sorted by count DESC.
      expect(rollup[0].tool).toBe('Edit');
      expect(rollup[0].count).toBe(2);
      expect(rollup[0].avgDurationMs).toBe(150);
      expect(rollup[1].tool).toBe('Read');
      expect(rollup[1].count).toBe(1);
    });
  });

  describe('getQuerySourceRollup', () => {
    it('groups cost by query.source attribute', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, source: 'main_agent', cost: 0.8 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, source: 'subagent', cost: 0.2 });

      const rollup = await getQuerySourceRollup(SECRET_A, null);
      expect(rollup).toHaveLength(2);
      expect(rollup[0]).toMatchObject({ source: 'main_agent', cost: 0.8 });
      expect(rollup[1]).toMatchObject({ source: 'subagent', cost: 0.2 });
    });
  });

  describe('getRecentPrompts', () => {
    it('returns the latest N prompts newest-first', async () => {
      const t1 = new Date('2026-05-20T10:00:00Z');
      const t2 = new Date('2026-05-20T11:00:00Z');
      const t3 = new Date('2026-05-20T12:00:00Z');
      await insertPromptEvent({ ts: t1, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet-4' });
      await insertPromptEvent({ ts: t2, projectSecret: SECRET_A, promptId: 'p2' });
      await insertPromptEvent({ ts: t3, projectSecret: SECRET_A, promptId: 'p3', model: 'opus-4' });

      const recent = await getRecentPrompts(SECRET_A, 50);
      expect(recent).toHaveLength(3);
      expect(recent[0].promptId).toBe('p3');
      expect(recent[0].model).toBe('opus-4');
      expect(recent[1].promptId).toBe('p2');
      expect(recent[1].model).toBeNull();
      expect(recent[2].promptId).toBe('p1');
    });

    it('clamps the limit to a sane bound', async () => {
      const now = new Date();
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1' });
      // limit 99999 should still work (clamped to 500); just ensure no SQL error.
      const result = await getRecentPrompts(SECRET_A, 99999);
      expect(result).toHaveLength(1);
    });

    // HS-8779 — each prompt is enriched with model / token / cost / duration /
    // tool aggregates joined from its api_request + tool_result events.
    it('enriches a prompt with model, token, cost, duration, and tool aggregates', async () => {
      const db = await getTelemetryDb();
      const insert = async (ts: Date, eventName: string, attrs: Record<string, unknown>): Promise<void> => {
        await db.query(
          `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
          [ts, SECRET_A, 'session-1', 'pA', eventName, JSON.stringify(attrs), JSON.stringify({})],
        );
        // HS-9278 — getRecentPrompts reads JSONL; dual-write into the ambient cluster.
        await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'events', ts, {
          ts: ts.toISOString(), project_secret: SECRET_A, session_id: 'session-1',
          prompt_id: 'pA', event_name: eventName, attributes_json: attrs, body_json: {},
        });
      };
      const t0 = new Date('2026-05-20T10:00:00Z');
      const t1 = new Date('2026-05-20T10:00:02Z'); // +2s
      const t2 = new Date('2026-05-20T10:00:05Z'); // +5s
      await insert(t0, 'claude_code.user_prompt', {}); // model absent on user_prompt
      await insert(t1, 'claude_code.api_request', { model: 'sonnet-4', input_tokens: 1000, output_tokens: 200, cost: 0.03 });
      await insert(t2, 'claude_code.api_request', { input_tokens: 500, output_tokens: 100, cost: 0.02 });
      await insert(t1, 'claude_code.tool_result', { tool_name: 'Bash' });
      await insert(t2, 'claude_code.tool_result', { tool_name: 'Read' });

      const [row] = await getRecentPrompts(SECRET_A, 10);
      expect(row.promptId).toBe('pA');
      expect(row.model).toBe('sonnet-4');   // user_prompt lacked it → fell back to api_request
      expect(row.inputTokens).toBe(1500);
      expect(row.outputTokens).toBe(300);
      expect(row.totalTokens).toBe(1800);
      expect(row.costUsd).toBeCloseTo(0.05, 5);
      expect(row.toolCount).toBe(2);
      expect(row.durationMs).toBe(5000);    // last event (t2) − first event (t0)
    });

    it('leaves aggregates null when a prompt has only the user_prompt event', async () => {
      await insertPromptEvent({ ts: new Date('2026-05-20T10:00:00Z'), projectSecret: SECRET_A, promptId: 'pB', model: 'opus-4' });
      const [row] = await getRecentPrompts(SECRET_A, 10);
      expect(row.model).toBe('opus-4');
      expect(row.totalTokens).toBeNull();
      expect(row.costUsd).toBeNull();
      expect(row.toolCount).toBeNull();
      expect(row.durationMs).toBe(0); // single event → zero span
    });

    // HS-9278 — the JSONL read filters by project_secret; a scoped query must not
    // surface another project's prompts (both live in the same ambient cluster file).
    it('scopes to the requested project (excludes other projects’ prompts)', async () => {
      const now = new Date();
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'pa', model: 'a' });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_B, promptId: 'pb', model: 'b' });
      const a = await getRecentPrompts(SECRET_A, 10);
      expect(a.map(r => r.promptId)).toEqual(['pa']);
      const b = await getRecentPrompts(SECRET_B, 10);
      expect(b.map(r => r.promptId)).toEqual(['pb']);
    });
  });

  // HS-8779 — pure body→snippet sanitizer (no DB).
  describe('sanitizePromptSnippet', () => {
    it('returns null for null, empty, or event-name-only bodies', () => {
      expect(sanitizePromptSnippet(null)).toBeNull();
      expect(sanitizePromptSnippet('   ')).toBeNull();
      expect(sanitizePromptSnippet('claude_code.user_prompt')).toBeNull();
    });

    it('strips the hotsheet ticket marker and collapses whitespace', () => {
      expect(sanitizePromptSnippet('<!-- hotsheet:ticket=HS-42 -->  Fix the   login bug'))
        .toBe('Fix the login bug');
    });

    it('truncates a long prompt at a word boundary with an ellipsis', () => {
      const long = 'Please refactor the entire authentication subsystem and also update every single call site across the whole codebase right now';
      const out = sanitizePromptSnippet(long, 40);
      expect(out?.endsWith('…')).toBe(true);
      expect((out ?? '').length).toBeLessThanOrEqual(40);
    });
  });

  describe('getTodayCost (HS-8147)', () => {
    it('sums cost_usage data points since local midnight for the project', async () => {
      const now = new Date();
      const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await insertCostMetric({ ts: morning, projectSecret: SECRET_A, cost: 0.42 });
      await insertCostMetric({ ts: morning, projectSecret: SECRET_A, cost: 0.18 });
      await insertCostMetric({ ts: yesterday, projectSecret: SECRET_A, cost: 99.0 });

      const cost = await getTodayCost(SECRET_A);
      expect(cost).toBe(0.60);
    });

    it('returns 0 for a project with no telemetry yet', async () => {
      const cost = await getTodayCost(SECRET_A);
      expect(cost).toBe(0);
    });

    it('isolates by project_secret', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 5.0 });

      expect(await getTodayCost(SECRET_A)).toBe(0.5);
      expect(await getTodayCost(SECRET_B)).toBe(5.0);
    });
  });

  describe('getPromptTimeline (HS-8149)', () => {
    async function insertEvent(opts: {
      ts: Date;
      projectSecret: string;
      promptId: string;
      eventName: string;
      attrs?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }): Promise<void> {
      const db = await getTelemetryDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', opts.promptId, opts.eventName, JSON.stringify(opts.attrs ?? {}), JSON.stringify(opts.body ?? {})],
      );
      // HS-9278 — getPromptTimeline now reads the JSONL store, not otel_events.
      // Mirror ingest's dual-write into the ambient cluster dir (getDataDir()),
      // matching where the test's `getTelemetryDb()` inserts resolve.
      await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'events', opts.ts, {
        ts: opts.ts.toISOString(), project_secret: opts.projectSecret, session_id: 'session-1',
        prompt_id: opts.promptId, event_name: opts.eventName, attributes_json: opts.attrs ?? {}, body_json: opts.body ?? {},
      });
    }

    it('returns every event for the prompt id, ordered by ts ASC', async () => {
      const t1 = new Date('2026-05-20T10:00:00Z');
      const t2 = new Date('2026-05-20T10:00:05Z');
      const t3 = new Date('2026-05-20T10:00:10Z');
      await insertEvent({ ts: t2, projectSecret: SECRET_A, promptId: 'p1', eventName: 'claude_code.api_request' });
      await insertEvent({ ts: t1, projectSecret: SECRET_A, promptId: 'p1', eventName: 'claude_code.user_prompt', attrs: { model: 'sonnet-4' } });
      await insertEvent({ ts: t3, projectSecret: SECRET_A, promptId: 'p1', eventName: 'claude_code.tool_result' });
      // Different prompt — should NOT appear.
      await insertEvent({ ts: t2, projectSecret: SECRET_A, promptId: 'p2', eventName: 'claude_code.user_prompt' });

      const timeline = await getPromptTimeline('p1');
      expect(timeline.promptId).toBe('p1');
      expect(timeline.projectSecret).toBe(SECRET_A);
      expect(timeline.entries).toHaveLength(3);
      expect(timeline.entries[0].eventName).toBe('claude_code.user_prompt');
      expect(timeline.entries[1].eventName).toBe('claude_code.api_request');
      expect(timeline.entries[2].eventName).toBe('claude_code.tool_result');
      // Model pulled from the user_prompt event's attributes.
      expect(timeline.model).toBe('sonnet-4');
      expect(timeline.firstTs).toBe(t1.toISOString());
      expect(timeline.lastTs).toBe(t3.toISOString());
    });

    it('returns an empty-entries timeline for an unknown prompt id', async () => {
      const timeline = await getPromptTimeline('does-not-exist');
      expect(timeline.entries).toHaveLength(0);
      expect(timeline.projectSecret).toBeNull();
      expect(timeline.firstTs).toBeNull();
      expect(timeline.model).toBeNull();
      expect(timeline.spans).toEqual([]);
    });

    it('HS-8475 — also returns spans tagged with the prompt id, ordered by start_ts ASC', async () => {
      async function insertSpan(opts: {
        traceId: string;
        spanId: string;
        parentSpanId: string | null;
        promptId: string;
        startTs: Date;
        endTs: Date;
        spanName: string;
      }): Promise<void> {
        const db = await getTelemetryDb();
        await db.query(
          `INSERT INTO otel_spans (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [opts.traceId, opts.spanId, opts.parentSpanId, SECRET_A, 'session-1', opts.promptId, opts.spanName, opts.startTs, opts.endTs, JSON.stringify({}), 'OK'],
        );
        // HS-9278 — getPromptTimeline reads spans from the JSONL store now.
        await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'spans', opts.startTs, {
          trace_id: opts.traceId, span_id: opts.spanId, parent_span_id: opts.parentSpanId,
          project_secret: SECRET_A, session_id: 'session-1', prompt_id: opts.promptId,
          span_name: opts.spanName, start_ts: opts.startTs.toISOString(), end_ts: opts.endTs.toISOString(),
          attributes_json: {}, status_code: 'OK',
        });
      }

      // Seed an event so the timeline has at least one entry.
      const t1 = new Date('2026-05-21T10:00:00Z');
      await insertEvent({ ts: t1, projectSecret: SECRET_A, promptId: 'p-spans', eventName: 'claude_code.user_prompt', attrs: { model: 'sonnet' } });

      // Two spans for p-spans (out of order to verify sorting) + one for an
      // unrelated prompt that must NOT appear in the result.
      await insertSpan({
        traceId: 'trace-1', spanId: 's2', parentSpanId: 's1', promptId: 'p-spans',
        startTs: new Date('2026-05-21T10:00:00.200Z'),
        endTs: new Date('2026-05-21T10:00:00.400Z'),
        spanName: 'claude_code.llm_request',
      });
      await insertSpan({
        traceId: 'trace-1', spanId: 's1', parentSpanId: null, promptId: 'p-spans',
        startTs: new Date('2026-05-21T10:00:00.000Z'),
        endTs: new Date('2026-05-21T10:00:00.500Z'),
        spanName: 'claude_code.turn',
      });
      await insertSpan({
        traceId: 'trace-2', spanId: 'other', parentSpanId: null, promptId: 'p-other',
        startTs: new Date('2026-05-21T10:00:00.000Z'),
        endTs: new Date('2026-05-21T10:00:00.500Z'),
        spanName: 'claude_code.turn',
      });

      const timeline = await getPromptTimeline('p-spans');
      expect(timeline.spans).toHaveLength(2);
      expect(timeline.spans[0].spanId).toBe('s1');
      expect(timeline.spans[1].spanId).toBe('s2');
      expect(timeline.spans[0].parentSpanId).toBeNull();
      expect(timeline.spans[1].parentSpanId).toBe('s1');
      expect(timeline.spans[0].spanName).toBe('claude_code.turn');
      expect(timeline.spans[1].spanName).toBe('claude_code.llm_request');
    });
  });

  describe('getToolLatencyHistogram (HS-8150 / §67.10.5)', () => {
    // HS-9279 — getToolLatencyHistogram reads the otel_rollup_activity rollup now
    // (events-only; the beta spans-fidelity path was retired). Seed via ingest.
    async function insertToolDuration(opts: {
      ts: Date;
      projectSecret: string;
      toolName: string;
      durationMs: number;
    }): Promise<void> {
      await recordToolActivity(await getRollupDb(), opts.projectSecret, opts.ts, {
        tool_name: opts.toolName, duration_ms: opts.durationMs,
      });
    }

    it('returns empty when there are no tool_result events with duration_ms', async () => {
      const result = await getToolLatencyHistogram(SECRET_A, null);
      expect(result).toEqual([]);
    });

    it('computes p50 (bucket-approximated) + buckets across multiple invocations', async () => {
      const now = new Date();
      // Edit tool: 10 fast ones (5 ms) + 1 slow one (1500 ms).
      for (let i = 0; i < 10; i++) {
        await insertToolDuration({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 5 });
      }
      await insertToolDuration({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 1500 });

      const result = await getToolLatencyHistogram(SECRET_A, null);
      expect(result).toHaveLength(1);
      const editRow = result[0];
      expect(editRow.tool).toBe('Edit');
      expect(editRow.count).toBe(11);
      expect(editRow.totalMs).toBe(50 + 1500);
      // 11 rows: 10 in bucket 0 (<10ms), 1 in bucket 5 (1-5s).
      expect(editRow.buckets[0]).toBe(10);
      expect(editRow.buckets[5]).toBe(1);
      expect(editRow.buckets[1]).toBe(0);
      // HS-9279 — p50 is now interpolated within the crossing bucket: target =
      // 0.5*11 = 5.5 falls in bucket 0 ([0,10)) → 0 + (5.5/10)*10 = 5.5.
      expect(editRow.p50).toBeCloseTo(5.5, 5);
    });

    it('groups by tool_name + sorts by count DESC', async () => {
      const now = new Date();
      // Edit: 3 invocations. Read: 1 invocation.
      for (let i = 0; i < 3; i++) {
        await insertToolDuration({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 100 });
      }
      await insertToolDuration({ ts: now, projectSecret: SECRET_A, toolName: 'Read', durationMs: 50 });

      const result = await getToolLatencyHistogram(SECRET_A, null);
      expect(result).toHaveLength(2);
      expect(result[0].tool).toBe('Edit');
      expect(result[0].count).toBe(3);
      expect(result[1].tool).toBe('Read');
      expect(result[1].count).toBe(1);
    });

    it('isolates by project_secret', async () => {
      const now = new Date();
      await insertToolDuration({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 100 });
      await insertToolDuration({ ts: now, projectSecret: SECRET_B, toolName: 'Edit', durationMs: 999 });

      const a = await getToolLatencyHistogram(SECRET_A, null);
      expect(a[0].count).toBe(1);
      expect(a[0].totalMs).toBe(100);
    });
  });

  describe('getPerTicketRollup (HS-8152 / §67.10.7)', () => {
    async function insertEventWithBody(opts: {
      ts: Date;
      projectSecret: string;
      promptId: string;
      eventName: string;
      attrs?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }): Promise<void> {
      const db = await getTelemetryDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', opts.promptId, opts.eventName, JSON.stringify(opts.attrs ?? {}), JSON.stringify(opts.body ?? {})],
      );
    }

    // HS-9257 — getPerTicketRollup now reads otel_rollup_ticket + the duration
    // spans (main db), not raw. These tests seed raw events + intervals directly,
    // so recompute the per-ticket rollup + spans from raw (the same path the
    // production backfill uses) before the read. `secret` = the project the ticket
    // was worked under (production always passes the request's projectSecret).
    async function backfillTicketRollup(secret: string): Promise<void> {
      const clusterDb = await getTelemetryDb();
      const mainDb = await getRollupDb();
      await backfillTicketsForDir('', clusterDb, mainDb, secret);
      await backfillTicketPromptSpansForDir(clusterDb, mainDb, secret);
    }

    it('returns zero rollup for an unattributed ticket', async () => {
      const result = await getPerTicketRollup('HS-9999');
      expect(result.ticketNumber).toBe('HS-9999');
      expect(result.promptCount).toBe(0);
      expect(result.totalCost).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    it('attributes cost + tokens to a ticket via the marker in user_prompt body', async () => {
      const t = new Date('2026-05-20T10:00:00Z');
      // Two prompts tagged for HS-1234, plus their api_request events.
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p1',
        eventName: 'claude_code.user_prompt',
        body: { body: '<!-- hotsheet:ticket=HS-1234 -->\n\nDo the thing' },
      });
      await insertEventWithBody({
        ts: new Date(t.getTime() + 100),
        projectSecret: SECRET_A,
        promptId: 'p1',
        eventName: 'claude_code.api_request',
        attrs: { cost: 0.5, tokens: 1000 },
      });
      await insertEventWithBody({
        ts: new Date(t.getTime() + 5000),
        projectSecret: SECRET_A,
        promptId: 'p1',
        eventName: 'claude_code.api_request',
        attrs: { cost: 0.25, tokens: 500 },
      });
      // Second prompt also tagged HS-1234.
      await insertEventWithBody({
        ts: new Date(t.getTime() + 10000),
        projectSecret: SECRET_A,
        promptId: 'p2',
        eventName: 'claude_code.user_prompt',
        body: { body: '<!-- hotsheet:ticket=HS-1234 -->\n\nFollow-up' },
      });
      await insertEventWithBody({
        ts: new Date(t.getTime() + 10100),
        projectSecret: SECRET_A,
        promptId: 'p2',
        eventName: 'claude_code.api_request',
        attrs: { cost: 0.1, tokens: 200 },
      });

      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-1234', SECRET_A);
      expect(result.promptCount).toBe(2);
      expect(result.totalCost).toBeCloseTo(0.85, 6);
      expect(result.totalTokens).toBe(1700);
      expect(result.totalDurationSeconds).toBeGreaterThan(0);
    });

    it('excludes prompts tagged for a different ticket', async () => {
      const t = new Date('2026-05-20T10:00:00Z');
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p1',
        eventName: 'claude_code.user_prompt',
        body: { body: '<!-- hotsheet:ticket=HS-1234 -->\n\nMine' },
      });
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p2',
        eventName: 'claude_code.user_prompt',
        body: { body: '<!-- hotsheet:ticket=HS-9999 -->\n\nNot mine' },
      });
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p1',
        eventName: 'claude_code.api_request',
        attrs: { cost: 1.0, tokens: 1000 },
      });
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p2',
        eventName: 'claude_code.api_request',
        attrs: { cost: 99.0, tokens: 99999 },
      });

      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-1234', SECRET_A);
      expect(result.promptCount).toBe(1);
      expect(result.totalCost).toBe(1.0);
      expect(result.totalTokens).toBe(1000);
    });

    it('handles untagged prompts (no marker = no attribution)', async () => {
      const t = new Date('2026-05-20T10:00:00Z');
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p-untagged',
        eventName: 'claude_code.user_prompt',
        body: { body: 'No marker here' },
      });
      await insertEventWithBody({
        ts: t,
        projectSecret: SECRET_A,
        promptId: 'p-untagged',
        eventName: 'claude_code.api_request',
        attrs: { cost: 5.0, tokens: 5000 },
      });

      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-1234', SECRET_A);
      expect(result.promptCount).toBe(0);
      expect(result.totalCost).toBe(0);
    });

    // --- HS-8730: time-window (started→completed interval) attribution ---

    async function insertInterval(secret: string, ticketNumber: string, startedAt: Date, endedAt: Date | null): Promise<void> {
      const db = await getTelemetryDb();
      await db.query(
        `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at) VALUES ($1, $2, $3, $4)`,
        [secret, ticketNumber, startedAt, endedAt],
      );
    }

    it('attributes cost by time window — api_request events inside a started→ended interval, no marker needed', async () => {
      const start = new Date('2026-05-21T10:00:00Z');
      const end = new Date('2026-05-21T10:30:00Z');
      await insertInterval(SECRET_A, 'HS-5000', start, end);
      // Two api_request events INSIDE the window (bare + dotted name), no marker.
      await insertEventWithBody({ ts: new Date(start.getTime() + 60_000), projectSecret: SECRET_A, promptId: 'pw1', eventName: 'claude_code.api_request', attrs: { cost: 0.4, tokens: 800 } });
      await insertEventWithBody({ ts: new Date(start.getTime() + 120_000), projectSecret: SECRET_A, promptId: 'pw1', eventName: 'api_request', attrs: { cost: 0.1, tokens: 200 } });
      // One OUTSIDE the window — must be excluded.
      await insertEventWithBody({ ts: new Date(end.getTime() + 60_000), projectSecret: SECRET_A, promptId: 'pw2', eventName: 'claude_code.api_request', attrs: { cost: 9.0, tokens: 9000 } });

      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-5000', SECRET_A);
      expect(result.totalCost).toBeCloseTo(0.5, 6);
      expect(result.totalTokens).toBe(1000);
      expect(result.promptCount).toBe(1);
    });

    it('an open interval (ended_at NULL) counts events up to now', async () => {
      const start = new Date(Date.now() - 60_000);
      await insertInterval(SECRET_A, 'HS-5001', start, null);
      await insertEventWithBody({ ts: new Date(Date.now() - 30_000), projectSecret: SECRET_A, promptId: 'po1', eventName: 'claude_code.api_request', attrs: { cost: 0.2, tokens: 300 } });
      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-5001', SECRET_A);
      expect(result.totalCost).toBeCloseTo(0.2, 6);
    });

    it('a no-secret read finds nothing — the rollup is keyed by project_secret (HS-9257)', async () => {
      // The time-window cost IS attributed to SECRET_A's rollup by the backfill,
      // but reading with no secret looks under project_secret='' (central), which
      // has nothing. Production always passes the request's projectSecret, so this
      // is the rollup-model successor to the old marker-only back-compat path.
      const start = new Date('2026-05-21T10:00:00Z');
      await insertInterval(SECRET_A, 'HS-5002', start, new Date(start.getTime() + 1_800_000));
      await insertEventWithBody({ ts: new Date(start.getTime() + 60_000), projectSecret: SECRET_A, promptId: 'pn1', eventName: 'claude_code.api_request', attrs: { cost: 0.4, tokens: 800 } });
      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-5002'); // no secret → reads project_secret=''
      expect(result.totalCost).toBe(0);
      expect(result.promptCount).toBe(0);
      // Sanity: it IS attributed under SECRET_A.
      expect((await getPerTicketRollup('HS-5002', SECRET_A)).totalCost).toBeCloseTo(0.4, 6);
    });

    it('time-window attribution is scoped by project_secret', async () => {
      const start = new Date('2026-05-21T10:00:00Z');
      await insertInterval(SECRET_A, 'HS-5003', start, new Date(start.getTime() + 1_800_000));
      // Event belongs to a DIFFERENT project — must not be attributed to SECRET_A's ticket.
      await insertEventWithBody({ ts: new Date(start.getTime() + 60_000), projectSecret: SECRET_B, promptId: 'px1', eventName: 'claude_code.api_request', attrs: { cost: 7.0, tokens: 7000 } });
      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-5003', SECRET_A);
      expect(result.totalCost).toBe(0);
    });

    it('an event matching BOTH the marker and an interval is counted once (dedup)', async () => {
      const t = new Date('2026-05-21T11:00:00Z');
      await insertInterval(SECRET_A, 'HS-5004', new Date(t.getTime() - 1_000), new Date(t.getTime() + 60_000));
      await insertEventWithBody({ ts: t, projectSecret: SECRET_A, promptId: 'pb1', eventName: 'claude_code.user_prompt', body: { body: '<!-- hotsheet:ticket=HS-5004 -->\n\nx' } });
      await insertEventWithBody({ ts: new Date(t.getTime() + 1_000), projectSecret: SECRET_A, promptId: 'pb1', eventName: 'claude_code.api_request', attrs: { cost: 0.3, tokens: 300 } });
      await backfillTicketRollup(SECRET_A);
      const result = await getPerTicketRollup('HS-5004', SECRET_A);
      expect(result.totalCost).toBeCloseTo(0.3, 6); // counted once, not 0.6
      expect(result.promptCount).toBe(1);
    });
  });

  describe('getCostByProject (HS-8480 / §69.3.2)', () => {
    it('returns one row per project that has any cost in the window, sorted by cost DESC', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.25 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 1.5 });
      // HS-9235 — typed tokens (rollup buckets real-work tokens by type).
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 1000 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_B, type: 'input', tokens: 3000 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1' });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p2' });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_B, promptId: 'p3' });

      const rows = await getCostByProject(null);
      expect(rows).toHaveLength(2);
      // Sorted by cost DESC — SECRET_B's $1.50 comes first.
      expect(rows[0].projectSecret).toBe(SECRET_B);
      expect(rows[0].cost).toBe(1.5);
      expect(rows[0].tokens).toBe(3000);
      expect(rows[0].promptCount).toBe(1);
      expect(rows[1].projectSecret).toBe(SECRET_A);
      expect(rows[1].cost).toBe(0.75);
      expect(rows[1].tokens).toBe(1000);
      expect(rows[1].promptCount).toBe(2);
    });

    it('filters by window — pre-window rows excluded', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const now = new Date();
      await insertCostMetric({ ts: fiveDaysAgo, projectSecret: SECRET_A, cost: 1.0 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const rows = await getCostByProject(oneDayAgo);
      expect(rows).toHaveLength(1);
      expect(rows[0].cost).toBe(0.5);
    });

    it('returns empty array when no project has cost', async () => {
      const rows = await getCostByProject(null);
      expect(rows).toEqual([]);
    });
  });

  describe('getHourlyActivityHeatmap (HS-8480 / §69.3.4)', () => {
    it('densifies to 168 cells with zero defaults', async () => {
      const cells = await getHourlyActivityHeatmap(null);
      expect(cells).toHaveLength(168);
      for (const cell of cells) {
        expect(cell.cost).toBe(0);
        expect(cell.promptCount).toBe(0);
      }
    });

    it('aggregates cost + distinct prompts by (dow, hour)', async () => {
      // HS-9279 — the rollup buckets SERVER-LOCAL now (was a read-time UTC param),
      // so compute the expected cell index from each ts in the server's local zone
      // rather than hard-coding a UTC (dow, hour). t1/t2 share an hour; t3 differs.
      const t1 = new Date('2026-05-18T10:30:00Z');
      const t2 = new Date('2026-05-18T10:45:00Z'); // same clock-hour as t1
      const t3 = new Date('2026-05-18T14:00:00Z'); // a different hour
      await insertCostMetric({ ts: t1, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: t2, projectSecret: SECRET_A, cost: 0.25 });
      await insertCostMetric({ ts: t3, projectSecret: SECRET_A, cost: 1.0 });
      await insertPromptEvent({ ts: t1, projectSecret: SECRET_A, promptId: 'p1' });
      await insertPromptEvent({ ts: t2, projectSecret: SECRET_A, promptId: 'p2' });

      const cells = await getHourlyActivityHeatmap(null, 'UTC');
      const idx = (d: Date): number => d.getDay() * 24 + d.getHours();
      expect(idx(t1)).toBe(idx(t2)); // same server-local (dow, hour) bucket
      expect(cells[idx(t1)].cost).toBeCloseTo(0.75);
      expect(cells[idx(t1)].promptCount).toBe(2);
      expect(cells[idx(t3)].cost).toBeCloseTo(1.0);
      expect(cells[idx(t3)].promptCount).toBe(0);
    });
  });

  describe('resolveDashboardWindowSinceTs (HS-8480 / §69.4)', () => {
    it('returns null for the all window', () => {
      expect(resolveDashboardWindowSinceTs('all')).toBeNull();
    });

    it('returns midnight-local for today', () => {
      const now = new Date('2026-05-21T14:30:00');
      const since = resolveDashboardWindowSinceTs('today', now);
      expect(since).not.toBeNull();
      if (since !== null) {
        expect(since.getHours()).toBe(0);
        expect(since.getMinutes()).toBe(0);
        expect(since.getDate()).toBe(21);
      }
    });

    it('returns midnight 6 days ago for week', () => {
      const now = new Date('2026-05-21T14:30:00');
      const since = resolveDashboardWindowSinceTs('week', now);
      expect(since).not.toBeNull();
      if (since !== null) expect(since.getDate()).toBe(15);
    });
  });

  describe('getDashboardPayload (HS-8480 / §69.4)', () => {
    it('returns every section bundled in one call (ambient, null projects)', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet' });

      // HS-8874 — null `projects` keeps the ambient-context back-compat path.
      const payload = await getDashboardPayload('all', 'UTC', null);
      expect(payload.window).toBe('all');
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(1.5);
      expect(payload.costByProject).toHaveLength(2);
      expect(payload.costByProject[0].projectSecret).toBe(SECRET_B); // higher cost first
      expect(payload.costByModel.length).toBeGreaterThan(0);
      expect(payload.hourlyActivity).toHaveLength(168);
      expect(payload.costOverTime.length).toBeGreaterThan(0); // HS-8503 — densified series
    });
  });

  // HS-8874 — telemetry is per-project: the dashboard fans out across each
  // project's OWN DB + the central store and merges in JS. Reading each project
  // DB filtered by its own secret is what prevents the non-destructive migration
  // from double-counting when a source DB still holds another project's rows.
  describe('cross-project fan-out (HS-8874)', () => {
    // Per-test UNIQUE secrets so no row from a parallel test file (which may
    // touch the shared real central store) can collide on `SECRET_A`/`SECRET_B`.
    it('sums totals / merges costByModel / concats costByProject across project DBs', async () => {
      const now = new Date();
      const A = `fanout-A-${Math.random().toString(36).slice(2)}`;
      const B = `fanout-B-${Math.random().toString(36).slice(2)}`;
      const dirA = createTempDir();
      const dirB = createTempDir();
      try {
        // Seed each project's OWN DB.
        await runWithDataDir(dirA, async () => {
          await insertCostMetric({ ts: now, projectSecret: A, model: 'sonnet', cost: 0.5 });
          await insertTokenMetric({ ts: now, projectSecret: A, type: 'input', tokens: 1000 });
          await insertPromptEvent({ ts: now, projectSecret: A, promptId: 'pa', model: 'sonnet' });
        });
        await runWithDataDir(dirB, async () => {
          await insertCostMetric({ ts: now, projectSecret: B, model: 'opus', cost: 1.0 });
          await insertCostMetric({ ts: now, projectSecret: B, model: 'sonnet', cost: 0.25 });
        });

        const payload = await getDashboardPayload('all', 'UTC', [
          { secret: A, dataDir: dirA },
          { secret: B, dataDir: dirB },
        ]);
        // One row per loaded project (concat across the two DBs).
        const byProject = new Map(payload.costByProject.map(r => [r.projectSecret, r.cost]));
        expect(byProject.get(A)).toBeCloseTo(0.5);   // dirA only
        expect(byProject.get(B)).toBeCloseTo(1.25);  // dirB: opus 1.0 + sonnet 0.25
        // Cross-DB merge: this run's two projects contribute exactly $1.75
        // summed (central may add unrelated rows, never less).
        expect((byProject.get(A) ?? 0) + (byProject.get(B) ?? 0)).toBeCloseTo(1.75);
        // 168-cell heatmap merged.
        expect(payload.hourlyActivity).toHaveLength(168);
      } finally {
        await closeDbForDir(dirA);
        await closeDbForDir(dirB);
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    });

    it('does NOT double-count when a source DB still contains another project\'s rows', async () => {
      // Simulates the post-migration state: project A's DB still holds an
      // un-deleted copy of project B's row (non-destructive migration). Reading
      // A's DB filtered by A's secret must exclude B's stray row.
      const now = new Date();
      const A = `dc-A-${Math.random().toString(36).slice(2)}`;
      const B = `dc-B-${Math.random().toString(36).slice(2)}`;
      const dirA = createTempDir();
      const dirB = createTempDir();
      try {
        await runWithDataDir(dirA, async () => {
          await insertCostMetric({ ts: now, projectSecret: A, model: 'sonnet', cost: 0.5 });
          // Stray foreign row left behind in A's DB by the non-destructive copy.
          await insertCostMetric({ ts: now, projectSecret: B, model: 'opus', cost: 1.0 });
        });
        await runWithDataDir(dirB, async () => {
          await insertCostMetric({ ts: now, projectSecret: B, model: 'opus', cost: 1.0 });
        });

        const payload = await getDashboardPayload('all', 'UTC', [
          { secret: A, dataDir: dirA },
          { secret: B, dataDir: dirB },
        ]);
        // The key assertion: A's per-project row is its own $0.50 only (the stray
        // foreign B-row in A's DB is excluded by the per-secret filter), and B's
        // is its own $1.00 counted ONCE — NOT $1.00 + the stray.
        const byProject = new Map(payload.costByProject.map(r => [r.projectSecret, r.cost]));
        expect(byProject.get(A)).toBeCloseTo(0.5);
        expect(byProject.get(B)).toBeCloseTo(1.0);
      } finally {
        await closeDbForDir(dirA);
        await closeDbForDir(dirB);
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    });

    it('with null projects keeps the ambient every-project behavior (back-compat)', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 1.0 });
      const payload = await getDashboardPayload('all', 'UTC', null);
      expect(payload.costByProject).toHaveLength(2);
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(1.5);
    });
  });

  describe('cross-project loaded-projects filter (HS-8625, rollup-level)', () => {
    it('getCostByProject + getHourlyActivityHeatmap honor allowedSecrets directly', async () => {
      const t = new Date('2026-05-18T10:30:00Z');
      await insertCostMetric({ ts: t, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: t, projectSecret: SECRET_B, cost: 2.0 });

      const rows = await getCostByProject(null, [SECRET_A]);
      expect(rows).toHaveLength(1);
      expect(rows[0].projectSecret).toBe(SECRET_A);

      const cells = await getHourlyActivityHeatmap(null, 'UTC', [SECRET_A]);
      // HS-9279 — server-local (dow, hour) bucket; only SECRET_A's $0.50 counted
      // (SECRET_B is filtered out by allowedSecrets).
      const idx = t.getDay() * 24 + t.getHours();
      expect(cells[idx].cost).toBeCloseTo(0.5);
    });
  });

  // HS-8627 — headline token totals count only input + output, excluding the
  // cache types. `claude_code.token.usage` is tagged with a `type` dimension;
  // `cacheRead` re-counts the whole cached prompt every turn, dwarfing the real
  // work and inflating the count. Cost is unaffected (already-priced USD).
  describe('token totals exclude cache types (HS-8627)', () => {
    it('getWindowTotals counts input + output only, not cacheRead / cacheCreation', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 100 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'output', tokens: 50 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cacheRead', tokens: 999_999 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cacheCreation', tokens: 8_000 });

      const totals = await getWindowTotals(SECRET_A, null);
      expect(totals.tokens).toBe(150); // 100 + 50 — cache excluded
    });

    it('excludes the snake_case cache spelling too (cache_read / cache_creation)', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 10 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cache_read', tokens: 500_000 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cache_creation', tokens: 2_000 });

      const totals = await getWindowTotals(SECRET_A, null);
      expect(totals.tokens).toBe(10);
    });

    it('an UNTYPED token row does NOT count toward the real-work total (HS-9235 rollup)', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, tokens: 77 }); // no `type` attr
      // HS-9235 — the daily rollup buckets tokens into input/output/cache columns
      // BY `type`; an untyped token contributes to `datapoint_count` only, so the
      // real-work total (SUM(input_tokens + output_tokens)) excludes it. This is a
      // deliberate consequence of the rollup shape — real Claude Code token.usage
      // always carries a type, so only unknown/legacy types are affected. (The raw
      // read previously counted untyped tokens fail-open; the rollup does not.)
      const totals = await getWindowTotals(SECRET_A, null);
      expect(totals.tokens).toBe(0);
    });

    it('getCostByProject token total excludes cache; cost is NOT filtered', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 1.25 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 200 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'output', tokens: 100 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'cacheRead', tokens: 1_000_000 });

      const rows = await getCostByProject(null);
      expect(rows).toHaveLength(1);
      expect(rows[0].tokens).toBe(300); // input + output only
      expect(rows[0].cost).toBeCloseTo(1.25); // cost unaffected by the token-type filter
    });

    it('getCostByModel token total per model excludes cache', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', type: 'input', tokens: 40 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', type: 'output', tokens: 20 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', type: 'cacheRead', tokens: 700_000 });

      const rows = await getCostByModel(SECRET_A, null);
      const sonnet = rows.find(r => r.model === 'sonnet');
      expect(sonnet?.tokens).toBe(60); // 40 + 20
      expect(sonnet?.cost).toBeCloseTo(0.5);
    });
  });

  describe('getIngestedDates (HS-8810)', () => {
    it('returns the distinct local days with ANY ingested metric point (token-only / $0 included)', async () => {
      // A token-only day, a $0-cost day, and a real-cost day — all "had telemetry".
      await insertTokenMetric({ ts: new Date('2026-05-19T12:00:00Z'), projectSecret: SECRET_A, tokens: 100 });
      await insertCostMetric({ ts: new Date('2026-05-20T12:00:00Z'), projectSecret: SECRET_A, model: 'sonnet', cost: 0 });
      await insertCostMetric({ ts: new Date('2026-05-21T12:00:00Z'), projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });

      const dates = await getIngestedDates(new Date('2026-05-19T00:00:00Z'), null, 'UTC');
      expect(dates).toEqual(['2026-05-19', '2026-05-20', '2026-05-21']);
    });

    it('excludes rows before the window start', async () => {
      await insertCostMetric({ ts: new Date('2026-05-10T12:00:00Z'), projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: new Date('2026-05-21T12:00:00Z'), projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      expect(await getIngestedDates(new Date('2026-05-20T00:00:00Z'), null, 'UTC')).toEqual(['2026-05-21']);
    });

    it('scopes to a single project when a secret is given', async () => {
      const day = new Date('2026-05-21T12:00:00Z');
      await insertCostMetric({ ts: day, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: day, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });
      expect(await getIngestedDates(null, SECRET_A, 'UTC')).toEqual(['2026-05-21']);
    });

    it('returns [] when there are no metric points', async () => {
      expect(await getIngestedDates(null, null, 'UTC')).toEqual([]);
    });
  });

  describe('getCostOverTime (HS-8503 Phase 1 / §69.10.4)', () => {
    it('returns empty when no cost rows exist', async () => {
      const points = await getCostOverTime(null, null, 'UTC');
      expect(points).toEqual([]);
    });

    it('densifies missing dates to zero across the (project, model) tuples that DO have data', async () => {
      // Three days, two projects, one model each.
      const day0 = new Date('2026-05-19T12:00:00Z');
      const day2 = new Date('2026-05-21T12:00:00Z');
      await insertCostMetric({ ts: day0, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: day2, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });

      // sinceTs covers day0 → day2 (3 days).
      const since = new Date('2026-05-19T00:00:00Z');
      const now = new Date('2026-05-21T12:00:00Z');
      const points = await getCostOverTime(since, null, 'UTC', now);

      // 3 days × 2 (project, model) tuples = 6 densified points.
      expect(points).toHaveLength(6);
      // Each date appears twice (once per tuple).
      const dates = new Set(points.map(p => p.date));
      expect(dates.size).toBe(3);
      expect(dates.has('2026-05-19')).toBe(true);
      expect(dates.has('2026-05-20')).toBe(true);
      expect(dates.has('2026-05-21')).toBe(true);

      // SECRET_A / sonnet — $0.50 on day0, $0 on day1 + day2.
      const aSonnet = points.filter(p => p.projectSecret === SECRET_A && p.model === 'sonnet');
      expect(aSonnet).toHaveLength(3);
      expect(aSonnet.find(p => p.date === '2026-05-19')?.cost).toBeCloseTo(0.5);
      expect(aSonnet.find(p => p.date === '2026-05-20')?.cost).toBe(0);
      expect(aSonnet.find(p => p.date === '2026-05-21')?.cost).toBe(0);

      // SECRET_B / opus — $1.00 on day2, $0 on day0 + day1.
      const bOpus = points.filter(p => p.projectSecret === SECRET_B && p.model === 'opus');
      expect(bOpus).toHaveLength(3);
      expect(bOpus.find(p => p.date === '2026-05-21')?.cost).toBeCloseTo(1.0);
      expect(bOpus.find(p => p.date === '2026-05-19')?.cost).toBe(0);
    });

    it('per-project scope filters to one project only', async () => {
      const day = new Date('2026-05-21T12:00:00Z');
      await insertCostMetric({ ts: day, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: day, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });

      const since = new Date('2026-05-21T00:00:00Z');
      const now = new Date('2026-05-21T12:00:00Z');
      const points = await getCostOverTime(since, SECRET_A, 'UTC', now);

      // 1 day × 1 tuple = 1 point.
      expect(points).toHaveLength(1);
      expect(points[0].projectSecret).toBe(SECRET_A);
      expect(points[0].model).toBe('sonnet');
      expect(points[0].cost).toBeCloseTo(0.5);
    });

    it('sums multiple rows in the same (date, project, model) bucket', async () => {
      // HS-9235 — the rollup buckets by SERVER-LOCAL day. Seed two points on the
      // same local day (local 10:00 + 14:00) and read in the server tz so the
      // read's day grain + densify range line up regardless of the machine's tz
      // (edge-of-day UTC times would split across local days on a non-UTC host).
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const b = new Date();
      const t1 = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 10, 0, 0);
      const t2 = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 14, 0, 0);
      await insertCostMetric({ ts: t1, projectSecret: SECRET_A, model: 'sonnet', cost: 0.3 });
      await insertCostMetric({ ts: t2, projectSecret: SECRET_A, model: 'sonnet', cost: 0.4 });

      const since = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 0, 0, 0);
      const now = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 20, 0, 0);
      const points = await getCostOverTime(since, null, tz, now);

      const total = points.reduce((sum, p) => sum + p.cost, 0);
      expect(total).toBeCloseTo(0.7);
    });

    it('with sinceTs=null uses the earliest data row as the range start', async () => {
      const day0 = new Date('2026-05-20T12:00:00Z');
      const day1 = new Date('2026-05-21T12:00:00Z');
      await insertCostMetric({ ts: day0, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: day1, projectSecret: SECRET_A, model: 'sonnet', cost: 0.25 });

      const now = new Date('2026-05-21T12:00:00Z');
      const points = await getCostOverTime(null, null, 'UTC', now);

      // 2 days × 1 tuple = 2 points (range starts at earliest data day).
      expect(points).toHaveLength(2);
      expect(points[0].date).toBe('2026-05-20');
      expect(points[1].date).toBe('2026-05-21');
    });

    it('excludes (project, model) tuples that have NO data in the window', async () => {
      // SECRET_A / sonnet has data before the window; should not appear in the result.
      const beforeWindow = new Date('2026-05-15T12:00:00Z');
      const inWindow = new Date('2026-05-21T12:00:00Z');
      await insertCostMetric({ ts: beforeWindow, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: inWindow, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });

      const since = new Date('2026-05-20T00:00:00Z');
      const now = new Date('2026-05-21T20:00:00Z');
      const points = await getCostOverTime(since, null, 'UTC', now);

      // Only the SECRET_B / opus tuple shows up — 2 days × 1 tuple = 2 points.
      expect(points).toHaveLength(2);
      expect(points.every(p => p.projectSecret === SECRET_B && p.model === 'opus')).toBe(true);
    });
  });

  describe('getProjectRollupPayload (HS-8503 Phase 1 / §69.10.5)', () => {
    it('returns every section bundled, scoped to one project', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet' });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_B, promptId: 'p2', model: 'opus' });

      const payload = await getProjectRollupPayload(SECRET_A, 'all', 'UTC');
      expect(payload.window).toBe('all');
      // Window-totals are project-scoped — SECRET_B's $1.00 isn't in here.
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(0.5);
      expect(payload.windowTotals.allTime.promptCount).toBe(1);
      // Cost by model is project-scoped — only SECRET_A's sonnet.
      expect(payload.costByModel).toHaveLength(1);
      expect(payload.costByModel[0].model).toBe('sonnet');
      expect(payload.costByModel[0].cost).toBeCloseTo(0.5);
      // Recent prompts — only SECRET_A's p1.
      expect(payload.recentPrompts).toHaveLength(1);
      expect(payload.recentPrompts[0].promptId).toBe('p1');
      // Cost over time — only SECRET_A's data.
      expect(payload.costOverTime.length).toBeGreaterThan(0);
      expect(payload.costOverTime.every(p => p.projectSecret === SECRET_A)).toBe(true);
    });

    it('caps recent prompts at 10 (analytics-dashboard variant — not the drawer\'s 50)', async () => {
      const now = new Date();
      // Insert 15 prompts.
      for (let i = 0; i < 15; i++) {
        await insertPromptEvent({
          ts: new Date(now.getTime() - i * 1000),
          projectSecret: SECRET_A,
          promptId: `p${i}`,
          model: 'sonnet',
        });
      }
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });

      const payload = await getProjectRollupPayload(SECRET_A, 'all', 'UTC');
      expect(payload.recentPrompts).toHaveLength(10);
      // Newest first — p0 is the newest seed.
      expect(payload.recentPrompts[0].promptId).toBe('p0');
    });
  });

  // HS-8874 — telemetry is now stored PER-PROJECT (each project's own DB),
  // superseding the HS-8581 single-shared-store model. The per-project rollup
  // reads the project's OWN telemetry DB, resolved from the active
  // `runWithTelemetryDb` context (the route binds the active project's dataDir).
  // These tests pin that contract: data seeded in project A's own DB is read
  // when A's telemetry context is active, and is NOT visible from a different
  // project's (empty) DB context.
  describe('HS-8874 — per-project rollups read the project\'s own telemetry DB', () => {
    let dirA: string;
    let dirOther: string;

    beforeEach(async () => {
      dirA = createTempDir();
      dirOther = createTempDir();
      await getDbForDir(dirA);
      await getDbForDir(dirOther);
    });

    afterEach(async () => {
      await closeDbForDir(dirA);
      await closeDbForDir(dirOther);
      try { rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(dirOther, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('getProjectRollupPayload reads project A\'s OWN DB when bound to A\'s telemetry context', async () => {
      const now = new Date();
      // Seed telemetry in A's OWN DB (where the per-resource writer routes it).
      await runWithDataDir(dirA, async () => {
        await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
        await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet' });
      });

      const payload = await runWithDataDir(dirA, () =>
        getProjectRollupPayload(SECRET_A, 'all', 'UTC'),
      );
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(0.5);
      expect(payload.windowTotals.allTime.promptCount).toBe(1);
      expect(payload.recentPrompts).toHaveLength(1);
      expect(payload.recentPrompts[0].promptId).toBe('p1');
    });

    it('a different project\'s (empty) DB context sees none of A\'s telemetry', async () => {
      const now = new Date();
      await runWithDataDir(dirA, () =>
        insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 1.25 }),
      );
      // Reading under the OTHER project's empty DB context returns zero — each
      // project owns its own telemetry now.
      const totals = await runWithDataDir(dirOther, () =>
        getWindowTotals(SECRET_A, null),
      );
      expect(totals.cost).toBe(0);
    });
  });

  // HS-8606 / §74 — "Clear telemetry data" deletes every row for ONE
  // project's secret across all three otel tables, leaving other projects'
  // rows intact. Scoped delete on the single shared store.
  describe('clearProjectTelemetry (HS-8606)', () => {
    it('deletes only the given project\'s rows across metrics + events + spans', async () => {
      const now = new Date();
      // SECRET_A: one of each row type.
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'pA' });
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 10 });
      // SECRET_B: a metric + a prompt that must survive.
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_B, promptId: 'pB' });

      const result = await clearProjectTelemetry(SECRET_A);
      // 1 metric + 2 events (prompt + tool_result) for A.
      expect(result.deleted).toBe(3);

      // A is gone; B is untouched.
      const aTotals = await getWindowTotals(SECRET_A, null);
      expect(aTotals.cost).toBe(0);
      expect(aTotals.promptCount).toBe(0);
      const bTotals = await getWindowTotals(SECRET_B, null);
      expect(bTotals.cost).toBeCloseTo(1.0);
      expect(bTotals.promptCount).toBe(1);
    });

    it('returns deleted=0 when the project has no telemetry (valid no-op)', async () => {
      await insertCostMetric({ ts: new Date(), projectSecret: SECRET_B, cost: 1.0 });
      const result = await clearProjectTelemetry('secret-with-no-rows');
      expect(result.deleted).toBe(0);
      // SECRET_B's row is untouched.
      expect((await getWindowTotals(SECRET_B, null)).cost).toBeCloseTo(1.0);
    });
  });

  // HS-8639 — bare (un-prefixed) Claude Code event names.
  //
  // Current Claude Code versions stamp log records with bare event names
  // (`user_prompt` / `tool_result` / `api_request`) via the native OTLP
  // `eventName` field, NOT the dotted `claude_code.user_prompt` form older
  // builds used in the `event.name` attribute. The live `/api/telemetry/_debug`
  // paste on this ticket proved the bare form is what actually lands. Every
  // event-name filter must match BOTH spellings or it silently returns zero
  // rows — the regression that left the recent-prompts list + tool histogram
  // empty. These cases seed events with the BARE name on purpose: the prior
  // tests only ever exercised the dotted form, so they passed while the real
  // app was broken. If a future change reverts to a single-spelling filter,
  // these fail.
  describe('bare (un-prefixed) event names (HS-8639)', () => {
    // Insert a log event with an arbitrary event_name verbatim — no helper
    // default papers over the spelling.
    async function insertRawEvent(opts: {
      ts: Date;
      projectSecret: string;
      promptId: string | null;
      eventName: string;
      attrs?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }): Promise<void> {
      const db = await getTelemetryDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', opts.promptId, opts.eventName,
          JSON.stringify(opts.attrs ?? {}), JSON.stringify(opts.body ?? {})],
      );
      // HS-9235 — mirror ingest: any event with a prompt_id marks the daily
      // dedup set, so the seen-based promptCount reads (getWindowTotals /
      // getCostByProject) see bare-named events too.
      await markDailySeen(await getRollupDb(), opts.projectSecret, opts.ts, 'prompt', opts.promptId);
      // HS-9278 — getPromptTimeline / getRecentPrompts / getTelemetryDebugInfo read
      // the JSONL store now (the raw insert above still feeds getToolLatencyHistogram).
      await appendOtelJsonl(telemetryClusterDataDir(getDataDir()), 'events', opts.ts, {
        ts: opts.ts.toISOString(), project_secret: opts.projectSecret, session_id: 'session-1',
        prompt_id: opts.promptId, event_name: opts.eventName, attributes_json: opts.attrs ?? {}, body_json: opts.body ?? {},
      });
      // HS-9279 — getToolRollup reads the otel_rollup_activity rollup; roll bare/dotted
      // tool_result events into it (mirrors ingest).
      if (opts.eventName === 'tool_result' || opts.eventName === 'claude_code.tool_result') {
        await recordToolActivity(await getRollupDb(), opts.projectSecret, opts.ts, opts.attrs ?? {});
      }
      // HS-9279 — getHourlyActivityHeatmap's distinct-prompt count reads otel_hourly_seen.
      if (opts.eventName === 'user_prompt' || opts.eventName === 'claude_code.user_prompt') {
        await markHourlySeenPrompt(await getRollupDb(), opts.projectSecret, opts.ts, opts.promptId);
      }
    }

    it('getRecentPrompts returns bare-named user_prompt events', async () => {
      const now = new Date();
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p-bare', eventName: 'user_prompt', attrs: { model: 'opus-4-7' } });
      const recent = await getRecentPrompts(SECRET_A, 10);
      expect(recent).toHaveLength(1);
      expect(recent[0].promptId).toBe('p-bare');
      expect(recent[0].model).toBe('opus-4-7');
    });

    it('getToolRollup + getToolLatencyHistogram count bare-named tool_result events', async () => {
      const now = new Date();
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', eventName: 'tool_result', attrs: { tool_name: 'Edit', duration_ms: 42 } });
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', eventName: 'tool_result', attrs: { tool_name: 'Edit', duration_ms: 58 } });

      const rollup = await getToolRollup(SECRET_A, null);
      expect(rollup).toHaveLength(1);
      expect(rollup[0].tool).toBe('Edit');
      expect(rollup[0].count).toBe(2);

      const hist = await getToolLatencyHistogram(SECRET_A, null);
      expect(hist).toHaveLength(1);
      expect(hist[0].tool).toBe('Edit');
      expect(hist[0].count).toBe(2);
    });

    it('getPromptTimeline pulls model from a bare-named user_prompt event', async () => {
      const now = new Date();
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p-tl', eventName: 'user_prompt', attrs: { model: 'sonnet-4-6' } });
      await insertRawEvent({ ts: new Date(now.getTime() + 1000), projectSecret: SECRET_A, promptId: 'p-tl', eventName: 'api_request' });
      const timeline = await getPromptTimeline('p-tl');
      expect(timeline.model).toBe('sonnet-4-6');
      expect(timeline.entries).toHaveLength(2);
    });

    it('getPerTicketRollup attributes bare-named user_prompt + api_request events', async () => {
      const now = new Date();
      await insertRawEvent({
        ts: now,
        projectSecret: SECRET_A,
        promptId: 'p-ticket',
        eventName: 'user_prompt',
        body: { body: '<!-- hotsheet:ticket=HS-9001 --> do the thing' },
      });
      await insertRawEvent({
        ts: new Date(now.getTime() + 1000),
        projectSecret: SECRET_A,
        promptId: 'p-ticket',
        eventName: 'api_request',
        attrs: { cost: 0.4, tokens: 1500 },
      });
      // HS-9257 — recompute the per-ticket rollup from raw (production backfill
      // path), then read it under the project's secret.
      await backfillTicketsForDir('', await getTelemetryDb(), await getRollupDb(), SECRET_A);
      const rollup = await getPerTicketRollup('HS-9001', SECRET_A);
      expect(rollup.promptCount).toBe(1);
      expect(rollup.totalCost).toBeCloseTo(0.4);
      expect(rollup.totalTokens).toBe(1500);
    });

    it('prompt counts (window / cost-by-project / heatmap) work on bare-named events', async () => {
      const now = new Date();
      // Cost metric so the project appears in the cross-project rollup.
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 1.0 });
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p-a', eventName: 'user_prompt' });
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p-b', eventName: 'user_prompt' });

      expect((await getWindowTotals(SECRET_A, null)).promptCount).toBe(2);

      const byProject = await getCostByProject(null);
      expect(byProject.find(r => r.projectSecret === SECRET_A)?.promptCount).toBe(2);

      const heatmap = await getHourlyActivityHeatmap(null, 'UTC');
      expect(heatmap.reduce((sum, c) => sum + c.promptCount, 0)).toBe(2);
    });

    it('counts a MIX of dotted + bare spellings together (live DBs hold both)', async () => {
      const now = new Date();
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p-dotted', eventName: 'claude_code.user_prompt' });
      await insertRawEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p-bare', eventName: 'user_prompt' });
      // Distinct prompt ids across both spellings → 2 recent prompts, count 2.
      expect(await getRecentPrompts(SECRET_A, 10)).toHaveLength(2);
      expect((await getWindowTotals(SECRET_A, null)).promptCount).toBe(2);
    });
  });

  // HS-8708 — a CUMULATIVE monotonic cost/token counter (a foreign telemetry
  // source — Hot Sheet's own spawn env forces delta) reports the running TOTAL
  // on every export, so summing those rows re-inflates the dashboards (the
  // 18-60× HS-8599 overcount). HS-8600 records each row's temporality; these
  // tests prove the SUM aggregations now EXCLUDE cumulative monotonic rows while
  // still counting delta + legacy-NULL rows.
  describe('cumulative monotonic exclusion (HS-8708)', () => {
    it('getWindowTotals excludes a cumulative monotonic cost row but keeps delta + legacy rows', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 }); // legacy NULL temporality
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.25, temporality: 'delta', isMonotonic: true });
      // The poison row: a running-total snapshot that would balloon the SUM.
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 999, temporality: 'cumulative', isMonotonic: true });

      const totals = await getWindowTotals(SECRET_A, null);
      // 0.5 + 0.25 only — the $999 cumulative row is dropped.
      expect(totals.cost).toBeCloseTo(0.75);
    });

    it('getWindowTotals excludes a cumulative monotonic token row', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 1000 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, type: 'input', tokens: 9_000_000, temporality: 'cumulative', isMonotonic: true });

      const totals = await getWindowTotals(SECRET_A, null);
      expect(totals.tokens).toBe(1000);
      expect(totals.inputTokens).toBe(1000);
    });

    it('a NON-monotonic cumulative row is still counted (only monotonic counters re-inflate)', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5, temporality: 'cumulative', isMonotonic: false });
      const totals = await getWindowTotals(SECRET_A, null);
      // is_monotonic=false ⇒ not the re-inflating shape ⇒ kept.
      expect(totals.cost).toBeCloseTo(0.5);
    });

    it('getTodayCost, getCostByProject, getCostByModel, getCostOverTime + heatmap all drop the cumulative row', async () => {
      const t = new Date('2026-05-18T10:30:00Z'); // Monday 10:00 UTC
      await insertCostMetric({ ts: t, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5, temporality: 'delta', isMonotonic: true });
      await insertCostMetric({ ts: t, projectSecret: SECRET_A, model: 'sonnet', cost: 999, temporality: 'cumulative', isMonotonic: true });
      await insertTokenMetric({ ts: t, projectSecret: SECRET_A, model: 'sonnet', type: 'input', tokens: 100 });
      await insertTokenMetric({ ts: t, projectSecret: SECRET_A, model: 'sonnet', type: 'input', tokens: 9_000_000, temporality: 'cumulative', isMonotonic: true });

      // getTodayCost keys off today's midnight, so seed a today-row for it.
      const today = new Date();
      await insertCostMetric({ ts: today, projectSecret: SECRET_B, cost: 1.0, temporality: 'delta', isMonotonic: true });
      await insertCostMetric({ ts: today, projectSecret: SECRET_B, cost: 555, temporality: 'cumulative', isMonotonic: true });
      expect(await getTodayCost(SECRET_B)).toBeCloseTo(1.0);

      const byProject = await getCostByProject(null);
      const a = byProject.find(r => r.projectSecret === SECRET_A);
      expect(a?.cost).toBeCloseTo(0.5);
      expect(a?.tokens).toBe(100);

      const byModel = await getCostByModel(SECRET_A, null);
      const sonnet = byModel.find(m => m.model === 'sonnet');
      expect(sonnet?.cost).toBeCloseTo(0.5);
      expect(sonnet?.tokens).toBe(100);

      const series = await getCostOverTime(null, SECRET_A, 'UTC', new Date('2026-05-19T00:00:00Z'));
      const sonnetTotal = series.filter(p => p.projectSecret === SECRET_A).reduce((s, p) => s + p.cost, 0);
      expect(sonnetTotal).toBeCloseTo(0.5);

      const cells = await getHourlyActivityHeatmap(null, 'UTC');
      // HS-9279 — server-local (dow, hour) bucket; $0.50 delta only, NOT $999.50.
      expect(cells[t.getDay() * 24 + t.getHours()].cost).toBeCloseTo(0.5);
    });
  });
});
