// HS-8865 — flat `blocked_by` dependency gate (docs/90 §90.6).
//
// A peer dependency edge between flat tickets: ticket A `blocks_on` ticket B means
// A can't be claimed/worked until B is completed/verified. This is a scheduling
// gate, NOT a parent/child tree — hierarchical sub-tasks were tried and reverted
// 2026-03-23. claim-next (`claims.ts`) excludes blocked tickets via
// `BLOCKED_TICKET_IDS_SQL` so parallel workers don't grab a dependent early.
import { getDb } from './connection.js';

/** Statuses that count as "done" — a blocker in one of these no longer blocks. */
const DONE_STATUSES = `('completed','verified')`;

/** A subquery returning the ids of every ticket currently blocked (it has at
 *  least one `blocks_on` ticket that is not yet done). Inlined into claim-next. */
export const BLOCKED_TICKET_IDS_SQL = `
  SELECT DISTINCT bb.ticket_id
    FROM ticket_blocked_by bb
    JOIN tickets bt ON bt.id = bb.blocks_on_ticket_id
   WHERE bt.status NOT IN ${DONE_STATUSES}
`;

/** The ticket ids `ticketId` is waiting on (its blockers), in id order. */
export async function getBlockedBy(ticketId: number): Promise<number[]> {
  const db = await getDb();
  const result = await db.query<{ blocks_on_ticket_id: number }>(
    'SELECT blocks_on_ticket_id FROM ticket_blocked_by WHERE ticket_id = $1 ORDER BY blocks_on_ticket_id',
    [ticketId],
  );
  return result.rows.map(r => r.blocks_on_ticket_id);
}

/** Is `ticketId` currently blocked (any blocker not yet done)? */
export async function isBlocked(ticketId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM ticket_blocked_by bb JOIN tickets bt ON bt.id = bb.blocks_on_ticket_id
      WHERE bb.ticket_id = $1 AND bt.status NOT IN ${DONE_STATUSES}`,
    [ticketId],
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

export type SetBlockedByResult =
  | { ok: true; blockedBy: number[] }
  | { ok: false; reason: 'self' | 'cycle' | 'unknown_ticket' };

/**
 * Replace `ticketId`'s blocker set with `blockerIds` (deduped). Rejects a
 * self-block, a non-existent blocker, and any edge that would create a cycle in
 * the dependency graph (so the gate can never deadlock). Returns the stored set
 * on success.
 */
export async function setBlockedBy(ticketId: number, blockerIds: number[]): Promise<SetBlockedByResult> {
  const db = await getDb();
  if (blockerIds.includes(ticketId)) return { ok: false, reason: 'self' };
  const unique = [...new Set(blockerIds)];

  // All blockers must exist (and not be deleted).
  if (unique.length > 0) {
    const found = await db.query<{ id: number }>(
      `SELECT id FROM tickets WHERE id = ANY($1::int[]) AND status != 'deleted'`,
      [unique],
    );
    if (found.rows.length !== unique.length) return { ok: false, reason: 'unknown_ticket' };
  }

  // Cycle check: adding ticketId → blocker for each blocker must not let any
  // blocker transitively reach back to ticketId.
  for (const blocker of unique) {
    if (await dependsOn(blocker, ticketId)) return { ok: false, reason: 'cycle' };
  }

  // Replace the set atomically (delete-then-insert; the table is tiny per ticket).
  await db.query('DELETE FROM ticket_blocked_by WHERE ticket_id = $1', [ticketId]);
  for (const blocker of unique) {
    await db.query(
      'INSERT INTO ticket_blocked_by (ticket_id, blocks_on_ticket_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [ticketId, blocker],
    );
  }
  return { ok: true, blockedBy: unique.sort((a, b) => a - b) };
}

/** Does `fromId` transitively block_on `targetId`? (walks the blocked_by graph). */
async function dependsOn(fromId: number, targetId: number): Promise<boolean> {
  const db = await getDb();
  const seen = new Set<number>();
  const stack = [fromId];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    if (cur === targetId) return true;
    const next = await db.query<{ blocks_on_ticket_id: number }>(
      'SELECT blocks_on_ticket_id FROM ticket_blocked_by WHERE ticket_id = $1',
      [cur],
    );
    for (const row of next.rows) stack.push(row.blocks_on_ticket_id);
  }
  return false;
}

/** Bulk-load the blocker lists for many tickets at once (for list/detail badges).
 *  Returns a map of ticket_id → blocker ids (only entries with ≥1 blocker). */
export async function getBlockedByMap(ticketIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (ticketIds.length === 0) return map;
  const db = await getDb();
  const result = await db.query<{ ticket_id: number; blocks_on_ticket_id: number }>(
    `SELECT ticket_id, blocks_on_ticket_id FROM ticket_blocked_by
      WHERE ticket_id = ANY($1::int[]) ORDER BY ticket_id, blocks_on_ticket_id`,
    [ticketIds],
  );
  for (const row of result.rows) {
    const list = map.get(row.ticket_id) ?? [];
    list.push(row.blocks_on_ticket_id);
    map.set(row.ticket_id, list);
  }
  return map;
}
