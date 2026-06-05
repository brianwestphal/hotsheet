/**
 * HS-8766 — announcer_usage CRUD + rollups. Uses a real temp DB (the shared
 * telemetry DB resolves to it via `defaultDbPath`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { announcerCost } from '../announcer/models.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import {
  getAnnouncerUsageByProject, getAnnouncerUsageTotals, recordAnnouncerUsage,
} from './announcerUsage.js';
import { getTelemetryDb } from './connection.js';

let tempDir: string;

beforeAll(async () => { tempDir = await setupTestDb(); });
afterAll(async () => { await cleanupTestDb(tempDir); });
beforeEach(async () => { await (await getTelemetryDb()).query('DELETE FROM announcer_usage'); });

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
    await recordAnnouncerUsage({ projectSecret: 'pA', model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 200 });
    await recordAnnouncerUsage({ projectSecret: 'pB', model: 'claude-opus-4-8', inputTokens: 2000, outputTokens: 400 });

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
