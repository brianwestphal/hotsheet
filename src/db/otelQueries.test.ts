/**
 * HS-8148 — rollup query tests. Seed `otel_metrics` / `otel_events`
 * rows for a known project, then assert each rollup function returns
 * the expected shape.
 */
import { rmSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { closeDbForDir, getDb, getDbForDir, runWithDataDir } from './connection.js';
import {
  clearProjectTelemetry,
  getCostByModel,
  getCostByProject,
  getCostOverTime,
  getDashboardPayload,
  getHourlyActivityHeatmap,
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
} from './otelQueries.js';

const SECRET_A = 'secret-A';
const SECRET_B = 'secret-B';

async function insertCostMetric(opts: {
  ts: Date;
  projectSecret: string;
  model?: string;
  source?: string;
  cost: number;
}): Promise<void> {
  const db = await getDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
  if (opts.source !== undefined) attrs['query.source'] = opts.source;
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [opts.ts, opts.projectSecret, 'session-1', 'claude_code.cost.usage', JSON.stringify(attrs), JSON.stringify({ asDouble: opts.cost })],
  );
}

async function insertTokenMetric(opts: {
  ts: Date;
  projectSecret: string;
  model?: string;
  type?: string;
  tokens: number;
}): Promise<void> {
  const db = await getDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
  if (opts.type !== undefined) attrs.type = opts.type;
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [opts.ts, opts.projectSecret, 'session-1', 'claude_code.token.usage', JSON.stringify(attrs), JSON.stringify({ asInt: opts.tokens })],
  );
}

async function insertPromptEvent(opts: {
  ts: Date;
  projectSecret: string;
  promptId: string;
  model?: string;
}): Promise<void> {
  const db = await getDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
  await db.query(
    `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [opts.ts, opts.projectSecret, 'session-1', opts.promptId, 'claude_code.user_prompt', JSON.stringify(attrs), JSON.stringify({})],
  );
}

async function insertToolResultEvent(opts: {
  ts: Date;
  projectSecret: string;
  toolName: string;
  durationMs?: number;
}): Promise<void> {
  const db = await getDb();
  const attrs: Record<string, unknown> = { tool_name: opts.toolName };
  if (opts.durationMs !== undefined) attrs.duration_ms = opts.durationMs;
  await db.query(
    `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [opts.ts, opts.projectSecret, 'session-1', 'prompt-1', 'claude_code.tool_result', JSON.stringify(attrs), JSON.stringify({})],
  );
}

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
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, tokens: 1000 });
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
      const db = await getDb();
      for (const sid of ['sess-1', 'sess-1', 'sess-2']) {
        await db.query(
          `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [now, SECRET_A, null, 'claude_code.cost.usage', JSON.stringify({ 'session.id': sid }), JSON.stringify({ asDouble: 1 })],
        );
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
  });

  describe('getCostByModel', () => {
    it('groups cost + tokens by model attribute', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', cost: 1.0 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'opus-4', cost: 4.0 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', tokens: 2000 });

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
      const db = await getDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', opts.promptId, opts.eventName, JSON.stringify(opts.attrs ?? {}), JSON.stringify(opts.body ?? {})],
      );
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
        const db = await getDb();
        await db.query(
          `INSERT INTO otel_spans (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [opts.traceId, opts.spanId, opts.parentSpanId, SECRET_A, 'session-1', opts.promptId, opts.spanName, opts.startTs, opts.endTs, JSON.stringify({}), 'OK'],
        );
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
    async function insertToolDuration(opts: {
      ts: Date;
      projectSecret: string;
      toolName: string;
      durationMs: number;
    }): Promise<void> {
      const db = await getDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', 'p1', 'claude_code.tool_result', JSON.stringify({ tool_name: opts.toolName, duration_ms: opts.durationMs }), JSON.stringify({})],
      );
    }

    it('returns empty when there are no tool_result events with duration_ms', async () => {
      const result = await getToolLatencyHistogram(SECRET_A, null);
      expect(result).toEqual([]);
    });

    it('computes p50 + buckets across multiple invocations', async () => {
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
      // p50 of [5×10, 1500] is 5 (the median lies in the dense low bucket).
      expect(editRow.p50).toBe(5);
      // 11 rows: 10 in bucket 0 (<10ms), 1 in bucket 5 (1-5s).
      expect(editRow.buckets[0]).toBe(10);
      expect(editRow.buckets[5]).toBe(1);
      expect(editRow.buckets[1]).toBe(0);
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

    describe('HS-8478 — spans-first source', () => {
      async function insertToolSpan(opts: {
        startTs: Date;
        endTs: Date;
        projectSecret: string;
        spanName: string;
      }): Promise<void> {
        const db = await getDb();
        await db.query(
          `INSERT INTO otel_spans (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          ['trace-1', `span-${String(Math.random())}`, null, opts.projectSecret, 'session-1', 'p-1', opts.spanName, opts.startTs, opts.endTs, JSON.stringify({}), 'OK'],
        );
      }

      it('prefers spans when present + extracts tool name from span_name suffix', async () => {
        const t1 = new Date('2026-05-21T10:00:00.000Z');
        const t2 = new Date('2026-05-21T10:00:00.050Z'); // span1: 50 ms
        const t3 = new Date('2026-05-21T10:00:00.200Z'); // span2: 200 ms
        await insertToolSpan({ startTs: t1, endTs: t2, projectSecret: SECRET_A, spanName: 'claude_code.tool.bash' });
        await insertToolSpan({ startTs: t1, endTs: t3, projectSecret: SECRET_A, spanName: 'claude_code.tool.bash' });
        // Also seed an event with a different duration — should NOT
        // be used because spans take precedence when present.
        await insertToolDuration({ ts: t1, projectSecret: SECRET_A, toolName: 'bash', durationMs: 9999 });

        const result = await getToolLatencyHistogram(SECRET_A, null);
        expect(result).toHaveLength(1);
        expect(result[0].tool).toBe('bash');
        expect(result[0].count).toBe(2);
        // totalMs should be 50 + 200 = 250 ms, NOT the 9999 from the event.
        expect(result[0].totalMs).toBeGreaterThan(240);
        expect(result[0].totalMs).toBeLessThan(260);
      });

      it('falls back to events when no matching spans exist', async () => {
        const now = new Date();
        await insertToolDuration({ ts: now, projectSecret: SECRET_A, toolName: 'Read', durationMs: 30 });
        const result = await getToolLatencyHistogram(SECRET_A, null);
        expect(result).toHaveLength(1);
        expect(result[0].tool).toBe('Read');
        expect(result[0].totalMs).toBe(30);
      });
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
      const db = await getDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', opts.promptId, opts.eventName, JSON.stringify(opts.attrs ?? {}), JSON.stringify(opts.body ?? {})],
      );
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

      const result = await getPerTicketRollup('HS-1234');
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

      const result = await getPerTicketRollup('HS-1234');
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

      const result = await getPerTicketRollup('HS-1234');
      expect(result.promptCount).toBe(0);
      expect(result.totalCost).toBe(0);
    });
  });

  describe('getCostByProject (HS-8480 / §69.3.2)', () => {
    it('returns one row per project that has any cost in the window, sorted by cost DESC', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.25 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 1.5 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, tokens: 1000 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_B, tokens: 3000 });
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
      // Two cost rows at the same UTC hour → cost sums; one at a different hour.
      const t1 = new Date('2026-05-18T10:30:00Z'); // Monday 10:00 UTC
      const t2 = new Date('2026-05-18T10:45:00Z'); // Monday 10:00 UTC
      const t3 = new Date('2026-05-18T14:00:00Z'); // Monday 14:00 UTC
      await insertCostMetric({ ts: t1, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: t2, projectSecret: SECRET_A, cost: 0.25 });
      await insertCostMetric({ ts: t3, projectSecret: SECRET_A, cost: 1.0 });
      await insertPromptEvent({ ts: t1, projectSecret: SECRET_A, promptId: 'p1' });
      await insertPromptEvent({ ts: t2, projectSecret: SECRET_A, promptId: 'p2' });

      const cells = await getHourlyActivityHeatmap(null, 'UTC');
      // Monday = DOW 1 in PG's EXTRACT (0=Sunday). 1 * 24 + 10 = 34
      expect(cells[34].cost).toBeCloseTo(0.75);
      expect(cells[34].promptCount).toBe(2);
      // 1 * 24 + 14 = 38
      expect(cells[38].cost).toBeCloseTo(1.0);
      expect(cells[38].promptCount).toBe(0);
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
    it('returns every section bundled in one call', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, model: 'opus', cost: 1.0 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet' });

      const payload = await getDashboardPayload('all', 'UTC');
      expect(payload.window).toBe('all');
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(1.5);
      expect(payload.costByProject).toHaveLength(2);
      expect(payload.costByProject[0].projectSecret).toBe(SECRET_B); // higher cost first
      expect(payload.costByModel.length).toBeGreaterThan(0);
      expect(payload.hourlyActivity).toHaveLength(168);
      expect(payload.costOverTime.length).toBeGreaterThan(0); // HS-8503 — densified series
    });
  });

  // HS-8625 — the cross-project page should only ever show currently-loaded
  // project data. Telemetry rows outlive their project, so the dashboard route
  // passes the registered project secrets and every aggregate filters to them.
  describe('cross-project loaded-projects filter (HS-8625)', () => {
    it('getDashboardPayload restricts every aggregate to allowedSecrets', async () => {
      const now = new Date();
      // SECRET_A is "loaded"; SECRET_C is a closed project's lingering data.
      const SECRET_C = 'secret-closed-project';
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, tokens: 1000 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'pa', model: 'sonnet' });
      await insertCostMetric({ ts: now, projectSecret: SECRET_C, model: 'opus', cost: 99 });
      await insertTokenMetric({ ts: now, projectSecret: SECRET_C, tokens: 500000 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_C, promptId: 'pc', model: 'opus' });

      const payload = await getDashboardPayload('all', 'UTC', [SECRET_A]);
      // Only the loaded project surfaces — the closed project's big $99 row is gone.
      expect(payload.costByProject).toHaveLength(1);
      expect(payload.costByProject[0].projectSecret).toBe(SECRET_A);
      // Window totals exclude the closed project (would be 99.5 without the filter).
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(0.5);
      // Cost-by-model only sees the loaded project's model.
      expect(payload.costByModel.map(m => m.model)).toContain('sonnet');
      expect(payload.costByModel.map(m => m.model)).not.toContain('opus');
      // Cost-over-time only carries the loaded project's secret.
      expect(payload.costOverTime.every(p => p.projectSecret === SECRET_A)).toBe(true);
    });

    it('getDashboardPayload with an empty allowedSecrets shows nothing (no project loaded)', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 1.0 });
      const payload = await getDashboardPayload('all', 'UTC', []);
      expect(payload.costByProject).toEqual([]);
      expect(payload.windowTotals.allTime.cost).toBe(0);
      expect(payload.costOverTime).toEqual([]);
    });

    it('getDashboardPayload with null allowedSecrets keeps the pre-HS-8625 every-project behavior', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: now, projectSecret: SECRET_B, cost: 1.0 });
      const payload = await getDashboardPayload('all', 'UTC', null);
      expect(payload.costByProject).toHaveLength(2);
      expect(payload.windowTotals.allTime.cost).toBeCloseTo(1.5);
    });

    it('getCostByProject + getHourlyActivityHeatmap honor allowedSecrets directly', async () => {
      const t = new Date('2026-05-18T10:30:00Z'); // Monday 10:00 UTC
      await insertCostMetric({ ts: t, projectSecret: SECRET_A, cost: 0.5 });
      await insertCostMetric({ ts: t, projectSecret: SECRET_B, cost: 2.0 });

      const rows = await getCostByProject(null, [SECRET_A]);
      expect(rows).toHaveLength(1);
      expect(rows[0].projectSecret).toBe(SECRET_A);

      const cells = await getHourlyActivityHeatmap(null, 'UTC', [SECRET_A]);
      // Monday DOW 1, hour 10 → index 34. Only SECRET_A's $0.50 counted.
      expect(cells[34].cost).toBeCloseTo(0.5);
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

    it('counts UNTYPED token rows (fails open — old data / unknown type still counts)', async () => {
      const now = new Date();
      await insertTokenMetric({ ts: now, projectSecret: SECRET_A, tokens: 77 }); // no `type` attr
      const totals = await getWindowTotals(SECRET_A, null);
      expect(totals.tokens).toBe(77);
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
      const t1 = new Date('2026-05-21T08:00:00Z');
      const t2 = new Date('2026-05-21T16:00:00Z');
      await insertCostMetric({ ts: t1, projectSecret: SECRET_A, model: 'sonnet', cost: 0.3 });
      await insertCostMetric({ ts: t2, projectSecret: SECRET_A, model: 'sonnet', cost: 0.4 });

      const since = new Date('2026-05-21T00:00:00Z');
      const now = new Date('2026-05-21T20:00:00Z');
      const points = await getCostOverTime(since, null, 'UTC', now);

      expect(points).toHaveLength(1);
      expect(points[0].cost).toBeCloseTo(0.7);
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

  // HS-8581 — telemetry is a single shared store keyed by `project_secret`,
  // NOT a per-project table set. All OTLP writes land in the default
  // (primary) project's DB; the rollups must read that same DB regardless
  // of which project tab is active. The original bug: rollups went through
  // the per-request `getDb()`, so a *secondary* project's analytics
  // dashboard read its own (telemetry-empty) DB and showed "No telemetry
  // recorded" even though the data was in the primary DB. These tests pin
  // that the rollups ignore the per-request dataDir context.
  describe('HS-8581 — rollups read the shared telemetry DB, not the request-context DB', () => {
    let secondaryDir: string;

    beforeEach(async () => {
      // A second project's data directory + its own (empty) DB, standing in
      // for a secondary project tab whose request context is active when
      // the user opens its analytics dashboard.
      secondaryDir = createTempDir();
      await getDbForDir(secondaryDir);
    });

    afterEach(async () => {
      await closeDbForDir(secondaryDir);
      try { rmSync(secondaryDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('getProjectRollupPayload finds the project\'s data while a different project is the active request context', async () => {
      const now = new Date();
      // Seed telemetry in the DEFAULT DB (where the OTLP receiver writes).
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 0.5 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet' });

      // Run the rollup as if the SECONDARY project tab is active — its own
      // DB has zero telemetry rows. Pre-fix this returned the empty state.
      const payload = await runWithDataDir(secondaryDir, () =>
        getProjectRollupPayload(SECRET_A, 'all', 'UTC'),
      );

      expect(payload.windowTotals.allTime.cost).toBeCloseTo(0.5);
      expect(payload.windowTotals.allTime.promptCount).toBe(1);
      expect(payload.recentPrompts).toHaveLength(1);
      expect(payload.recentPrompts[0].promptId).toBe('p1');
    });

    it('getWindowTotals (the empty-state input) is non-zero under a foreign request context', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet', cost: 1.25 });

      // The analytics empty-state hinges on allTime cost/promptCount being
      // zero. Confirm the shared-DB read keeps it non-zero even when the
      // active context is a different project's (empty) DB.
      const totals = await runWithDataDir(secondaryDir, () =>
        getWindowTotals(SECRET_A, null),
      );
      expect(totals.cost).toBeCloseTo(1.25);
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
      const db = await getDb();
      await db.query(
        `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [opts.ts, opts.projectSecret, 'session-1', opts.promptId, opts.eventName,
          JSON.stringify(opts.attrs ?? {}), JSON.stringify(opts.body ?? {})],
      );
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
      const rollup = await getPerTicketRollup('HS-9001');
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
});
