import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../db/connection.js';
import { createTicket } from '../db/tickets.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { collectWorkSignals } from './collectSignals.js';

let tempDir: string;
const OLD = '2026-06-05T10:00:00.000Z';
const CURSOR = '2026-06-05T12:00:00.000Z';
const NEW = '2026-06-05T14:00:00.000Z';

beforeAll(async () => { tempDir = await setupTestDb(); });
afterAll(async () => { await cleanupTestDb(tempDir); });

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
  await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('done','incoming','old activity','', $1)`, [OLD]);
  await db.query(`INSERT INTO command_log (event_type, direction, summary, detail, created_at) VALUES ('done','incoming','new activity','', $1)`, [NEW]);
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

  it('returns empty material when nothing matches the cursor', async () => {
    await seed();
    const { material, count } = await collectWorkSignals('2027-01-01T00:00:00.000Z');
    expect(material).toBe('');
    expect(count).toBe(0);
  });
});
