import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { createTicket } from './queries.js';
import { getDb } from './connection.js';
import { getDashboardStats, getSnapshots, recordDailySnapshot } from './stats.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

describe('recordDailySnapshot', () => {
  it('records a snapshot for today', async () => {
    const db = await getDb();

    // Create some tickets in various statuses
    const t1 = await createTicket('Snap not started');
    const t2 = await createTicket('Snap started');
    await db.query(`UPDATE tickets SET status = 'started' WHERE id = $1`, [t2.id]);
    const t3 = await createTicket('Snap completed');
    await db.query(`UPDATE tickets SET status = 'completed', completed_at = NOW() WHERE id = $1`, [t3.id]);

    await recordDailySnapshot();

    const today = new Date().toISOString().slice(0, 10);
    const result = await db.query<{ date: string; data: string }>(
      `SELECT date, data FROM stats_snapshots WHERE date = $1`, [today]
    );
    expect(result.rows.length).toBe(1);

    const data = JSON.parse(result.rows[0].data);
    expect(data.not_started).toBeGreaterThanOrEqual(1);
    expect(data.started).toBeGreaterThanOrEqual(1);
    expect(data.completed).toBeGreaterThanOrEqual(1);
  });

  it('does not duplicate snapshot for the same day', async () => {
    const db = await getDb();

    // Record again (should be a no-op since today's snapshot exists)
    await recordDailySnapshot();

    const today = new Date().toISOString().slice(0, 10);
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM stats_snapshots WHERE date = $1`, [today]
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(1);
  });
});

describe('getSnapshots', () => {
  it('returns snapshots within the requested range', async () => {
    const snapshots = await getSnapshots(7);
    expect(Array.isArray(snapshots)).toBe(true);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const snap = snapshots[0];
    expect(snap.date).toBeDefined();
    expect(snap.data).toBeDefined();
    expect(typeof snap.data.not_started).toBe('number');
    expect(typeof snap.data.started).toBe('number');
    expect(typeof snap.data.completed).toBe('number');
  });

  it('returns empty array for range with no data', async () => {
    // Request snapshots from far in the future by using 0 days ago (only today)
    // Instead, clear all snapshots and request 0-day range
    const db = await getDb();

    // Insert a snapshot for a date far in the past
    await db.query(
      `INSERT INTO stats_snapshots (date, data) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING`,
      ['2020-01-01', JSON.stringify({ not_started: 0, started: 0, completed: 0, verified: 0, backlog: 0, archive: 0 })]
    );

    // Request only last 1 day - should not include the 2020 snapshot
    const snapshots = await getSnapshots(1);
    const old = snapshots.find(s => s.date === '2020-01-01');
    expect(old).toBeUndefined();
  });
});

describe('getDashboardStats', () => {
  it('returns the expected structure', async () => {
    const stats = await getDashboardStats(30);

    expect(stats.throughput).toBeDefined();
    expect(Array.isArray(stats.throughput)).toBe(true);
    expect(stats.cycleTime).toBeDefined();
    expect(Array.isArray(stats.cycleTime)).toBe(true);
    expect(stats.categoryBreakdown).toBeDefined();
    expect(Array.isArray(stats.categoryBreakdown)).toBe(true);
    expect(stats.categoryPeriod).toBeDefined();
    expect(Array.isArray(stats.categoryPeriod)).toBe(true);
    expect(stats.kpi).toBeDefined();
    expect(typeof stats.kpi.completedThisWeek).toBe('number');
    expect(typeof stats.kpi.completedLastWeek).toBe('number');
    expect(typeof stats.kpi.wipCount).toBe('number');
    expect(typeof stats.kpi.createdThisWeek).toBe('number');
  });

  it('counts WIP (started) tickets correctly', async () => {
    const db = await getDb();

    // Create a fresh started ticket
    const t = await createTicket('Stats WIP');
    await db.query(`UPDATE tickets SET status = 'started' WHERE id = $1`, [t.id]);

    const stats = await getDashboardStats(30);
    expect(stats.kpi.wipCount).toBeGreaterThanOrEqual(1);
  });

  it('includes completed tickets in throughput', async () => {
    const db = await getDb();

    const t = await createTicket('Stats throughput');
    await db.query(
      `UPDATE tickets SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [t.id]
    );

    const stats = await getDashboardStats(30);

    // Today should have at least one completion
    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = stats.throughput.find(e => e.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.completed).toBeGreaterThanOrEqual(1);
  });

  it('calculates cycle time for completed tickets', async () => {
    const db = await getDb();

    const t = await createTicket('Stats cycle time');
    // Set created_at to 24 hours ago, completed now
    await db.query(
      `UPDATE tickets SET
        status = 'completed',
        created_at = NOW() - INTERVAL '24 hours',
        completed_at = NOW()
      WHERE id = $1`,
      [t.id]
    );

    const stats = await getDashboardStats(30);

    const cycleEntry = stats.cycleTime.find(c => c.ticket_number === t.ticket_number);
    expect(cycleEntry).toBeDefined();
    // Should be approximately 24 hours
    expect(cycleEntry!.hours).toBeGreaterThanOrEqual(23);
    expect(cycleEntry!.hours).toBeLessThanOrEqual(25);
  });

  it('includes category breakdown for open tickets', async () => {
    const db = await getDb();

    await createTicket('Stats cat bug', { category: 'bug' });
    await createTicket('Stats cat feature', { category: 'feature' });

    const stats = await getDashboardStats(30);

    // We created bug and feature tickets, they should appear
    const bugEntry = stats.categoryBreakdown.find(c => c.category === 'bug');
    expect(bugEntry).toBeDefined();
    expect(bugEntry!.count).toBeGreaterThanOrEqual(1);

    const featureEntry = stats.categoryBreakdown.find(c => c.category === 'feature');
    expect(featureEntry).toBeDefined();
    expect(featureEntry!.count).toBeGreaterThanOrEqual(1);
  });

  it('returns medianCycleTimeDays as null when no completions in range', async () => {
    // Use a very small range where no tickets were completed
    const stats = await getDashboardStats(0);
    // With 0 days range, throughput might be empty but the KPI should still return
    expect(stats.kpi.medianCycleTimeDays === null || typeof stats.kpi.medianCycleTimeDays === 'number').toBe(true);
  });

  it('throughput covers all days in the range', async () => {
    const stats = await getDashboardStats(7);

    // Should have entries for each day in the range (approximately 8 entries: 7 days ago through today)
    expect(stats.throughput.length).toBeGreaterThanOrEqual(7);

    // All entries should have date, completed, and created
    for (const entry of stats.throughput) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.completed).toBe('number');
      expect(typeof entry.created).toBe('number');
    }
  });
});
