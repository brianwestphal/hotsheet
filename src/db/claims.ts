// HS-8862 — distributed-execution claim/lease primitive (docs/90 §90.2-90.3).
//
// The atomic "ticket checkout" workers use to drain the Up Next pool in parallel
// without double-claiming. Orthogonal to status/up_next: a claim sets claimed_by +
// a lease and never changes status, so an unclaimed ticket behaves exactly as
// today. Atomicity is via `SELECT … FOR UPDATE SKIP LOCKED` (correct under real
// concurrent Postgres; a no-op-but-safe serialization under single-connection
// PGLite where the single UPDATE … RETURNING already prevents double-claim).
import { parseJsonOrNull, TagsArraySchema,type Ticket } from '../schemas.js';
import { BLOCKED_TICKET_IDS_SQL } from './blockedBy.js';
import { getDb } from './connection.js';
import { updateTicket } from './tickets.js';

/** Default lease TTL in seconds (docs/90 §90.2.2). */
export const DEFAULT_CLAIM_TTL_SECONDS = 120;

/** HS-8970 — poison-ticket dead-letter. A ticket may be claimed at most this many
 *  times without completing; the (MAX+1)-th claim is refused by `claimNext`, and
 *  the lease sweep then quarantines it (drops it from Up Next + a `needs-attention`
 *  tag + a `QUARANTINED:` note) so it stops looping forever and surfaces to the
 *  owner. Transient crashes (a few reclaims that eventually complete) stay well
 *  under this; only a persistently-failing ticket hits it. */
export const MAX_CLAIM_ATTEMPTS = 5;

/** The tag a quarantined ticket is marked with (HS-8970). */
export const QUARANTINE_TAG = 'needs-attention';

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

/** Atomically claim the top claimable ticket for `worker`, or null when nothing is
 *  claimable. Two sources, **personal queue first** (docs/92 §92.5):
 *  1. **Dispatched to me** — any ticket already `claimed_by = worker` (the owner
 *     pre-assigned it via claim-by-id, HS-8964); worked regardless of `up_next`.
 *  2. **Shared pool** — an `up_next`, unclaimed-or-expired ticket (self-claim).
 *  Both require an actionable status, no unfinished `blocked_by` dependency
 *  (HS-8865), and being under the poison-retry budget (HS-8970). Own-claimed
 *  tickets sort ahead of the shared pool, then by the worklist priority order. */
export async function claimNext(
  worker: string,
  label: string | null,
  ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
): Promise<Ticket | null> {
  const db = await getDb();
  const result = await db.query<Ticket>(
    `WITH next AS (
       SELECT id FROM tickets
        WHERE status NOT IN ${CLAIMABLE_STATUS_EXCLUDE}
          AND claim_count < ${MAX_CLAIM_ATTEMPTS}
          AND id NOT IN (${BLOCKED_TICKET_IDS_SQL})
          AND (
            claimed_by = $1
            OR (up_next = TRUE AND (claimed_by IS NULL OR claim_lease_expires_at < NOW()))
          )
        ORDER BY (CASE WHEN claimed_by = $1 THEN 0 ELSE 1 END), ${PRIORITY_ORD} ASC, id DESC
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
 *  live lease is held by a different worker — UNLESS `force` (HS-8974 reassign),
 *  which atomically overwrites whoever holds it (no release-then-claim race). */
export async function claimById(
  id: number,
  worker: string,
  label: string | null,
  ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
  force = false,
): Promise<ClaimByIdResult> {
  const db = await getDb();
  // Non-force claims only land on an unclaimed / expired / already-mine ticket;
  // a force reassign drops that guard and takes it from the current holder.
  const claimGuard = force ? '' : 'AND (claimed_by IS NULL OR claim_lease_expires_at < NOW() OR claimed_by = $2)';
  const result = await db.query<Ticket>(
    `UPDATE tickets
        SET claimed_by = $2,
            worker_label = $3,
            claim_lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
            claim_count = claim_count + 1
      WHERE id = $1
        AND status NOT IN ${CLAIMABLE_STATUS_EXCLUDE}
        ${claimGuard}
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
 *  surfaces + frees them.
 *
 *  HS-8970 — poison-ticket dead-letter: when a reclaimed ticket has hit
 *  `MAX_CLAIM_ATTEMPTS` claims without completing, it is **quarantined** instead
 *  of merely reclaimed — dropped from Up Next (so `claimNext` stops offering it),
 *  tagged `needs-attention`, and given a `QUARANTINED:` note. Its `claim_count` is
 *  reset to 0 so re-starring (up_next → true) gives it a fresh retry budget. */
export async function sweepExpiredClaims(): Promise<number> {
  const db = await getDb();
  const expired = await db.query<{ id: number; worker_label: string | null; claimed_by: string; claim_count: number; tags: string; status: string }>(
    `UPDATE tickets
        SET claimed_by = NULL, claim_lease_expires_at = NULL, worker_label = NULL
      WHERE claimed_by IS NOT NULL AND claim_lease_expires_at < NOW()
     RETURNING id, worker_label, claimed_by, claim_count, tags, status`,
  );
  for (const row of expired.rows) {
    const who = row.worker_label != null && row.worker_label !== '' ? row.worker_label : row.claimed_by;
    const actionable = row.status !== 'completed' && row.status !== 'verified';
    if (actionable && row.claim_count >= MAX_CLAIM_ATTEMPTS) {
      const tags = parseJsonOrNull(TagsArraySchema, row.tags) ?? [];
      if (!tags.includes(QUARANTINE_TAG)) tags.push(QUARANTINE_TAG);
      await updateTicket(row.id, {
        up_next: false,
        tags: JSON.stringify(tags),
        notes: `QUARANTINED: claimed ${row.claim_count}× without completing — needs attention (last worker \`${who}\`). Fix it, then re-star to retry.`,
      });
      // Fresh budget for the next attempt once the owner re-queues it.
      await db.query('UPDATE tickets SET claim_count = 0 WHERE id = $1', [row.id]);
    } else {
      await updateTicket(row.id, { notes: `Claim lease expired — reclaimed from \`${who}\`.` });
    }
  }
  return expired.rows.length;
}
