import type { PGlite } from '@electric-sql/pglite';

import { getDb } from './connection.js';

interface SnapshotData {
  not_started: number;
  started: number;
  completed: number;
  verified: number;
  backlog: number;
  archive: number;
}

/** Record today's ticket counts by status. Runs on server start and can be called periodically. */
export async function recordDailySnapshot(): Promise<void> {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Check if we already have today's snapshot
  const existing = await db.query<{ date: string }>(`SELECT date FROM stats_snapshots WHERE date = $1`, [today]);
  if (existing.rows.length > 0) return; // Already recorded today

  const result = await db.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM tickets WHERE status != 'deleted' GROUP BY status`
  );

  const data: SnapshotData = { not_started: 0, started: 0, completed: 0, verified: 0, backlog: 0, archive: 0 };
  for (const row of result.rows) {
    if (row.status in data) {
      data[row.status as keyof SnapshotData] = parseInt(row.count, 10);
    }
  }

  await db.query(
    `INSERT INTO stats_snapshots (date, data) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET data = $2`,
    [today, JSON.stringify(data)]
  );
}

/** Backfill snapshots from ticket history for days we missed. */
export async function backfillSnapshots(): Promise<void> {
  const db = await getDb();

  // Find the earliest ticket creation date
  const earliest = await db.query<{ min_date: string }>(`SELECT MIN(DATE(created_at)) as min_date FROM tickets`);
  if (!earliest.rows[0]?.min_date) return;

  const startDate = new Date(earliest.rows[0].min_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check which dates already have snapshots
  const existingRows = await db.query<{ date: string }>(`SELECT date FROM stats_snapshots`);
  const existingDates = new Set(existingRows.rows.map(r => r.date));

  // For each missing date, compute the snapshot from ticket data
  const current = new Date(startDate);
  while (current <= today) {
    const dateStr = current.toISOString().slice(0, 10);
    if (!existingDates.has(dateStr)) {
      // Compute status counts as of end of this date
      const dateEnd = dateStr + 'T23:59:59.999Z';
      const result = await db.query<{ status: string; count: string }>(`
        SELECT
          CASE
            WHEN verified_at IS NOT NULL AND verified_at <= $1 THEN 'verified'
            WHEN completed_at IS NOT NULL AND completed_at <= $1 THEN 'completed'
            WHEN deleted_at IS NOT NULL AND deleted_at <= $1 THEN 'deleted'
            WHEN status = 'backlog' THEN 'backlog'
            WHEN status = 'archive' THEN 'archive'
            WHEN status = 'started' THEN 'started'
            ELSE 'not_started'
          END as status,
          COUNT(*) as count
        FROM tickets
        WHERE created_at <= $1
        GROUP BY 1
      `, [dateEnd]);

      const data: SnapshotData = { not_started: 0, started: 0, completed: 0, verified: 0, backlog: 0, archive: 0 };
      for (const row of result.rows) {
        if (row.status in data) {
          data[row.status as keyof SnapshotData] = parseInt(row.count, 10);
        }
      }

      await db.query(
        `INSERT INTO stats_snapshots (date, data) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING`,
        [dateStr, JSON.stringify(data)]
      );
    }
    current.setDate(current.getDate() + 1);
  }
}

/** Get snapshots for a date range. */
export async function getSnapshots(days: number): Promise<{ date: string; data: SnapshotData }[]> {
  const db = await getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  const result = await db.query<{ date: string; data: string }>(
    `SELECT date, data FROM stats_snapshots WHERE date >= $1 ORDER BY date ASC`,
    [sinceStr]
  );

  return result.rows.map(r => ({
    date: r.date,
    data: JSON.parse(r.data) as SnapshotData,
  }));
}

async function getThroughputTimeline(db: PGlite, since: Date, sinceStr: string): Promise<{ date: string; completed: number; created: number }[]> {
  const completedByDay = await db.query<{ date: string; count: string }>(
    `SELECT DATE(completed_at) as date, COUNT(*) as count FROM tickets
     WHERE completed_at >= $1 AND completed_at IS NOT NULL
     GROUP BY DATE(completed_at) ORDER BY date ASC`,
    [sinceStr]
  );
  const createdByDay = await db.query<{ date: string; count: string }>(
    `SELECT DATE(created_at) as date, COUNT(*) as count FROM tickets
     WHERE created_at >= $1
     GROUP BY DATE(created_at) ORDER BY date ASC`,
    [sinceStr]
  );

  const dateMap = new Map<string, { completed: number; created: number }>();
  const current = new Date(since);
  const today = new Date();
  while (current <= today) {
    const d = current.toISOString().slice(0, 10);
    dateMap.set(d, { completed: 0, created: 0 });
    current.setDate(current.getDate() + 1);
  }
  for (const r of completedByDay.rows) {
    const d = typeof r.date === 'string' ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10);
    const entry = dateMap.get(d);
    if (entry) entry.completed = parseInt(r.count, 10);
  }
  for (const r of createdByDay.rows) {
    const d = typeof r.date === 'string' ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10);
    const entry = dateMap.get(d);
    if (entry) entry.created = parseInt(r.count, 10);
  }
  return Array.from(dateMap.entries()).map(([date, counts]) => ({ date, ...counts }));
}

async function getCycleTimes(db: PGlite, sinceStr: string): Promise<{ ticket_number: string; title: string; completed_at: string; hours: number }[]> {
  const result = await db.query<{ ticket_number: string; title: string; completed_at: string; created_at: string }>(
    `SELECT ticket_number, title, completed_at, created_at FROM tickets
     WHERE completed_at >= $1 AND completed_at IS NOT NULL AND status IN ('completed', 'verified')
     ORDER BY completed_at ASC`,
    [sinceStr]
  );
  return result.rows.map(r => ({
    ticket_number: r.ticket_number,
    title: r.title,
    completed_at: r.completed_at,
    hours: Math.max(0, (new Date(r.completed_at).getTime() - new Date(r.created_at).getTime()) / 3600000),
  }));
}

async function getCategoryBreakdown(db: PGlite): Promise<{ category: string; count: number }[]> {
  const result = await db.query<{ category: string; count: string }>(
    `SELECT category, COUNT(*) as count FROM tickets
     WHERE status IN ('not_started', 'started')
     GROUP BY category ORDER BY count DESC`
  );
  return result.rows.map(r => ({ category: r.category, count: parseInt(r.count, 10) }));
}

async function getPriorityBreakdown(db: PGlite, sinceStr: string): Promise<{ category: string; count: number }[]> {
  const result = await db.query<{ category: string; count: string }>(
    `SELECT category, COUNT(*) as count FROM tickets
     WHERE status != 'deleted' AND (
       created_at >= $1 OR
       (completed_at IS NOT NULL AND completed_at >= $1) OR
       (verified_at IS NOT NULL AND verified_at >= $1) OR
       updated_at >= $1
     )
     GROUP BY category ORDER BY count DESC`,
    [sinceStr]
  );
  return result.rows.map(r => ({ category: r.category, count: parseInt(r.count, 10) }));
}

async function computeKPIs(db: PGlite, cycleTime: { hours: number }[]): Promise<{
  completedThisWeek: number;
  completedLastWeek: number;
  wipCount: number;
  createdThisWeek: number;
  medianCycleTimeDays: number | null;
}> {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const completedThisWeekR = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE completed_at >= $1`, [weekStart.toISOString()]
  );
  const completedLastWeekR = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE completed_at >= $1 AND completed_at < $2`,
    [lastWeekStart.toISOString(), weekStart.toISOString()]
  );
  const wipR = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE status = 'started'`
  );
  const createdThisWeekR = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE created_at >= $1`, [weekStart.toISOString()]
  );

  const cycleHours = cycleTime.map(c => c.hours).sort((a, b) => a - b);
  const medianCycleTimeDays = cycleHours.length > 0
    ? Math.round(cycleHours[Math.floor(cycleHours.length / 2)] / 24)
    : null;

  return {
    completedThisWeek: parseInt(completedThisWeekR.rows[0].count, 10),
    completedLastWeek: parseInt(completedLastWeekR.rows[0].count, 10),
    wipCount: parseInt(wipR.rows[0].count, 10),
    createdThisWeek: parseInt(createdThisWeekR.rows[0].count, 10),
    medianCycleTimeDays,
  };
}

/** Get dashboard stats (KPIs, throughput, cycle times). */
export async function getDashboardStats(days: number): Promise<{
  throughput: { date: string; completed: number; created: number }[];
  cycleTime: { ticket_number: string; title: string; completed_at: string; hours: number }[];
  categoryBreakdown: { category: string; count: number }[];
  categoryPeriod: { category: string; count: number }[];
  kpi: {
    completedThisWeek: number;
    completedLastWeek: number;
    wipCount: number;
    createdThisWeek: number;
    medianCycleTimeDays: number | null;
  };
}> {
  const db = await getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const throughput = await getThroughputTimeline(db, since, sinceStr);
  const cycleTime = await getCycleTimes(db, sinceStr);
  const categoryBreakdown = await getCategoryBreakdown(db);
  const categoryPeriod = await getPriorityBreakdown(db, sinceStr);
  const kpi = await computeKPIs(db, cycleTime);

  return { throughput, cycleTime, categoryBreakdown, categoryPeriod, kpi };
}
