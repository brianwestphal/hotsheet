/**
 * HS-8766 — announcer_usage CRUD + rollups. Uses a real temp DB (the shared
 * telemetry DB resolves to it via `defaultDbPath`).
 */
import { rmSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { announcerCost } from '../announcer/models.js';
import { registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import {
  getAnnouncerUsageByProject, getAnnouncerUsageTotals, recordAnnouncerUsage,
} from './announcerUsage.js';
import { centralTelemetryDataDir, closeDbForDir, getDb, getTelemetryDb } from './connection.js';

let tempDir: string;
// HS-8874 — `recordAnnouncerUsage` for an UNregistered secret falls back to the
// central store; isolate it to a temp dir so it isn't created in the developer's
// real `~/.hotsheet/telemetry` (see otelWriters.test.ts).
let centralOverrideDir: string;

beforeAll(async () => {
  centralOverrideDir = createTempDir();
  process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir;
  tempDir = await setupTestDb();
  // HS-8874 — `recordAnnouncerUsage` routes to the writing project's OWN DB via
  // `getProjectBySecret(secret).dataDir`. Register pA against the test DB so its
  // writes land there (and reads, via `defaultDbPath`, agree).
  registerExistingProject(tempDir, 'pA', await getDb());
});
afterAll(async () => {
  unregisterProject('pA');
  await cleanupTestDb(tempDir);
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});
beforeEach(async () => { await (await getTelemetryDb()).query('DELETE FROM announcer_usage'); });

/** Insert an announcer_usage row directly into the (default test) telemetry DB.
 *  Used by the cross-project group-by test, which needs rows for an unregistered
 *  second project (pB) co-located in ONE DB so the ambient read sees both —
 *  `recordAnnouncerUsage` would otherwise route pB to the central store. */
async function insertUsageDirect(secret: string, model: string, inputTokens: number, outputTokens: number): Promise<void> {
  const cost = announcerCost(model, inputTokens, outputTokens);
  const db = await getTelemetryDb();
  await db.query(
    `INSERT INTO announcer_usage (project_secret, model, input_tokens, output_tokens, cost) VALUES ($1, $2, $3, $4, $5)`,
    [secret, model, inputTokens, outputTokens, cost],
  );
}

describe('announcer_usage (HS-8766)', () => {
  it('records usage with a derived cost and rolls up per project', async () => {
    await recordAnnouncerUsage({ projectSecret: 'pA', model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 200 });
    await recordAnnouncerUsage({ projectSecret: 'pA', model: 'claude-haiku-4-5', inputTokens: 500, outputTokens: 100 });
    await recordAnnouncerUsage({ projectSecret: 'pB', model: 'claude-opus-4-8', inputTokens: 2000, outputTokens: 400 });

    const a = await getAnnouncerUsageTotals('pA', null);
    expect(a.generations).toBe(2);
    expect(a.inputTokens).toBe(1500);
    expect(a.outputTokens).toBe(300);
    expect(a.cost).toBeCloseTo(
      announcerCost('claude-haiku-4-5', 1000, 200) + announcerCost('claude-haiku-4-5', 500, 100), 6,
    );
  });

  it('groups by project, scoped to allowedSecrets, ordered by cost desc', async () => {
    // Co-locate pA + pB in the same DB so the ambient cross-project read sees
    // both (pB isn't a registered project, so `recordAnnouncerUsage` would route
    // it to central). See `insertUsageDirect`.
    await insertUsageDirect('pA', 'claude-haiku-4-5', 1000, 200);
    await insertUsageDirect('pB', 'claude-opus-4-8', 2000, 400);

    const all = await getAnnouncerUsageByProject(null, null);
    expect(all.map(r => r.projectSecret)).toEqual(['pB', 'pA']); // pB (opus) costs more

    const scoped = await getAnnouncerUsageByProject(['pA'], null);
    expect(scoped.map(r => r.projectSecret)).toEqual(['pA']);

    expect(await getAnnouncerUsageByProject([], null)).toEqual([]);
  });

  it('the since filter excludes older rows', async () => {
    await recordAnnouncerUsage({ projectSecret: 'pA', model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 200 });
    const future = new Date(Date.now() + 60_000);
    const totals = await getAnnouncerUsageTotals('pA', future);
    expect(totals.generations).toBe(0);
    expect(totals.cost).toBe(0);
  });
});
