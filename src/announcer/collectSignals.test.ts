import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDataDir, getDb, telemetryClusterDataDir } from '../db/connection.js';
import { appendOtelJsonl } from '../db/otelJsonlStore.js';
import { createTicket } from '../db/tickets.js';
import { registerExistingProject, unregisterProject } from '../projects.js';
import { buildClaimReclaimNote } from '../systemNotes.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { capMaterial, collectWorkSignals, MAX_INPUT_TOKENS } from './collectSignals.js';

// Mirror of the module's internal char budget (MAX_INPUT_TOKENS * CHARS_PER_TOKEN,
// CHARS_PER_TOKEN = 3). The cap exists so the assembled material never blows the
// Anthropic 1M-token input limit (HS-8752).
const MAX_MATERIAL_CHARS = MAX_INPUT_TOKENS * 3;

let tempDir: string;
const OLD = '2026-06-05T10:00:00.000Z';
const CURSOR = '2026-06-05T12:00:00.000Z';
const NEW = '2026-06-05T14:00:00.000Z';

beforeAll(async () => {
  tempDir = await setupTestDb();
  // HS-8874 — the telemetry-signal path reads the project's OWN DB (resolved
  // from its secret). Register `sec-x` against the test DB so the seeded
  // user_prompt row is visible to `collectTelemetrySignals`.
  registerExistingProject(tempDir, 'sec-x', await getDb());
});
afterAll(async () => { unregisterProject('sec-x'); await cleanupTestDb(tempDir); });

beforeEach(async () => {
  const db = await getDb();
  await db.query('DELETE FROM tickets');
  await db.query('DELETE FROM command_log');
});

async function seed(): Promise<void> {
  const db = await getDb();
  const t = await createTicket('Export feature');
  const notes = JSON.stringify([
    { id: 'n1', text: 'old work on export', created_at: OLD },
    { id: 'n2', text: 'finished the export feature and tests', created_at: NEW },
  ]);
  await db.query(
    `UPDATE tickets SET notes = $1, updated_at = $2, completed_at = $3, status = 'completed' WHERE id = $4`,
    [notes, NEW, NEW, t.id],
  );
  // `trigger` events ARE narrated (the worklist message that kicked off work).
  // HS-8795 — `done` / `permission_request` events are filtered; see the
  // dedicated test below.
  await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('trigger','outgoing','old activity','', $1)`, [OLD]);
  await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('trigger','outgoing','new activity','', $1)`, [NEW]);
}

describe('collectWorkSignals (HS-8745)', () => {
  it('with a cursor: only signals at/after it, chronological', async () => {
    await seed();
    const { material, count, coversFrom } = await collectWorkSignals(CURSOR);

    expect(coversFrom).toBe(CURSOR);
    expect(material).toContain('finished the export feature and tests');
    expect(material).toContain('new activity');
    expect(material).toContain('marked completed');
    // Pre-cursor signals are excluded.
    expect(material).not.toContain('old work on export');
    expect(material).not.toContain('old activity');
    // n2 note + completion + new activity = 3.
    expect(count).toBe(3);
  });

  it('with null cursor: includes the full history', async () => {
    await seed();
    const { material, count } = await collectWorkSignals(null);
    expect(material).toContain('old work on export');
    expect(material).toContain('finished the export feature and tests');
    expect(material).toContain('old activity');
    expect(material).toContain('new activity');
    // both notes + completion + both activities = 5.
    expect(count).toBe(5);
  });

  // HS-8820 — a `started` ticket whose latest note carries the FEEDBACK NEEDED
  // phrase is paused awaiting the user; label it distinctly so the summarizer
  // treats it as a feedback request (status alone stays `started`).
  it('labels FEEDBACK NEEDED / IMMEDIATE FEEDBACK NEEDED notes as WAITING FOR FEEDBACK', async () => {
    const db = await getDb();
    const a = await createTicket('Auth flow');
    await db.query(
      `UPDATE tickets SET notes = $1, updated_at = $2, status = 'started' WHERE id = $3`,
      [JSON.stringify([{ id: 'f1', text: 'FEEDBACK NEEDED: which OAuth provider?', created_at: NEW }]), NEW, a.id],
    );
    const b = await createTicket('Payments');
    await db.query(
      `UPDATE tickets SET notes = $1, updated_at = $2, status = 'started' WHERE id = $3`,
      [JSON.stringify([{ id: 'f2', text: 'IMMEDIATE FEEDBACK NEEDED: prod or sandbox keys?', created_at: NEW }]), NEW, b.id],
    );
    const c = await createTicket('Routine');
    await db.query(
      `UPDATE tickets SET notes = $1, updated_at = $2, status = 'started' WHERE id = $3`,
      [JSON.stringify([{ id: 'r1', text: 'made some progress on the parser', created_at: NEW }]), NEW, c.id],
    );
    // Resolved feedback: the FEEDBACK NEEDED note is no longer the LAST note (a
    // later note answered it) → plain `note`, not a pending feedback request.
    const d = await createTicket('Resolved');
    await db.query(
      `UPDATE tickets SET notes = $1, updated_at = $2, status = 'started' WHERE id = $3`,
      [JSON.stringify([
        { id: 'd1', text: 'FEEDBACK NEEDED: which region?', created_at: NEW },
        { id: 'd2', text: 'going with us-east per the answer', created_at: NEW },
      ]), NEW, d.id],
    );
    // A completed ticket whose last note has the phrase is NOT "waiting" (not started).
    const e = await createTicket('Closed');
    await db.query(
      `UPDATE tickets SET notes = $1, updated_at = $2, completed_at = $2, status = 'completed' WHERE id = $3`,
      [JSON.stringify([{ id: 'e1', text: 'answered FEEDBACK NEEDED inline and shipped', created_at: NEW }]), NEW, e.id],
    );

    const { material } = await collectWorkSignals(CURSOR);
    expect(material).toContain('— WAITING FOR FEEDBACK] FEEDBACK NEEDED: which OAuth provider?');
    expect(material).toContain('— WAITING FOR FEEDBACK] IMMEDIATE FEEDBACK NEEDED: prod or sandbox keys?');
    // A routine note keeps the plain `— note` label.
    expect(material).toContain('— note] made some progress on the parser');
    expect(material).not.toContain('— WAITING FOR FEEDBACK] made some progress');
    // Resolved (not last note) + completed (not started) → plain `note`.
    expect(material).toContain('— note] FEEDBACK NEEDED: which region?');
    expect(material).toContain('— note] answered FEEDBACK NEEDED inline and shipped');
    expect(material).not.toContain('— WAITING FOR FEEDBACK] FEEDBACK NEEDED: which region?');
  });

  // HS-8795 — channel chatter (permission checks + "Claude finished") is not
  // project work, so it's excluded from the narrated material.
  it('excludes permission-check and "Claude finished" activity events', async () => {
    const db = await getDb();
    await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('trigger','outgoing','Up Next: do the thing','', $1)`, [NEW]);
    await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('permission_request','incoming','Permission: Bash — allowed','', $1)`, [NEW]);
    await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('done','incoming','Claude finished','', $1)`, [NEW]);

    const { material, count } = await collectWorkSignals(CURSOR);
    expect(material).toContain('Up Next: do the thing'); // trigger kept
    expect(material).not.toContain('Permission: Bash');   // permission filtered
    expect(material).not.toContain('Claude finished');     // done filtered
    expect(count).toBe(1);
  });

  // HS-8789 — live mode merges the §67 telemetry stream as a mid-task source.
  it('merges telemetry signals only when includeTelemetry + projectSecret are set', async () => {
    // HS-9286 — `collectTelemetrySignals` reads the day-partitioned events JSONL
    // (`<dataDir>/telemetry/otel-events-*.jsonl`) now, not raw `otel_events`; seed
    // there. `sec-x` is registered against the test dir, so the reader resolves to
    // `telemetryClusterDataDir(getDataDir())`.
    const dir = telemetryClusterDataDir(getDataDir());
    const clearEvents = (): void => {
      try { for (const f of readdirSync(dir)) if (f.startsWith('otel-events-')) rmSync(join(dir, f), { force: true }); }
      catch { /* dir not created yet */ }
    };
    clearEvents();
    await appendOtelJsonl(dir, 'events', new Date(NEW), {
      ts: new Date(NEW).toISOString(), project_secret: 'sec-x', session_id: 's',
      prompt_id: 'p', event_name: 'user_prompt', attributes_json: {}, body_json: { prompt: 'wiring the live loop' },
    });

    const withTel = await collectWorkSignals(CURSOR, { projectSecret: 'sec-x', includeTelemetry: true });
    expect(withTel.material).toContain('[in progress]');
    expect(withTel.material).toContain('wiring the live loop');

    // Default (after-the-fact) path does not touch telemetry.
    const without = await collectWorkSignals(CURSOR);
    expect(without.material).not.toContain('[in progress]');
    clearEvents();
  });

  it('returns empty material when nothing matches the cursor', async () => {
    await seed();
    const { material, count } = await collectWorkSignals('2027-01-01T00:00:00.000Z');
    expect(material).toBe('');
    expect(count).toBe(0);
  });

  // HS-9289 — a trailing claim-reclaim system note must not mask WAITING FOR
  // FEEDBACK, and the system note itself is not narrated (status churn).
  it('a trailing claim-reclaim note neither masks pending feedback nor is narrated', async () => {
    const db = await getDb();
    const t = await createTicket('Paused on a question');
    const notes = JSON.stringify([
      { id: 'q', text: 'FEEDBACK NEEDED: which option?', created_at: NEW },
      { id: 'sys', text: buildClaimReclaimNote('owner'), created_at: '2026-06-05T14:01:00.000Z' },
    ]);
    await db.query(`UPDATE tickets SET notes = $1, status = 'started', updated_at = $2 WHERE id = $3`, [notes, '2026-06-05T14:01:00.000Z', t.id]);
    const { material } = await collectWorkSignals(CURSOR);
    expect(material).toContain('WAITING FOR FEEDBACK');
    expect(material).toContain('which option?');
    expect(material).not.toContain('Claim lease expired'); // system note not narrated
  });

  it('bounds the assembled material so a long-history project never blows the token limit (HS-8752)', async () => {
    const db = await getDb();
    // A single ticket carrying a note far larger than the whole budget — the
    // real-world shape that produced the 1.67M-token 400 on a from-scratch
    // generate. (One giant note ⇒ one giant signal line.)
    const t = await createTicket('Huge history');
    const giant = 'word '.repeat(Math.ceil(MAX_MATERIAL_CHARS / 5) + 1000); // > budget
    const notes = JSON.stringify([{ id: 'big', text: giant, created_at: NEW }]);
    await db.query(`UPDATE tickets SET notes = $1, updated_at = $2 WHERE id = $3`, [notes, NEW, t.id]);

    const { material, count } = await collectWorkSignals(null);
    expect(count).toBe(1);
    // The whole point: the payload sent to the summarizer fits the budget.
    expect(material.length).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    // A single over-budget line is tail-truncated, so we still narrate something.
    expect(material.length).toBeGreaterThan(0);
  });
});

describe('capMaterial (HS-8752)', () => {
  it('returns the full join unchanged when under budget', () => {
    expect(capMaterial(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('keeps the newest lines and drops the oldest when over budget', () => {
    // 30 lines × 100k chars = 3M chars, well over the 1.8M budget. Each line is
    // uniquely tagged so we can see which survived.
    const block = 'x'.repeat(100_000);
    const texts = Array.from({ length: 30 }, (_, i) => `LINE_${i} ${block}`);

    const out = capMaterial(texts);
    expect(out.length).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    // The oldest line is gone; the newest is kept; an elision marker is prepended.
    expect(out).toContain('older work omitted');
    expect(out).toContain('LINE_29');
    expect(out).not.toContain('LINE_0 '); // trailing space avoids matching LINE_29's prefix-free token
  });

  it('tail-truncates a single line larger than the whole budget', () => {
    const huge = 'y'.repeat(MAX_MATERIAL_CHARS * 2);
    const out = capMaterial([huge]);
    expect(out.length).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    expect(out).toContain('older work omitted');
    expect(out.length).toBeGreaterThan(0);
  });
});
