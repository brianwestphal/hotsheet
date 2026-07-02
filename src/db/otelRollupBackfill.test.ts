/**
 * HS-9234 (epic HS-9226 Phase 2) — backfill tests.
 *
 * Two layers:
 *   1. `assembleDailyRows` — pure 1:1 map of the metric grain query rows into
 *      DailyGrainRow (HS-9259: distinct counts no longer live here — they're in
 *      otel_daily_seen).
 *   2. `backfillDailyForDir` / `backfillTicketsForDir` against a real PGlite: raw
 *      `otel_*` seeded in the telemetry CLUSTER, rollups recomputed into the MAIN
 *      db, asserting parity with `getPerTicketRollup`, model_breakdown, the daily
 *      aggregate, and IDEMPOTENCE (recompute twice → identical).
 */
import type { PGlite } from '@electric-sql/pglite';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDb, getDbForDir, telemetryClusterDataDir } from './connection.js';
import { getPerTicketRollup } from './otelDashboard.js';
import { assembleDailyRows, backfillActivityHourForDir, backfillActivityToolForDir, backfillDailyForDir, backfillDailySeenForDir, backfillTicketPromptSpansForDir, backfillTicketsForDir } from './otelRollupBackfill.js';
import { getHourlyActivityHeatmap, getToolRollup } from './otelRollups.js';

// The machine's local IANA tz — the daily bucket uses it so `(ts AT TIME ZONE TZ)::date`
// matches the local date the `Date(...)` fixtures are constructed in (mirrors
// production, where `serverLocalDay` and the backfill both use the server-local tz).
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

describe('assembleDailyRows (HS-9234 / HS-9259, pure)', () => {
  it('maps grain rows 1:1, coercing string numerics (PGlite returns NUMERIC/BIGINT as strings)', () => {
    const grain = [
      { secret: 'A', day: '2026-06-30', model: 'sonnet', query_source: 'main_agent', cost_usd: '0.5', input_tokens: '100', output_tokens: '50', cache_read_tokens: '9', cache_creation_tokens: '0', datapoint_count: 3 },
      { secret: 'A', day: '2026-06-30', model: 'haiku', query_source: 'subagent', cost_usd: 0.1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, datapoint_count: 9 },
    ];
    const rows = assembleDailyRows(grain);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      project_secret: 'A', day: '2026-06-30', model: 'sonnet', query_source: 'main_agent',
      cost_usd: 0.5, input_tokens: 100, output_tokens: 50, cache_read_tokens: 9, cache_creation_tokens: 0, datapoint_count: 3,
    });
    // HS-9259 — no prompt_count / session_count fields anymore (moved to otel_daily_seen).
    expect(rows[0]).not.toHaveProperty('prompt_count');
    expect(rows[0]).not.toHaveProperty('session_count');
  });

  it('applies (unknown) fallbacks for a missing model / query_source and empty secret', () => {
    const rows = assembleDailyRows([{ day: '2026-06-30', cost_usd: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, datapoint_count: 1 }]);
    expect(rows[0]).toMatchObject({ project_secret: '', model: '(unknown)', query_source: '(unknown)', cost_usd: 1 });
  });

  it('returns an empty array for no grain rows (no synthesized carriers — distinct counts live in otel_daily_seen)', () => {
    expect(assembleDailyRows([])).toEqual([]);
  });
});

describe('backfill against a real PGlite cluster (HS-9234)', () => {
  let centralOverrideDir: string;
  beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
  afterAll(async () => {
    await closeDbForDir(centralTelemetryDataDir());
    delete process.env.HOTSHEET_TELEMETRY_DIR;
    rmSync(centralOverrideDir, { recursive: true, force: true });
  });

  let tempDir: string;
  let clusterDb: PGlite;
  let mainDb: PGlite;
  const SECRET = 'sec-A';

  beforeEach(async () => {
    tempDir = await setupTestDb();
    // Raw telemetry lives in the relocated cluster; rollups in the main db.
    clusterDb = await getDbForDir(telemetryClusterDataDir(tempDir));
    mainDb = await getDb();
  });
  afterEach(async () => {
    await closeDbForDir(telemetryClusterDataDir(tempDir));
    await cleanupTestDb(tempDir);
  });

  async function insertCostMetric(ts: Date, model: string, source: string, cost: number, session = 'session-1'): Promise<void> {
    await clusterDb.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
       VALUES ($1, $2, $3, 'claude_code.cost.usage', $4::jsonb, $5::jsonb, 'delta', true)`,
      [ts, SECRET, session, JSON.stringify({ model, 'query.source': source, 'session.id': session }), JSON.stringify({ asDouble: cost })],
    );
  }
  async function insertTokenMetric(ts: Date, model: string, source: string, type: string, tokens: number): Promise<void> {
    await clusterDb.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
       VALUES ($1, $2, 'session-1', 'claude_code.token.usage', $3::jsonb, $4::jsonb, 'delta', true)`,
      [ts, SECRET, JSON.stringify({ model, 'query.source': source, type }), JSON.stringify({ asInt: tokens })],
    );
  }
  async function insertApiRequest(ts: Date, promptId: string, model: string, cost: number, tokens: number): Promise<void> {
    await clusterDb.query(
      `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
       VALUES ($1, $2, 'session-1', $3, 'claude_code.api_request', $4::jsonb, '{}'::jsonb)`,
      [ts, SECRET, promptId, JSON.stringify({ model, cost, tokens })],
    );
  }
  async function insertUserPrompt(ts: Date, promptId: string, body: string): Promise<void> {
    await clusterDb.query(
      `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
       VALUES ($1, $2, 'session-1', $3, 'claude_code.user_prompt', '{}'::jsonb, $4::jsonb)`,
      [ts, SECRET, promptId, JSON.stringify({ stringValue: body })],
    );
  }
  async function openInterval(ticket: string, started: Date, ended: Date | null): Promise<void> {
    await clusterDb.query(
      `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at) VALUES ($1, $2, $3, $4)`,
      [SECRET, ticket, started, ended],
    );
  }

  async function insertToolResult(ts: Date, tool: string, durationMs?: number): Promise<void> {
    const attrs: Record<string, unknown> = { tool_name: tool };
    if (durationMs !== undefined) attrs.duration_ms = durationMs;
    await clusterDb.query(
      `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
       VALUES ($1, $2, 'session-1', 'p1', 'claude_code.tool_result', $3::jsonb, '{}'::jsonb)`,
      [ts, SECRET, JSON.stringify(attrs)],
    );
  }

  describe('backfillActivityToolForDir (HS-9279)', () => {
    it('recomputes the tool rollup from raw so getToolRollup matches (count + avg duration)', async () => {
      const ts = new Date(2026, 5, 30, 10, 0, 0);
      await insertToolResult(ts, 'Edit', 100);
      await insertToolResult(ts, 'Edit', 200);
      await insertToolResult(ts, 'Read', 50);
      await insertToolResult(ts, 'Read');            // no duration → count only

      const written = await backfillActivityToolForDir(clusterDb, mainDb, TZ);
      expect(written).toBe(2); // two tools

      const rows = await mainDb.query<{ dim1: string; count: string; sum_val: string; sum_n: string }>(
        `SELECT dim1, count, sum_val, sum_n FROM otel_rollup_activity WHERE kind='tool' ORDER BY dim1`,
      );
      expect(rows.rows.map(r => [r.dim1, Number(r.count), Number(r.sum_val), Number(r.sum_n)]))
        .toEqual([['Edit', 2, 300, 2], ['Read', 2, 50, 1]]);

      // Parity: getToolRollup (now reading the rollup) matches the raw aggregate.
      const rollup = await getToolRollup(SECRET, null);
      const byTool = Object.fromEntries(rollup.map(r => [r.tool, r]));
      expect(byTool['Edit']).toMatchObject({ count: 2, avgDurationMs: 150 });
      expect(byTool['Read']).toMatchObject({ count: 2, avgDurationMs: 50 }); // avg over the ONE with duration
    });

    it('is idempotent — a second run yields the same rollup (recompute-overwrite)', async () => {
      const ts = new Date(2026, 5, 30, 10, 0, 0);
      await insertToolResult(ts, 'Edit', 100);
      await backfillActivityToolForDir(clusterDb, mainDb, TZ);
      await backfillActivityToolForDir(clusterDb, mainDb, TZ);
      const rows = await mainDb.query<{ count: string }>(
        `SELECT count FROM otel_rollup_activity WHERE kind='tool' AND dim1='Edit'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(Number(rows.rows[0].count)).toBe(1); // not doubled
    });
  });

  describe('backfillActivityHourForDir (HS-9279)', () => {
    it('recomputes the hour cost rollup + hourly-seen so getHourlyActivityHeatmap matches', async () => {
      const t = new Date(2026, 5, 30, 14, 0, 0); // local — hour 14, some weekday
      await insertCostMetric(t, 'sonnet', 'main', 0.5);
      await insertCostMetric(t, 'sonnet', 'main', 0.25);
      await insertUserPrompt(t, 'p1', 'hi');
      await insertUserPrompt(t, 'p2', 'yo');

      await backfillActivityHourForDir(clusterDb, mainDb, TZ);

      const hour = await mainDb.query<{ dim1: string; sum_val: string }>(
        `SELECT dim1, sum_val FROM otel_rollup_activity WHERE kind='hour'`,
      );
      expect(hour.rows).toHaveLength(1);
      expect(hour.rows[0].dim1).toBe('14');
      expect(Number(hour.rows[0].sum_val)).toBeCloseTo(0.75);
      const seen = await mainDb.query<{ c: string }>(`SELECT COUNT(*) AS c FROM otel_hourly_seen`);
      expect(Number(seen.rows[0].c)).toBe(2);

      // Parity: the heatmap (now reading the rollup) shows the aggregated cell.
      const cells = await getHourlyActivityHeatmap(null, 'UTC', [SECRET]);
      const idx = t.getDay() * 24 + 14;
      expect(cells[idx].cost).toBeCloseTo(0.75);
      expect(cells[idx].promptCount).toBe(2);
    });
  });

  describe('backfillDailyForDir', () => {
    it('recomputes cost / split tokens / datapoint_count per (day, model, source)', async () => {
      const ts = new Date(2026, 5, 30, 10, 0, 0); // local 2026-06-30
      await insertCostMetric(ts, 'sonnet', 'main_agent', 0.4);
      await insertCostMetric(ts, 'sonnet', 'main_agent', 0.1);
      await insertTokenMetric(ts, 'sonnet', 'main_agent', 'input', 100);
      await insertTokenMetric(ts, 'sonnet', 'main_agent', 'output', 50);
      await insertTokenMetric(ts, 'sonnet', 'main_agent', 'cacheRead', 999);

      const written = await backfillDailyForDir(clusterDb, mainDb, TZ);
      expect(written).toBe(1);

      const r = await mainDb.query<{ cost_usd: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; datapoint_count: number; day: string }>(
        `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, datapoint_count, day::text AS day FROM otel_rollup_daily WHERE project_secret = '${SECRET}'`,
      );
      expect(r.rows).toHaveLength(1);
      expect(Number(r.rows[0].cost_usd)).toBeCloseTo(0.5, 6);
      expect(Number(r.rows[0].input_tokens)).toBe(100);
      expect(Number(r.rows[0].output_tokens)).toBe(50);
      expect(Number(r.rows[0].cache_read_tokens)).toBe(999);
      expect(r.rows[0].datapoint_count).toBe(5); // 2 cost + 3 token datapoints
      expect(r.rows[0].day).toBe('2026-06-30');
    });

    it('excludes cumulative-monotonic counters (no re-inflation)', async () => {
      const ts = new Date(2026, 5, 30, 10, 0, 0);
      await clusterDb.query(
        `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
         VALUES ($1, $2, 's', 'claude_code.cost.usage', $3::jsonb, $4::jsonb, 'cumulative', true)`,
        [ts, SECRET, JSON.stringify({ model: 'm', 'query.source': 's' }), JSON.stringify({ asDouble: 100 })],
      );
      await backfillDailyForDir(clusterDb, mainDb, TZ);
      const c = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_daily`);
      expect(c.rows[0].c).toBe(0);
    });

    it('recomputes cost and is idempotent (HS-9259 — distinct counts now live in otel_daily_seen)', async () => {
      const ts = new Date(2026, 5, 30, 10, 0, 0);
      await insertCostMetric(ts, 'sonnet', 'main_agent', 0.5, 'sessX');
      await insertCostMetric(ts, 'sonnet', 'main_agent', 0.5, 'sessY');

      await backfillDailyForDir(clusterDb, mainDb, TZ);
      const first = await mainDb.query<{ cost_usd: string }>(`SELECT SUM(cost_usd) AS cost_usd FROM otel_rollup_daily`);
      expect(Number(first.rows[0].cost_usd)).toBeCloseTo(1.0, 6);

      // Recompute → identical (no doubling).
      await backfillDailyForDir(clusterDb, mainDb, TZ);
      const second = await mainDb.query<{ cost_usd: string }>(`SELECT SUM(cost_usd) AS cost_usd FROM otel_rollup_daily`);
      expect(Number(second.rows[0].cost_usd)).toBeCloseTo(1.0, 6);
    });
  });

  describe('backfillTicketsForDir', () => {
    it('reconstructs per-ticket cost via the time-window path, matching getPerTicketRollup', async () => {
      await openInterval('HS-100', new Date(2026, 0, 1, 9, 0, 0), new Date(2026, 0, 1, 10, 0, 0));
      const t1 = new Date(2026, 0, 1, 9, 15, 0);
      const t2 = new Date(2026, 0, 1, 9, 45, 0);
      await insertApiRequest(t1, 'pw1', 'sonnet', 0.2, 1000);
      await insertApiRequest(t2, 'pw1', 'sonnet', 0.3, 500);
      await insertApiRequest(t2, 'pw2', 'haiku', 0.1, 200);

      const written = await backfillTicketsForDir(tempDir, clusterDb, mainDb, SECRET);
      expect(written).toBe(1);
      // HS-9257 — getPerTicketRollup now reads duration from the span table, so
      // populate it too before the parity comparison.
      await backfillTicketPromptSpansForDir(clusterDb, mainDb, SECRET);

      const live = await getPerTicketRollup('HS-100', SECRET);
      const r = await mainDb.query<{ cost_usd: string; total_tokens: string; prompt_count: number; model_breakdown: Record<string, { cost: number; tokens: number }> }>(
        `SELECT cost_usd, total_tokens, prompt_count, model_breakdown FROM otel_rollup_ticket WHERE ticket_number = 'HS-100'`,
      );
      expect(r.rows).toHaveLength(1);
      // Parity with the canonical read (cost / tokens / prompt from otel_rollup_ticket).
      expect(Number(r.rows[0].cost_usd)).toBeCloseTo(live.totalCost, 6);
      expect(Number(r.rows[0].total_tokens)).toBe(live.totalTokens);
      expect(r.rows[0].prompt_count).toBe(live.promptCount);
      // HS-9259 — duration is no longer a rollup column; getPerTicketRollup derives
      // it from otel_ticket_prompt_span (pw1 spans 09:15→09:45 = 1800s; pw2 single).
      expect(live.totalDurationSeconds).toBeCloseTo(1800, 3);
      // model_breakdown sums to the scalar totals.
      const mb = r.rows[0].model_breakdown;
      expect(mb['sonnet'].cost).toBeCloseTo(0.5, 6);
      expect(mb['sonnet'].tokens).toBe(1500);
      expect(mb['haiku'].cost).toBeCloseTo(0.1, 6);
      expect(mb['haiku'].tokens).toBe(200);
      expect(mb['sonnet'].cost + mb['haiku'].cost).toBeCloseTo(Number(r.rows[0].cost_usd), 6);
    });

    it('reconstructs per-ticket cost via the marker path (no work interval)', async () => {
      // A prompt body carrying the marker; its api_request shares prompt_id.
      await insertUserPrompt(new Date(2026, 0, 2, 9, 0, 0), 'pm1', '<!-- hotsheet:ticket=HS-200 --> please fix');
      await insertApiRequest(new Date(2026, 0, 2, 9, 1, 0), 'pm1', 'sonnet', 0.7, 300);

      const written = await backfillTicketsForDir(tempDir, clusterDb, mainDb, SECRET);
      expect(written).toBe(1);
      const r = await mainDb.query<{ ticket_number: string; cost_usd: string; model_breakdown: Record<string, { cost: number; tokens: number }> }>(
        `SELECT ticket_number, cost_usd, model_breakdown FROM otel_rollup_ticket`,
      );
      expect(r.rows[0].ticket_number).toBe('HS-200');
      expect(Number(r.rows[0].cost_usd)).toBeCloseTo(0.7, 6);
      expect(r.rows[0].model_breakdown['sonnet'].tokens).toBe(300);
    });

    it('is idempotent (recompute → identical, no doubling)', async () => {
      await openInterval('HS-300', new Date(2026, 0, 3, 9, 0, 0), null);
      await insertApiRequest(new Date(2026, 0, 3, 9, 5, 0), 'pi1', 'sonnet', 0.9, 400);

      await backfillTicketsForDir(tempDir, clusterDb, mainDb, SECRET);
      await backfillTicketsForDir(tempDir, clusterDb, mainDb, SECRET);
      const r = await mainDb.query<{ c: number; cost_usd: string }>(
        `SELECT COUNT(*)::int AS c, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM otel_rollup_ticket`,
      );
      expect(r.rows[0].c).toBe(1);
      expect(Number(r.rows[0].cost_usd)).toBeCloseTo(0.9, 6);
    });

    it('skips tickets with no attributed telemetry, and is a no-op for the central store', async () => {
      // An interval with no api_request inside it → no rollup row.
      await openInterval('HS-400', new Date(2026, 0, 4, 9, 0, 0), new Date(2026, 0, 4, 9, 1, 0));
      const written = await backfillTicketsForDir(tempDir, clusterDb, mainDb, SECRET);
      expect(written).toBe(0);
      const c = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_ticket`);
      expect(c.rows[0].c).toBe(0);

      // Central store (null secret) → skipped entirely.
      expect(await backfillTicketsForDir(tempDir, clusterDb, mainDb, null)).toBe(0);
    });
  });

  describe('backfillDailySeenForDir (HS-9243)', () => {
    it('derives distinct prompts + sessions per day and is idempotent', async () => {
      const day1 = new Date(2026, 5, 30, 10, 0, 0);
      const day2 = new Date(2026, 6, 1, 10, 0, 0);
      // Two prompts on day1 (one repeated across events), one on day2.
      await insertUserPrompt(day1, 'p1', 'hi');
      await insertApiRequest(day1, 'p1', 'sonnet', 0.1, 10); // same prompt_id, different event
      await insertUserPrompt(day1, 'p2', 'yo');
      await insertUserPrompt(day2, 'p3', 'later');
      // Two sessions on day1 (repeated across metrics), one on day2.
      await insertCostMetric(day1, 'sonnet', 'main_agent', 0.5, 'sessA');
      await insertCostMetric(day1, 'sonnet', 'main_agent', 0.5, 'sessA');
      await insertCostMetric(day1, 'sonnet', 'main_agent', 0.5, 'sessB');
      await insertCostMetric(day2, 'sonnet', 'main_agent', 0.5, 'sessC');

      const inserted = await backfillDailySeenForDir(clusterDb, mainDb, TZ);
      // 3 distinct prompts (p1@d1, p2@d1, p3@d2) + 3 distinct sessions (A@d1, B@d1, C@d2).
      expect(inserted).toBe(6);

      const prompts = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_daily_seen WHERE kind='prompt'`);
      const sessions = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_daily_seen WHERE kind='session'`);
      expect(prompts.rows[0].c).toBe(3);
      expect(sessions.rows[0].c).toBe(3);

      // p1 appears on day1 only — one row, not one per event.
      const p1 = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_daily_seen WHERE kind='prompt' AND id='p1'`);
      expect(p1.rows[0].c).toBe(1);

      // Re-running inserts nothing new (ON CONFLICT DO NOTHING).
      expect(await backfillDailySeenForDir(clusterDb, mainDb, TZ)).toBe(0);
      const total = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_daily_seen`);
      expect(total.rows[0].c).toBe(6);
    });

    it('excludes cumulative-monotonic metrics from the session set', async () => {
      const ts = new Date(2026, 5, 30, 10, 0, 0);
      await clusterDb.query(
        `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
         VALUES ($1, $2, 'sessCum', 'claude_code.cost.usage', $3::jsonb, $4::jsonb, 'cumulative', true)`,
        [ts, SECRET, JSON.stringify({ model: 'm', 'query.source': 's', 'session.id': 'sessCum' }), JSON.stringify({ asDouble: 1 })],
      );
      await backfillDailySeenForDir(clusterDb, mainDb, TZ);
      const c = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_daily_seen WHERE kind='session'`);
      expect(c.rows[0].c).toBe(0);
    });
  });

  describe('backfillTicketPromptSpansForDir (HS-9243 part 2)', () => {
    async function openInterval(ticket: string, started: Date, ended: Date | null): Promise<void> {
      await clusterDb.query(
        `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at) VALUES ($1, $2, $3, $4)`,
        [SECRET, ticket, started, ended],
      );
    }
    const durOf = async (ticket: string, promptId: string): Promise<number> => {
      const r = await mainDb.query<{ dur: string }>(
        `SELECT EXTRACT(EPOCH FROM (last_ts - first_ts)) AS dur FROM otel_ticket_prompt_span WHERE ticket_number=$1 AND prompt_id=$2`,
        [ticket, promptId]);
      return r.rows.length === 0 ? -1 : Number(r.rows[0].dur);
    };

    it('derives per-prompt spans via the time-window path + is idempotent', async () => {
      await openInterval('HS-100', new Date(2026, 0, 1, 9, 0, 0), new Date(2026, 0, 1, 10, 0, 0));
      // Prompt pw1 spans 09:10 → 09:40 (30 min); pw2 is a single event.
      await insertApiRequest(new Date(2026, 0, 1, 9, 10, 0), 'pw1', 'sonnet', 0.1, 10);
      await insertApiRequest(new Date(2026, 0, 1, 9, 40, 0), 'pw1', 'sonnet', 0.1, 10);
      await insertApiRequest(new Date(2026, 0, 1, 9, 20, 0), 'pw2', 'sonnet', 0.1, 10);

      const n1 = await backfillTicketPromptSpansForDir(clusterDb, mainDb, SECRET);
      expect(n1).toBe(2); // two prompts
      expect(await durOf('HS-100', 'pw1')).toBeCloseTo(1800, 3);
      expect(await durOf('HS-100', 'pw2')).toBeCloseTo(0, 3);

      // Re-run: ON CONFLICT LEAST/GREATEST keeps the same spans (no growth).
      await backfillTicketPromptSpansForDir(clusterDb, mainDb, SECRET);
      const c = await mainDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_ticket_prompt_span`);
      expect(c.rows[0].c).toBe(2);
      expect(await durOf('HS-100', 'pw1')).toBeCloseTo(1800, 3);
    });

    it('derives spans via the marker path (no work interval)', async () => {
      await insertUserPrompt(new Date(2026, 0, 2, 9, 0, 0), 'pm1', '<!-- hotsheet:ticket=HS-200 --> fix it');
      await insertApiRequest(new Date(2026, 0, 2, 9, 5, 0), 'pm1', 'sonnet', 0.2, 20);
      await insertApiRequest(new Date(2026, 0, 2, 9, 20, 0), 'pm1', 'sonnet', 0.2, 20);

      const n = await backfillTicketPromptSpansForDir(clusterDb, mainDb, SECRET);
      expect(n).toBe(1);
      expect(await durOf('HS-200', 'pm1')).toBeCloseTo(900, 3); // 15 min
    });

    it('is a no-op for the central store (null secret)', async () => {
      expect(await backfillTicketPromptSpansForDir(clusterDb, mainDb, null)).toBe(0);
    });
  });
});

describe('backfillTelemetryRollups orchestrator (HS-9234)', () => {
  let homeDir: string;
  let centralDir: string;
  let projectDir: string;
  const SECRET = 'sec-orch';

  beforeAll(() => {
    // Sandbox the global config + project list (HOTSHEET_HOME) and the central
    // telemetry store so the run-once flag never touches the real ~/.hotsheet.
    homeDir = createTempDir();
    centralDir = createTempDir();
    process.env.HOTSHEET_HOME = homeDir;
    process.env.HOTSHEET_TELEMETRY_DIR = centralDir;
  });
  afterAll(async () => {
    await closeDbForDir(centralTelemetryDataDir());
    delete process.env.HOTSHEET_HOME;
    delete process.env.HOTSHEET_TELEMETRY_DIR;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(centralDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    projectDir = await setupTestDb();
    // The orchestrator reads the project secret from settings.json + the dir from
    // the project list.
    writeFileSync(join(projectDir, 'settings.json'), JSON.stringify({ secret: SECRET }), 'utf-8');
    writeFileSync(join(homeDir, 'projects.json'), JSON.stringify([projectDir]), 'utf-8');
    // Reset the run-once flags between cases.
    writeFileSync(join(homeDir, 'config.json'), JSON.stringify({}), 'utf-8');
  });
  afterEach(async () => {
    await closeDbForDir(telemetryClusterDataDir(projectDir));
    await cleanupTestDb(projectDir);
  });

  it('backfills the project then self-guards on a second run', async () => {
    const { backfillTelemetryRollups } = await import('./otelRollupBackfill.js');
    const cluster = await getDbForDir(telemetryClusterDataDir(projectDir));
    const ts = new Date(2026, 5, 30, 10, 0, 0);
    await cluster.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
       VALUES ($1, $2, 's1', 'claude_code.cost.usage', $3::jsonb, $4::jsonb, 'delta', true)`,
      [ts, SECRET, JSON.stringify({ model: 'sonnet', 'query.source': 'main_agent', 'session.id': 's1' }), JSON.stringify({ asDouble: 0.42 })],
    );
    await cluster.query(
      `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at) VALUES ($1, 'HS-7', $2, $3)`,
      [SECRET, new Date(2026, 0, 1, 9, 0, 0), new Date(2026, 0, 1, 10, 0, 0)],
    );
    await cluster.query(
      `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
       VALUES ($1, $2, 's1', 'p1', 'claude_code.api_request', $3::jsonb, '{}'::jsonb)`,
      [new Date(2026, 0, 1, 9, 30, 0), SECRET, JSON.stringify({ model: 'sonnet', cost: 0.5, tokens: 800 })],
    );

    const result = await backfillTelemetryRollups(projectDir);
    expect(result.dailyRows).toBeGreaterThanOrEqual(1);
    expect(result.ticketRows).toBe(1);

    const main = await getDbForDir(projectDir);
    const daily = await main.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_daily`);
    const ticket = await main.query<{ cost_usd: string }>(`SELECT cost_usd FROM otel_rollup_ticket WHERE ticket_number = 'HS-7'`);
    expect(daily.rows[0].c).toBeGreaterThanOrEqual(1);
    expect(Number(ticket.rows[0].cost_usd)).toBeCloseTo(0.5, 6);

    // Second run is a no-op (guarded by telemetryRollupBackfilledV1).
    const second = await backfillTelemetryRollups(projectDir);
    expect(second).toEqual({ scannedDirs: 0, dailyRows: 0, ticketRows: 0 });
  });
});
