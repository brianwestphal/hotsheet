import { getDb } from './connection.js';

export interface CommandLogEntry {
  id: number;
  event_type: string;
  direction: string;
  summary: string;
  detail: string;
  created_at: string;
}

export async function addLogEntry(
  eventType: string,
  direction: string,
  summary: string,
  detail: string,
): Promise<CommandLogEntry> {
  const db = await getDb();
  const result = await db.query<CommandLogEntry>(
    `INSERT INTO command_log (event_type, direction, summary, detail) VALUES ($1, $2, $3, $4) RETURNING *`,
    [eventType, direction, summary, detail],
  );
  return result.rows[0];
}

export async function getLogEntries(options?: {
  limit?: number;
  offset?: number;
  eventType?: string;
  search?: string;
}): Promise<CommandLogEntry[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (options?.eventType !== undefined && options.eventType !== '') {
    conditions.push(`event_type = $${paramIdx++}`);
    params.push(options.eventType);
  }
  if (options?.search !== undefined && options.search !== '') {
    conditions.push(`(summary ILIKE $${paramIdx} OR detail ILIKE $${paramIdx})`);
    params.push(`%${options.search}%`);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const result = await db.query<CommandLogEntry>(
    `SELECT id, event_type, direction, summary, detail, created_at
     FROM command_log ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...params, limit, offset],
  );
  return result.rows;
}

export async function getLogCount(options?: {
  eventType?: string;
  search?: string;
}): Promise<number> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: string[] = [];
  let paramIdx = 1;

  if (options?.eventType !== undefined && options.eventType !== '') {
    conditions.push(`event_type = $${paramIdx++}`);
    params.push(options.eventType);
  }
  if (options?.search !== undefined && options.search !== '') {
    conditions.push(`(summary ILIKE $${paramIdx} OR detail ILIKE $${paramIdx})`);
    params.push(`%${options.search}%`);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM command_log ${where}`,
    params,
  );
  return parseInt(result.rows[0].count, 10);
}

export async function updateLogEntry(
  id: number,
  updates: { summary?: string; detail?: string },
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (updates.summary !== undefined) {
    sets.push(`summary = $${paramIdx++}`);
    params.push(updates.summary);
  }
  if (updates.detail !== undefined) {
    sets.push(`detail = $${paramIdx++}`);
    params.push(updates.detail);
  }
  if (sets.length === 0) return;
  params.push(id);
  await db.query(`UPDATE command_log SET ${sets.join(', ')} WHERE id = $${paramIdx}`, params);
}

export async function clearLog(): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM command_log`);
}

export async function pruneLog(maxEntries = 1000): Promise<void> {
  const db = await getDb();
  await db.query(
    `DELETE FROM command_log WHERE id NOT IN (
      SELECT id FROM command_log ORDER BY created_at DESC, id DESC LIMIT $1
    )`,
    [maxEntries],
  );
}
