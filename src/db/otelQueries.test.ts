/**
 * HS-8148 — rollup query tests. Seed `otel_metrics` / `otel_events`
 * rows for a known project, then assert each rollup function returns
 * the expected shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getDb } from './connection.js';
import {
  getCostByModel,
  getDrawerPayload,
  getPromptTimeline,
  getQuerySourceRollup,
  getRecentPrompts,
  getTodayCost,
  getToolRollup,
  getWindowTotals,
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
  tokens: number;
}): Promise<void> {
  const db = await getDb();
  const attrs: Record<string, unknown> = {};
  if (opts.model !== undefined) attrs.model = opts.model;
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
    });
  });

  describe('getDrawerPayload', () => {
    it('returns every section in one bundle', async () => {
      const now = new Date();
      await insertCostMetric({ ts: now, projectSecret: SECRET_A, model: 'sonnet-4', source: 'main_agent', cost: 0.5 });
      await insertPromptEvent({ ts: now, projectSecret: SECRET_A, promptId: 'p1', model: 'sonnet-4' });
      await insertToolResultEvent({ ts: now, projectSecret: SECRET_A, toolName: 'Edit', durationMs: 100 });

      const payload = await getDrawerPayload(SECRET_A);
      expect(payload.today.cost).toBe(0.5);
      expect(payload.allTime.cost).toBe(0.5);
      expect(payload.costByModel).toHaveLength(1);
      expect(payload.costByModel[0].model).toBe('sonnet-4');
      expect(payload.toolRollup).toHaveLength(1);
      expect(payload.toolRollup[0].tool).toBe('Edit');
      expect(payload.querySourceRollup).toHaveLength(1);
      expect(payload.querySourceRollup[0].source).toBe('main_agent');
      expect(payload.recentPrompts).toHaveLength(1);
      expect(payload.recentPrompts[0].promptId).toBe('p1');
    });
  });
});
