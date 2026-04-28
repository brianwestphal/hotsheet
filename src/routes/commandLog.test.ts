/**
 * HS-7987 — tests for the terminal-prompt audit endpoint added to
 * `routes/commandLog.ts`. Posts audit entries for §52 auto-allowed
 * prompts and verifies the `terminal_prompt_auto_allow` event_type lands
 * in the command log with the right summary + detail shape.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { clearLog, getLogEntries } from '../db/commandLog.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { commandLogRoutes } from './commandLog.js';

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    c.set('projectSecret', 'test-secret');
    await next();
  });
  app.route('/api', commandLogRoutes);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

beforeEach(async () => {
  await clearLog();
});

describe('POST /api/terminal-prompt/audit (HS-7987)', () => {
  it('writes a terminal_prompt_auto_allow entry with the right shape', async () => {
    const res = await app.request('http://localhost/api/terminal-prompt/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parser_id: 'claude-numbered',
        question: 'Loading development channels can pose a security risk',
        choice_label: 'I am using this for local development',
        rule_id: 'tp_abc_123',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('number');

    const entries = await getLogEntries({ limit: 10 });
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.event_type).toBe('terminal_prompt_auto_allow');
    expect(e.summary).toContain('claude-numbered');
    expect(e.summary).toContain('I am using this for local development');
    expect(e.summary).toContain('tp_abc_123');
    expect(e.detail).toContain('Loading development channels');
    expect(e.detail).toContain('Choice: I am using this for local development');
  });

  it('rejects missing parser_id with 400', async () => {
    const res = await app.request('http://localhost/api/terminal-prompt/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule_id: 'tp_x' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing rule_id with 400', async () => {
    const res = await app.request('http://localhost/api/terminal-prompt/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parser_id: 'yesno' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await app.request('http://localhost/api/terminal-prompt/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('truncates very long fields without crashing', async () => {
    const huge = 'x'.repeat(10_000);
    const res = await app.request('http://localhost/api/terminal-prompt/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parser_id: 'claude-numbered',
        question: huge,
        choice_label: huge,
        rule_id: 'tp_x',
      }),
    });
    expect(res.status).toBe(200);
    const entries = await getLogEntries({ limit: 1 });
    expect(entries[0].summary.length).toBeLessThanOrEqual(200);
    expect(entries[0].detail.length).toBeLessThanOrEqual(4000);
  });
});
