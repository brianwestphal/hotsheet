/**
 * HS-9233 (epic HS-9226 Phase 2) — ingest-time rollup maintenance tests.
 * Pure helpers + the daily time-series upsert + per-ticket time-window
 * attribution, against a real PGlite (the rollup tables come from initSchema).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getDb } from './connection.js';
import {
  attributeApiRequestToTicket,
  attributeUserPromptToTicket,
  dataPointValue,
  eventNameMatches,
  isCumulativeMonotonic,
  isRollupMetric,
  markDailySeen,
  recordToolActivity,
  serverLocalDay,
  stripNestedAttributes,
  updateActivityRollup,
  updateDailyRollup,
  widenTicketPromptSpan,
} from './otelRollupIngest.js';
import type { MetricAggregation } from './otelWriters.js';

const DELTA: MetricAggregation = { temporality: 'delta', isMonotonic: true };
const NONE: MetricAggregation = { temporality: null, isMonotonic: null };

describe('otelRollupIngest pure helpers (HS-9233)', () => {
  it('isRollupMetric recognizes only the cost/token metrics', () => {
    expect(isRollupMetric('claude_code.cost.usage')).toBe(true);
    expect(isRollupMetric('claude_code.token.usage')).toBe(true);
    expect(isRollupMetric('claude_code.lines_of_code.count')).toBe(false);
    expect(isRollupMetric('whatever')).toBe(false);
  });

  it('isCumulativeMonotonic is true only for a cumulative monotonic counter', () => {
    expect(isCumulativeMonotonic({ temporality: 'cumulative', isMonotonic: true })).toBe(true);
    expect(isCumulativeMonotonic({ temporality: 'cumulative', isMonotonic: false })).toBe(false);
    expect(isCumulativeMonotonic({ temporality: 'delta', isMonotonic: true })).toBe(false);
    expect(isCumulativeMonotonic(NONE)).toBe(false);
  });

  it('serverLocalDay formats a local YYYY-MM-DD', () => {
    // Construct via local-time fields so the test is timezone-independent.
    const d = new Date(2026, 5, 30, 23, 59, 0); // 2026-06-30 local
    expect(serverLocalDay(d)).toBe('2026-06-30');
  });

  it('dataPointValue reads asDouble, asInt (incl. string), else 0', () => {
    expect(dataPointValue({ asDouble: 0.42 })).toBe(0.42);
    expect(dataPointValue({ asInt: 100 })).toBe(100);
    expect(dataPointValue({ asInt: '250' })).toBe(250); // OTLP encodes ints as strings
    expect(dataPointValue({ asDouble: 0, asInt: '5' })).toBe(0); // asDouble present wins
    expect(dataPointValue({})).toBe(0);
  });

  it('stripNestedAttributes removes only the nested attributes key', () => {
    const point = { asDouble: 1, timeUnixNano: '1', attributes: [{ key: 'model' }] };
    const stripped = stripNestedAttributes(point);
    expect(stripped).toEqual({ asDouble: 1, timeUnixNano: '1' });
    expect('attributes' in stripped).toBe(false);
    // original untouched
    expect('attributes' in point).toBe(true);
  });

  it('stripNestedAttributes is a no-op when there is no attributes key', () => {
    const obj = { body: { stringValue: 'hi' } };
    expect(stripNestedAttributes(obj)).toEqual(obj);
  });

  it('eventNameMatches tolerates bare + dotted forms', () => {
    expect(eventNameMatches('api_request', 'api_request')).toBe(true);
    expect(eventNameMatches('claude_code.api_request', 'api_request')).toBe(true);
    expect(eventNameMatches('user_prompt', 'api_request')).toBe(false);
  });
});

describe('updateDailyRollup (HS-9233)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  const ts = new Date(2026, 5, 30, 10, 0, 0);

  it('accumulates cost across data points in the same (project, day, model, source) bucket', async () => {
    const db = await getDb();
    const attrs = { model: 'sonnet-4', 'query.source': 'main_agent' };
    expect(await updateDailyRollup(db, 'sec', ts, 'claude_code.cost.usage', 0.4, attrs, DELTA)).toBe(true);
    await updateDailyRollup(db, 'sec', ts, 'claude_code.cost.usage', 0.1, attrs, DELTA);

    const rows = await db.query<{ cost_usd: string; datapoint_count: number }>(
      `SELECT cost_usd, datapoint_count FROM otel_rollup_daily WHERE project_secret='sec'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0].cost_usd)).toBeCloseTo(0.5, 6);
    expect(rows.rows[0].datapoint_count).toBe(2);
  });

  it('splits token.usage into the right column by type', async () => {
    const db = await getDb();
    const base = { model: 'sonnet-4', 'query.source': 'main_agent' };
    await updateDailyRollup(db, 'sec', ts, 'claude_code.token.usage', 100, { ...base, type: 'input' }, DELTA);
    await updateDailyRollup(db, 'sec', ts, 'claude_code.token.usage', 50, { ...base, type: 'output' }, DELTA);
    await updateDailyRollup(db, 'sec', ts, 'claude_code.token.usage', 999, { ...base, type: 'cacheRead' }, DELTA);
    await updateDailyRollup(db, 'sec', ts, 'claude_code.token.usage', 7, { ...base, type: 'cacheCreation' }, DELTA);

    const r = await db.query<{ input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_creation_tokens: string }>(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM otel_rollup_daily WHERE project_secret='sec'`,
    );
    expect(Number(r.rows[0].input_tokens)).toBe(100);
    expect(Number(r.rows[0].output_tokens)).toBe(50);
    expect(Number(r.rows[0].cache_read_tokens)).toBe(999);
    expect(Number(r.rows[0].cache_creation_tokens)).toBe(7);
  });

  it('skips a cumulative monotonic counter (no re-inflation) but counts delta', async () => {
    const db = await getDb();
    const attrs = { model: 'm', 'query.source': 's' };
    expect(await updateDailyRollup(db, 'sec', ts, 'claude_code.cost.usage', 5, attrs, { temporality: 'cumulative', isMonotonic: true })).toBe(false);
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_daily`);
    expect(c.rows[0].c).toBe(0);
  });

  it('returns false for non-rollup metrics', async () => {
    const db = await getDb();
    expect(await updateDailyRollup(db, 'sec', ts, 'claude_code.lines_of_code.count', 5, {}, DELTA)).toBe(false);
  });

  it('uses empty-string project_secret for the central (null) store', async () => {
    const db = await getDb();
    await updateDailyRollup(db, null, ts, 'claude_code.cost.usage', 1, { model: 'm', 'query.source': 's' }, DELTA);
    const r = await db.query<{ project_secret: string }>(`SELECT project_secret FROM otel_rollup_daily`);
    expect(r.rows[0].project_secret).toBe('');
  });

  it('defaults missing model / query.source to (unknown)', async () => {
    const db = await getDb();
    await updateDailyRollup(db, 'sec', ts, 'claude_code.cost.usage', 1, {}, DELTA);
    const r = await db.query<{ model: string; query_source: string }>(`SELECT model, query_source FROM otel_rollup_daily`);
    expect(r.rows[0].model).toBe('(unknown)');
    expect(r.rows[0].query_source).toBe('(unknown)');
  });
});

describe('activity rollup — recordToolActivity / updateActivityRollup (HS-9279)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  const ts = new Date(2026, 5, 30, 10, 0, 0);

  it('accumulates a tool’s count + duration sum/n across events in the same (project, day, tool) bucket', async () => {
    const db = await getDb();
    await recordToolActivity(db, 'sec', ts, { tool_name: 'Edit', duration_ms: 42 });
    await recordToolActivity(db, 'sec', ts, { tool_name: 'Edit', duration_ms: 58 });
    await recordToolActivity(db, 'sec', ts, { tool_name: 'Edit' }); // no duration → count only

    const rows = await db.query<{ dim1: string; count: string; sum_val: string; sum_n: string }>(
      `SELECT dim1, count, sum_val, sum_n FROM otel_rollup_activity WHERE project_secret='sec' AND kind='tool'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].dim1).toBe('Edit');
    expect(Number(rows.rows[0].count)).toBe(3);          // all three events
    expect(Number(rows.rows[0].sum_val)).toBe(100);      // 42 + 58
    expect(Number(rows.rows[0].sum_n)).toBe(2);          // only the two with duration → avg = 50
  });

  it('falls back tool_name → name → (unknown), and keys separate tools apart', async () => {
    const db = await getDb();
    await recordToolActivity(db, 'sec', ts, { name: 'Bash', duration_ms: 10 }); // `name` fallback
    await recordToolActivity(db, 'sec', ts, {});                                // neither → (unknown)
    const rows = await db.query<{ dim1: string; count: string }>(
      `SELECT dim1, count FROM otel_rollup_activity WHERE project_secret='sec' AND kind='tool' ORDER BY dim1`,
    );
    expect(rows.rows.map(r => r.dim1)).toEqual(['(unknown)', 'Bash']);
  });

  it('updateActivityRollup buckets by (project, day, kind, dim1, dim2) and is additive', async () => {
    const db = await getDb();
    await updateActivityRollup(db, 'sec', ts, 'tool_latency', 'Edit', '2', { count: 1 });
    await updateActivityRollup(db, 'sec', ts, 'tool_latency', 'Edit', '2', { count: 1 });
    await updateActivityRollup(db, 'sec', ts, 'tool_latency', 'Edit', '3', { count: 1 });
    const rows = await db.query<{ dim2: string; count: string }>(
      `SELECT dim2, count FROM otel_rollup_activity WHERE kind='tool_latency' AND dim1='Edit' ORDER BY dim2`,
    );
    expect(rows.rows.map(r => [r.dim2, Number(r.count)])).toEqual([['2', 2], ['3', 1]]);
  });
});

describe('per-ticket attribution (HS-9233)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  // The test uses one db for both the cluster role (ticket_work_intervals) and
  // the main role (otel_rollup_ticket) — both tables exist via initSchema.
  async function openInterval(db: Awaited<ReturnType<typeof getDb>>, secret: string, ticket: string, started: Date, ended: Date | null): Promise<void> {
    await db.query(
      `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at) VALUES ($1,$2,$3,$4)`,
      [secret, ticket, started, ended],
    );
  }

  it('attributes an api_request inside an open window to the ticket, merging model_breakdown', async () => {
    const db = await getDb();
    await openInterval(db, 'sec', 'HS-1', new Date(2026, 0, 1, 9, 0, 0), null);
    const ts = new Date(2026, 0, 1, 9, 30, 0);

    await attributeApiRequestToTicket(db, db, 'sec', ts, { cost: 0.2, tokens: 1000, model: 'sonnet-4' });
    await attributeApiRequestToTicket(db, db, 'sec', ts, { cost: 0.3, tokens: 500, model: 'sonnet-4' });
    await attributeApiRequestToTicket(db, db, 'sec', ts, { cost_usd: 0.1, total_tokens: 200, model: 'haiku' });

    const r = await db.query<{ cost_usd: string; total_tokens: string; model_breakdown: Record<string, { cost: number; tokens: number }> }>(
      `SELECT cost_usd, total_tokens, model_breakdown FROM otel_rollup_ticket WHERE project_secret='sec' AND ticket_number='HS-1'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].cost_usd)).toBeCloseTo(0.6, 6);
    expect(Number(r.rows[0].total_tokens)).toBe(1700);
    // PGlite returns a JSONB column as an already-parsed object.
    const mb = r.rows[0].model_breakdown;
    expect(mb['sonnet-4'].cost).toBeCloseTo(0.5, 6);
    expect(mb['sonnet-4'].tokens).toBe(1500);
    expect(mb['haiku'].cost).toBeCloseTo(0.1, 6);
    expect(mb['haiku'].tokens).toBe(200);
  });

  it('does not attribute an api_request outside any window', async () => {
    const db = await getDb();
    await openInterval(db, 'sec', 'HS-1', new Date(2026, 0, 1, 9, 0, 0), new Date(2026, 0, 1, 9, 10, 0));
    // ts is after the interval ended
    await attributeApiRequestToTicket(db, db, 'sec', new Date(2026, 0, 1, 9, 30, 0), { cost: 1, model: 'm' });
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_ticket`);
    expect(c.rows[0].c).toBe(0);
  });

  it('is a no-op for the central (null/empty) store', async () => {
    const db = await getDb();
    await attributeApiRequestToTicket(db, db, null, new Date(), { cost: 1, model: 'm' });
    await attributeApiRequestToTicket(db, db, '', new Date(), { cost: 1, model: 'm' });
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_ticket`);
    expect(c.rows[0].c).toBe(0);
  });

  it('attributes a still-open interval (ended_at NULL) using ts', async () => {
    const db = await getDb();
    await openInterval(db, 'sec', 'HS-9', new Date(2026, 0, 1, 9, 0, 0), null);
    await attributeApiRequestToTicket(db, db, 'sec', new Date(2026, 0, 1, 9, 5, 0), { cost: 0.7, model: 'm' });
    const r = await db.query<{ cost_usd: string }>(`SELECT cost_usd FROM otel_rollup_ticket WHERE ticket_number='HS-9'`);
    expect(Number(r.rows[0].cost_usd)).toBeCloseTo(0.7, 6);
  });

  it('attributeUserPromptToTicket increments prompt_count for the open ticket', async () => {
    const db = await getDb();
    await openInterval(db, 'sec', 'HS-2', new Date(2026, 0, 1, 9, 0, 0), null);
    const ts = new Date(2026, 0, 1, 9, 1, 0);
    await attributeUserPromptToTicket(db, db, 'sec', ts);
    await attributeUserPromptToTicket(db, db, 'sec', ts);
    const r = await db.query<{ prompt_count: number }>(`SELECT prompt_count FROM otel_rollup_ticket WHERE ticket_number='HS-2'`);
    expect(r.rows[0].prompt_count).toBe(2);
  });

  it('attributeApiRequestToTicket widens the prompt span when a promptId is supplied (HS-9243)', async () => {
    const db = await getDb();
    await openInterval(db, 'sec', 'HS-5', new Date(2026, 0, 1, 9, 0, 0), null);
    const t1 = new Date(2026, 0, 1, 9, 10, 0);
    const t2 = new Date(2026, 0, 1, 9, 40, 0); // 30 min later, same prompt
    await attributeApiRequestToTicket(db, db, 'sec', t1, { cost: 0.1, model: 'm' }, 'pA');
    await attributeApiRequestToTicket(db, db, 'sec', t2, { cost: 0.1, model: 'm' }, 'pA');

    const r = await db.query<{ dur: string }>(
      `SELECT EXTRACT(EPOCH FROM (last_ts - first_ts)) AS dur
       FROM otel_ticket_prompt_span WHERE ticket_number='HS-5' AND prompt_id='pA'`);
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].dur)).toBeCloseTo(1800, 3); // 30 min = 1800 s
  });

  it('attributeApiRequestToTicket records no span when promptId is omitted', async () => {
    const db = await getDb();
    await openInterval(db, 'sec', 'HS-6', new Date(2026, 0, 1, 9, 0, 0), null);
    await attributeApiRequestToTicket(db, db, 'sec', new Date(2026, 0, 1, 9, 5, 0), { cost: 0.1, model: 'm' });
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_ticket_prompt_span`);
    expect(c.rows[0].c).toBe(0);
  });
});

describe('widenTicketPromptSpan (HS-9243)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  it('shrinks first_ts to the earliest and grows last_ts to the latest', async () => {
    const db = await getDb();
    await widenTicketPromptSpan(db, 'sec', 'HS-1', 'p1', new Date(2026, 0, 1, 10, 0, 0));
    await widenTicketPromptSpan(db, 'sec', 'HS-1', 'p1', new Date(2026, 0, 1, 9, 0, 0));  // earlier
    await widenTicketPromptSpan(db, 'sec', 'HS-1', 'p1', new Date(2026, 0, 1, 11, 0, 0)); // later
    const r = await db.query<{ dur: string }>(
      `SELECT EXTRACT(EPOCH FROM (last_ts - first_ts)) AS dur FROM otel_ticket_prompt_span WHERE ticket_number='HS-1' AND prompt_id='p1'`);
    expect(Number(r.rows[0].dur)).toBeCloseTo(7200, 3); // 09:00 → 11:00 = 2 h
  });

  it('keeps separate spans per prompt', async () => {
    const db = await getDb();
    await widenTicketPromptSpan(db, 'sec', 'HS-1', 'p1', new Date(2026, 0, 1, 10, 0, 0));
    await widenTicketPromptSpan(db, 'sec', 'HS-1', 'p2', new Date(2026, 0, 1, 10, 0, 0));
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_ticket_prompt_span WHERE ticket_number='HS-1'`);
    expect(c.rows[0].c).toBe(2);
  });

  it('is a no-op for a null/empty secret or promptId', async () => {
    const db = await getDb();
    await widenTicketPromptSpan(db, null, 'HS-1', 'p1', new Date());
    await widenTicketPromptSpan(db, '', 'HS-1', 'p1', new Date());
    await widenTicketPromptSpan(db, 'sec', 'HS-1', '', new Date());
    await widenTicketPromptSpan(db, 'sec', 'HS-1', null, new Date());
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_ticket_prompt_span`);
    expect(c.rows[0].c).toBe(0);
  });
});

describe('markDailySeen (HS-9243 — daily distinct-count dedup set)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  const ts = new Date(2026, 5, 30, 10, 0, 0); // 2026-06-30 local

  const countSeen = async (db: Awaited<ReturnType<typeof getDb>>, secret: string, kind: string): Promise<number> => {
    const r = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM otel_daily_seen WHERE project_secret=$1 AND kind=$2`, [secret, kind]);
    return r.rows[0].c;
  };

  it('records a distinct prompt/session id once per (project, day) — dedups repeats', async () => {
    const db = await getDb();
    await markDailySeen(db, 'sec', ts, 'prompt', 'p1');
    await markDailySeen(db, 'sec', ts, 'prompt', 'p1'); // repeat same day → no-op
    await markDailySeen(db, 'sec', ts, 'prompt', 'p2');
    await markDailySeen(db, 'sec', ts, 'session', 's1');
    expect(await countSeen(db, 'sec', 'prompt')).toBe(2);
    expect(await countSeen(db, 'sec', 'session')).toBe(1);
  });

  it('counts the same id again on a DIFFERENT day (distinct per day)', async () => {
    const db = await getDb();
    await markDailySeen(db, 'sec', new Date(2026, 5, 30, 10, 0, 0), 'prompt', 'p1');
    await markDailySeen(db, 'sec', new Date(2026, 6, 1, 10, 0, 0), 'prompt', 'p1'); // next day
    expect(await countSeen(db, 'sec', 'prompt')).toBe(2);
  });

  it('is a no-op for an empty / null / undefined id', async () => {
    const db = await getDb();
    await markDailySeen(db, 'sec', ts, 'prompt', '');
    await markDailySeen(db, 'sec', ts, 'prompt', null);
    await markDailySeen(db, 'sec', ts, 'session', undefined);
    expect(await countSeen(db, 'sec', 'prompt')).toBe(0);
    expect(await countSeen(db, 'sec', 'session')).toBe(0);
  });

  it('uses empty-string project_secret for the central (null) store', async () => {
    const db = await getDb();
    await markDailySeen(db, null, ts, 'session', 's1');
    expect(await countSeen(db, '', 'session')).toBe(1);
  });

  it('buckets by the server-local day', async () => {
    const db = await getDb();
    await markDailySeen(db, 'sec', ts, 'prompt', 'p1');
    const r = await db.query<{ day: string }>(`SELECT day::text AS day FROM otel_daily_seen WHERE project_secret='sec'`);
    expect(r.rows[0].day).toBe('2026-06-30');
  });
});
