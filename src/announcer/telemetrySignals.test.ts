/**
 * HS-8789 — the mid-task telemetry signal collector: groups in-progress
 * `user_prompt` + `tool_result` events by prompt turn into a few narration lines,
 * strips the hotsheet ticket marker, and honors the cursor. HS-8806 — orphan tool
 * activity (no in-window prompt) is dropped, not folded into an "ongoing work"
 * line, since bare tool churn has no cohesive content to narrate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../db/connection.js';
import { registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { collectTelemetrySignals } from './telemetrySignals.js';

const SECRET = 'sec-tele';
const OLD = '2026-06-05T10:00:00.000Z';
const CURSOR = '2026-06-05T12:00:00.000Z';
const NEW = '2026-06-05T14:00:00.000Z';
const NEWER = '2026-06-05T14:01:00.000Z';

let tempDir: string;
beforeAll(async () => {
  tempDir = await setupTestDb();
  // HS-8874 — `collectTelemetrySignals` reads the project's OWN telemetry DB
  // (resolved from its secret). Register SECRET against the test DB so the
  // seeded rows are visible.
  registerExistingProject(tempDir, SECRET, await getDb());
});
afterAll(async () => { unregisterProject(SECRET); await cleanupTestDb(tempDir); });
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

  it('does NOT emit a line for tool activity with no in-window prompt (HS-8806)', async () => {
    // Tool events whose user_prompt started before the cursor (not in window).
    // Pre-HS-8806 this folded into an "[in progress] ongoing work (used Read ×2)"
    // line, which the summarizer turned into valueless "Read Bash Edit" entries.
    // With no prompt context there's nothing cohesive to narrate, so it's dropped.
    await tool(NEW, 'old-turn', 'Read');
    await tool(NEWER, 'old-turn', 'Read');
    await tool(NEW, 'old-turn-2', 'Bash');
    expect(await collectTelemetrySignals(SECRET, CURSOR)).toEqual([]);
  });

  it('still emits in-window prompt turns even when orphan tool churn is present (HS-8806)', async () => {
    await prompt(NEW, 'p1', { prompt: 'fix the export bug' });
    await tool(NEW, 'p1', 'Edit');
    await tool(NEW, 'orphan', 'Read'); // no in-window prompt → contributes nothing
    const lines = await collectTelemetrySignals(SECRET, CURSOR);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('[in progress] working on: "fix the export bug" (used Edit)');
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
