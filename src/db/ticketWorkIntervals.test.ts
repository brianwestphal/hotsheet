/**
 * HS-8730 — unit coverage for ticket work-interval bookkeeping (the time-window
 * source for per-ticket cost attribution).
 */
import { rmSync } from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getProjectBySecret, registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDb, getDbForDir, getTelemetryDb, runWithTelemetryDb } from './connection.js';
import { closeOpenTicketIntervalsForProject, recordTicketWorkTransition } from './ticketWorkIntervals.js';

const SECRET = 'secret-twi';
const OTHER_SECRET = 'other-secret';

// HS-8875 — work intervals are now written to the OWNING project's DB (resolved
// from the secret), so both secrets are registered to distinct DBs and reads go
// through each secret's own DB. The central fallback (for any unregistered
// secret) is isolated to a temp dir.
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

let tempDir: string;
let otherDir: string;
beforeEach(async () => {
  tempDir = await setupTestDb();
  registerExistingProject(tempDir, SECRET, await getDb());
  otherDir = createTempDir();
  registerExistingProject(otherDir, OTHER_SECRET, await getDbForDir(otherDir));
});
afterEach(async () => {
  unregisterProject(SECRET);
  unregisterProject(OTHER_SECRET);
  await closeDbForDir(otherDir);
  rmSync(otherDir, { recursive: true, force: true });
  await cleanupTestDb(tempDir);
});

// HS-8875 — reads resolve each secret's OWN project DB (per-project storage).
async function intervals(secret: string, ticket: string): Promise<{ open: number; closed: number }> {
  const dir = getProjectBySecret(secret)?.dataDir ?? centralTelemetryDataDir();
  return runWithTelemetryDb(dir, async () => {
    const db = await getTelemetryDb();
    const r = await db.query<{ ended_at: string | null }>(
      `SELECT ended_at FROM ticket_work_intervals WHERE project_secret = $1 AND ticket_number = $2`,
      [secret, ticket],
    );
    return {
      open: r.rows.filter(row => row.ended_at === null).length,
      closed: r.rows.filter(row => row.ended_at !== null).length,
    };
  });
}

describe('recordTicketWorkTransition', () => {
  it('opens an interval on → started', async () => {
    await recordTicketWorkTransition(SECRET, 'HS-1', 'started');
    expect(await intervals(SECRET, 'HS-1')).toEqual({ open: 1, closed: 0 });
  });

  it('a second → started supersedes the first (closes the stale one, opens a fresh one)', async () => {
    await recordTicketWorkTransition(SECRET, 'HS-1', 'started');
    await recordTicketWorkTransition(SECRET, 'HS-1', 'started');
    expect(await intervals(SECRET, 'HS-1')).toEqual({ open: 1, closed: 1 });
  });

  it('closes the open interval when leaving started (→ completed)', async () => {
    await recordTicketWorkTransition(SECRET, 'HS-1', 'started');
    await recordTicketWorkTransition(SECRET, 'HS-1', 'completed');
    expect(await intervals(SECRET, 'HS-1')).toEqual({ open: 0, closed: 1 });
  });

  it('→ not_started / backlog / archive all close (do not open) an interval', async () => {
    await recordTicketWorkTransition(SECRET, 'HS-2', 'started');
    await recordTicketWorkTransition(SECRET, 'HS-2', 'backlog');
    expect(await intervals(SECRET, 'HS-2')).toEqual({ open: 0, closed: 1 });
    // A close with no open interval is a harmless no-op.
    await recordTicketWorkTransition(SECRET, 'HS-2', 'not_started');
    expect(await intervals(SECRET, 'HS-2')).toEqual({ open: 0, closed: 1 });
  });

  it('is a no-op for an empty secret', async () => {
    await recordTicketWorkTransition('', 'HS-3', 'started');
    const db = await getTelemetryDb();
    const r = await db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM ticket_work_intervals`);
    expect(Number(r.rows[0].n)).toBe(0);
  });
});

describe('closeOpenTicketIntervalsForProject', () => {
  it('closes every open interval for the project (bounds attribution at channel done)', async () => {
    await recordTicketWorkTransition(SECRET, 'HS-10', 'started');
    await recordTicketWorkTransition(SECRET, 'HS-11', 'started');
    expect((await intervals(SECRET, 'HS-10')).open).toBe(1);
    expect((await intervals(SECRET, 'HS-11')).open).toBe(1);

    await closeOpenTicketIntervalsForProject(SECRET);
    expect(await intervals(SECRET, 'HS-10')).toEqual({ open: 0, closed: 1 });
    expect(await intervals(SECRET, 'HS-11')).toEqual({ open: 0, closed: 1 });
  });

  it('only closes the given project\'s intervals', async () => {
    await recordTicketWorkTransition(SECRET, 'HS-20', 'started');
    await recordTicketWorkTransition(OTHER_SECRET, 'HS-20', 'started');
    await closeOpenTicketIntervalsForProject(SECRET);
    expect((await intervals(SECRET, 'HS-20')).open).toBe(0);
    expect((await intervals(OTHER_SECRET, 'HS-20')).open).toBe(1);
  });
});
