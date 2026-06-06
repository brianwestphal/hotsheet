/**
 * HS-8789 — the mid-task telemetry signal collector: groups in-progress
 * `user_prompt` + `tool_result` events by prompt turn into a few narration lines,
 * strips the hotsheet ticket marker, folds orphan tool activity, and honors the
 * cursor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../db/connection.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { collectTelemetrySignals } from './telemetrySignals.js';

const SECRET = 'sec-tele';
const OLD = '2026-06-05T10:00:00.000Z';
const CURSOR = '2026-06-05T12:00:00.000Z';
const NEW = '2026-06-05T14:00:00.000Z';
const NEWER = '2026-06-05T14:01:00.000Z';

let tempDir: string;
beforeAll(async () => { tempDir = await setupTestDb(); });
afterAll(async () => { await cleanupTestDb(tempDir); });
beforeEach(async () => { await (await getDb()).query('DELETE FROM otel_events'); });

async function prompt(ts: string, promptId: string, body: unknown, secret = SECRET): Promise<void> {
  await (await getDb()).query(
    `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
     VALUES ($1, $2, 's1', $3, 'user_prompt', '{}'::jsonb, $4::jsonb)`,
    [ts, secret, promptId, JSON.stringify(body)],
  );
}
async function tool(ts: string, promptId: string, toolName: string, secret = SECRET): Promise<void> {
  await (await getDb()).query(
    `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
     VALUES ($1, $2, 's1', $3, 'tool_result', $4::jsonb, '{}'::jsonb)`,
    [ts, secret, promptId, JSON.stringify({ tool_name: toolName })],
  );
}

describe('collectTelemetrySignals (HS-8789)', () => {
  it('groups a turn into one line: prompt snippet + tool counts', async () => {
    await prompt(NEW, 'p1', { prompt: 'Build the export feature' });
    await tool(NEW, 'p1', 'Bash');
    await tool(NEWER, 'p1', 'Bash');
    await tool(NEWER, 'p1', 'Edit');

    const lines = await collectTelemetrySignals(SECRET, CURSOR);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('[in progress] working on: "Build the export feature" (used Bash ×2, Edit)');
  });

  it('strips the hotsheet ticket marker from the prompt snippet', async () => {
    await prompt(NEW, 'p1', { prompt: '<!-- hotsheet:ticket=HS-42 --> refactor the parser' });
    const lines = await collectTelemetrySignals(SECRET, CURSOR);
    expect(lines[0].text).toBe('[in progress] working on: "refactor the parser"');
  });

  it('folds tool activity with no in-window prompt into one ongoing-work line', async () => {
    // Tool events whose user_prompt started before the cursor (not in window).
    await tool(NEW, 'old-turn', 'Read');
    await tool(NEWER, 'old-turn', 'Read');
    const lines = await collectTelemetrySignals(SECRET, CURSOR);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('[in progress] ongoing work (used Read ×2)');
  });

  it('honors the cursor (pre-cursor events excluded) and scopes by project', async () => {
    await prompt(OLD, 'old', { prompt: 'ancient work' });          // before cursor
    await prompt(NEW, 'p1', { prompt: 'current work' }, 'other');   // different project
    await prompt(NEW, 'p2', { prompt: 'my work' });                 // in window, my project

    const lines = await collectTelemetrySignals(SECRET, CURSOR);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('my work');
  });

  it('returns nothing when there is no telemetry', async () => {
    expect(await collectTelemetrySignals(SECRET, CURSOR)).toEqual([]);
  });
});
