// HS-8862 — distributed-execution claim/lease primitive (docs/90 §90.2-90.3).
//
// The atomic "ticket checkout" workers use to drain the Up Next pool in parallel
// without double-claiming. Orthogonal to status/up_next: a claim sets claimed_by +
// a lease and never changes status, so an unclaimed ticket behaves exactly as
// today. Atomicity is via `SELECT … FOR UPDATE SKIP LOCKED` (correct under real
// concurrent Postgres; a no-op-but-safe serialization under single-connection
// PGLite where the single UPDATE … RETURNING already prevents double-claim).
import type { Ticket } from '../schemas.js';
import { BLOCKED_TICKET_IDS_SQL } from './blockedBy.js';
import { getDb } from './connection.js';
import { updateTicket } from './tickets.js';

/** Default lease TTL in seconds (docs/90 §90.2.2). */
export const DEFAULT_CLAIM_TTL_SECONDS = 120;

/** Mirrors `PRIORITY_ORD` in `tickets.ts` so claim-next picks the same "top of
 *  Up Next" ticket the worklist shows (highest→lowest = 1→5). */
const PRIORITY_ORD = `CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'default' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 3 END`;

/** Statuses a worker should never claim (terminal / not actionable). */
const CLAIMABLE_STATUS_EXCLUDE = `('completed','verified','deleted','archive')`;

export interface ClaimRow {
  ticketId: number;
  ticketNumber: string;
  title: string;
  claimedBy: string;
  workerLabel: string | null;
  leaseExpiresAt: string;
}

/** Atomically claim the top claimable Up Next ticket for `worker`, or null when
 *  nothing is claimable. "Claimable" = up_next, actionable status, not blocked by
 *  an unfinished dependency (HS-8865), and either unclaimed or its lease has
 *  expired. */
export async function claimNext(
  worker: string,
  label: string | null,
  ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
): Promise<Ticket | null> {
  const db = await getDb();
  const result = await db.query<Ticket>(
    `WITH next AS (
       SELECT id FROM tickets
        WHERE up_next = TRUE
          AND status NOT IN ${CLAIMABLE_STATUS_EXCLUDE}
          AND (claimed_by IS NULL OR claim_lease_expires_at < NOW())
          AND id NOT IN (${BLOCKED_TICKET_IDS_SQL})
        ORDER BY ${PRIORITY_ORD} ASC, id DESC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE tickets t
        SET claimed_by = $1,
            worker_label = $2,
            claim_lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
            claim_count = claim_count + 1
       FROM next
      WHERE t.id = next.id
     RETURNING t.*`,
    [worker, label, ttlSeconds],
  );
  return result.rows[0] ?? null;
}

export type ClaimByIdResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; claimedBy: string; workerLabel: string | null };

/** Claim a specific ticket for `worker` (used by coordinator-dispatch, §90.5.2).
 *  Succeeds when the ticket is unclaimed, its lease expired, or it is already
 *  held by `worker` (idempotent re-claim / lease bump). Returns a conflict when a
 *  live lease is held by a different worker. */
export async function claimById(
  id: number,
  worker: string,
  label: string | null,
  ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
): Promise<ClaimByIdResult> {
  const db = await getDb();
  const result = await db.query<Ticket>(
    `UPDATE tickets
        SET claimed_by = $2,
            worker_label = $3,
            claim_lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
            claim_count = claim_count + 1
      WHERE id = $1
        AND status NOT IN ${CLAIMABLE_STATUS_EXCLUDE}
        AND (claimed_by IS NULL OR claim_lease_expires_at < NOW() OR claimed_by = $2)
     RETURNING *`,
    [id, worker, label, ttlSeconds],
  );
  if (result.rows.length > 0) return { ok: true, ticket: result.rows[0] };

  // Distinguish "no such (claimable) ticket" from "held by someone else".
  const cur = await db.query<{ claimed_by: string | null; worker_label: string | null; lease_live: boolean }>(
    `SELECT claimed_by, worker_label, (claim_lease_expires_at >= NOW()) AS lease_live
       FROM tickets WHERE id = $1 AND status NOT IN ${CLAIMABLE_STATUS_EXCLUDE}`,
    [id],
  );
  if (cur.rows.length > 0 && cur.rows[0].claimed_by != null && cur.rows[0].lease_live) {
    return { ok: false, reason: 'conflict', claimedBy: cur.rows[0].claimed_by, workerLabel: cur.rows[0].worker_label };
  }
  return { ok: false, reason: 'not_found' };
}

/** Extend the lease — a worker heartbeat. Succeeds only while `worker` still
 *  holds a live lease; a false return means the claim lapsed/was reclaimed and
 *  the worker should re-claim. */
export async function renewLease(
  id: number,
  worker: string,
  ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
): Promise<{ ok: boolean; leaseExpiresAt?: string }> {
  const db = await getDb();
  const result = await db.query<{ claim_lease_expires_at: string }>(
    `UPDATE tickets
        SET claim_lease_expires_at = NOW() + ($2 * INTERVAL '1 second')
      WHERE id = $1 AND claimed_by = $3 AND claim_lease_expires_at >= NOW()
     RETURNING claim_lease_expires_at`,
    [id, ttlSeconds, worker],
  );
  return result.rows.length > 0
    ? { ok: true, leaseExpiresAt: result.rows[0].claim_lease_expires_at }
    : { ok: false };
}

/** Drop a claim. Idempotent. When `worker` is given, only releases a claim that
 *  worker holds (so one worker can't release another's); omit `worker` to
 *  force-release (owner action). */
export async function release(id: number, worker?: string): Promise<{ ok: boolean }> {
  const db = await getDb();
  const where = worker != null && worker !== ''
    ? { clause: 'id = $1 AND claimed_by = $2', params: [id, worker] as (number | string)[] }
    : { clause: 'id = $1', params: [id] as (number | string)[] };
  await db.query(
    `UPDATE tickets
        SET claimed_by = NULL, claim_lease_expires_at = NULL, worker_label = NULL
      WHERE ${where.clause}`,
    where.params,
  );
  return { ok: true };
}

/** Currently-claimed tickets with a live lease (for the claimed-by / pool UI). */
export async function getClaims(): Promise<ClaimRow[]> {
  const db = await getDb();
  const result = await db.query<{
    id: number; ticket_number: string; title: string;
    claimed_by: string; worker_label: string | null; claim_lease_expires_at: string;
  }>(
    `SELECT id, ticket_number, title, claimed_by, worker_label, claim_lease_expires_at
       FROM tickets
      WHERE claimed_by IS NOT NULL AND claim_lease_expires_at >= NOW()
      ORDER BY claim_lease_expires_at ASC`,
  );
  return result.rows.map(r => ({
    ticketId: r.id,
    ticketNumber: r.ticket_number,
    title: r.title,
    claimedBy: r.claimed_by,
    workerLabel: r.worker_label,
    leaseExpiresAt: r.claim_lease_expires_at,
  }));
}

/** Reclaim every ticket whose lease has lapsed (a worker died): clear the claim
 *  and append a note so the maintainer sees it. `status` is left untouched
 *  (docs/90 §90.2.2 — don't clobber real progress). Returns the count reclaimed.
 *  Lazy reclaim in claimNext/claimById already makes these claimable; this just
 *  surfaces + frees them. */
export async function sweepExpiredClaims(): Promise<number> {
  const db = await getDb();
  const expired = await db.query<{ id: number; worker_label: string | null; claimed_by: string }>(
    `UPDATE tickets
        SET claimed_by = NULL, claim_lease_expires_at = NULL, worker_label = NULL
      WHERE claimed_by IS NOT NULL AND claim_lease_expires_at < NOW()
     RETURNING id, worker_label, claimed_by`,
  );
  for (const row of expired.rows) {
    const who = row.worker_label != null && row.worker_label !== '' ? row.worker_label : row.claimed_by;
    await updateTicket(row.id, { notes: `Claim lease expired — reclaimed from \`${who}\`.` });
  }
  return expired.rows.length;
}
