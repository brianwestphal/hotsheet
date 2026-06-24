import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseJsonOrNull, TagsArraySchema } from '../schemas.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { claimById, claimNext, getClaims, MAX_CLAIM_ATTEMPTS, QUARANTINE_TAG, release, renewLease, sweepExpiredClaims } from './claims.js';
import { getDb } from './connection.js';
import { parseNotes } from './notes.js';
import { createTicket, getTicket } from './tickets.js';

let dataDir: string;
beforeEach(async () => { dataDir = await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(dataDir); });

/** Create an Up Next ticket at the given priority. */
async function upNext(title: string, priority: 'highest' | 'high' | 'default' | 'low' = 'default') {
  return createTicket(title, { up_next: true, priority });
}

/** Force a ticket's lease into the past (simulate a dead worker). */
async function expireLease(id: number): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE tickets SET claim_lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [id]);
}

/** Force a ticket's claim_count (simulate N prior attempts). */
async function setClaimCount(id: number, n: number): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE tickets SET claim_count = $2 WHERE id = $1', [id, n]);
}

describe('claim/lease primitive (HS-8862)', () => {
  it('claims the top-priority Up Next ticket and stamps claim fields', async () => {
    await upNext('low one', 'low');
    const high = await upNext('high one', 'high');

    const claimed = await claimNext('worker-1', 'Worker 1');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(high.id); // priority order: high before low
    expect(claimed!.claimed_by).toBe('worker-1');
    expect(claimed!.worker_label).toBe('Worker 1');
    expect(claimed!.claim_count).toBe(1);
    expect(claimed!.claim_lease_expires_at).not.toBeNull();
    // Status is untouched by a claim (orthogonal).
    expect(claimed!.status).toBe('not_started');
  });

  it('returns null when nothing is claimable', async () => {
    await createTicket('not up next'); // up_next defaults false
    expect(await claimNext('w', null)).toBeNull();
  });

  it('two claim-next calls return distinct tickets (no double-claim)', async () => {
    const a = await upNext('a', 'high');
    const b = await upNext('b', 'high');
    const [c1, c2] = await Promise.all([claimNext('w1', null), claimNext('w2', null)]);
    const ids = [c1?.id, c2?.id].sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(c1!.id).not.toBe(c2!.id);
  });

  it('skips a live-leased ticket and reclaims an expired one', async () => {
    const only = await upNext('only', 'high');
    const first = await claimNext('w1', null);
    expect(first!.id).toBe(only.id);

    // Live lease held by w1 → nothing else claimable.
    expect(await claimNext('w2', null)).toBeNull();

    // Lease expires → w2 can reclaim it.
    await expireLease(only.id);
    const reclaimed = await claimNext('w2', null);
    expect(reclaimed!.id).toBe(only.id);
    expect(reclaimed!.claimed_by).toBe('w2');
    expect(reclaimed!.claim_count).toBe(2); // claimed twice now
  });

  it('claimById: success when free, conflict on a live foreign lease, re-claim by holder, not_found otherwise', async () => {
    const t = await upNext('t', 'high');

    const ok = await claimById(t.id, 'w1', 'W1');
    expect(ok.ok).toBe(true);

    const conflict = await claimById(t.id, 'w2', 'W2');
    expect(conflict).toEqual(expect.objectContaining({ ok: false, reason: 'conflict', claimedBy: 'w1' }));

    // The holder re-claiming is fine (lease bump).
    const recl = await claimById(t.id, 'w1', 'W1');
    expect(recl.ok).toBe(true);

    const missing = await claimById(999999, 'w1', null);
    expect(missing).toEqual({ ok: false, reason: 'not_found' });
  });

  it('renewLease extends only while the worker holds a live lease', async () => {
    const t = await upNext('t', 'high');
    await claimNext('w1', null);

    const r1 = await renewLease(t.id, 'w1');
    expect(r1.ok).toBe(true);
    expect(r1.leaseExpiresAt).toBeTruthy();

    // Wrong worker can't renew.
    expect((await renewLease(t.id, 'w2')).ok).toBe(false);

    // Expired lease can't be renewed (must re-claim).
    await expireLease(t.id);
    expect((await renewLease(t.id, 'w1')).ok).toBe(false);
  });

  it('release frees a claim; a non-holder release is a no-op', async () => {
    const t = await upNext('t', 'high');
    await claimNext('w1', null);

    // Another worker can't release it.
    await release(t.id, 'w2');
    expect(await claimNext('w2', null)).toBeNull(); // still held by w1

    // The holder releases → claimable again.
    await release(t.id, 'w1');
    const after = await getTicket(t.id);
    expect(after!.claimed_by).toBeNull();
    expect((await claimNext('w2', null))!.id).toBe(t.id);
  });

  it('getClaims lists only live claims', async () => {
    const a = await upNext('a', 'high');
    const b = await upNext('b', 'high');
    await claimNext('w1', 'W1');
    await claimNext('w2', 'W2');
    expect((await getClaims()).length).toBe(2);

    await expireLease(a.id);
    const live = await getClaims();
    expect(live.length).toBe(1);
    expect(live[0].ticketId).toBe(b.id);
  });

  it('sweepExpiredClaims clears expired claims and appends a reclaim note', async () => {
    const t = await upNext('t', 'high');
    await claimNext('w1', 'Worker 1');
    await expireLease(t.id);

    const swept = await sweepExpiredClaims();
    expect(swept).toBe(1);

    const after = await getTicket(t.id);
    expect(after!.claimed_by).toBeNull();
    expect(after!.claim_lease_expires_at).toBeNull();
    expect(after!.up_next).toBe(true); // under budget → stays claimable
    const notes = parseNotes(after!.notes);
    expect(notes.some(n => n.text.includes('lease expired'))).toBe(true);
  });

  describe('coordinator-dispatch personal queue (HS-8964)', () => {
    it('claimNext serves a worker its own-claimed (dispatched) ticket before the shared pool', async () => {
      const dispatched = await upNext('dispatched-low', 'low');
      await upNext('shared-high', 'high');
      // Owner dispatches the low-priority ticket to w1 (claim-by-id on its behalf).
      expect((await claimById(dispatched.id, 'w1', 'worker-1')).ok).toBe(true);
      // w1's next claim-next returns its OWN ticket first, despite the higher-priority
      // unclaimed one in the shared pool.
      const got = await claimNext('w1', 'worker-1');
      expect(got!.id).toBe(dispatched.id);
    });

    it('a dispatched ticket is served to its worker even when not up_next (personal queue)', async () => {
      const t = await createTicket('not-up-next', { up_next: false });
      await claimById(t.id, 'w1', 'worker-1');
      expect((await claimNext('w1', 'worker-1'))!.id).toBe(t.id);
      // ...but another worker never sees it (live foreign lease).
      const t2 = await createTicket('still-not-up-next', { up_next: false });
      await claimById(t2.id, 'w1', 'worker-1');
      expect(await claimNext('w2', 'worker-2')).toBeNull();
    });
  });

  describe('reassign / recall (HS-8974)', () => {
    it('claimById force overwrites a live foreign lease (reassign)', async () => {
      const t = await upNext('reassign-me', 'high');
      expect((await claimById(t.id, 'A', 'worker-A')).ok).toBe(true);
      // Without force, another worker conflicts.
      const conflict = await claimById(t.id, 'B', 'worker-B');
      expect(conflict.ok).toBe(false);
      // With force, B takes it over.
      const forced = await claimById(t.id, 'B', 'worker-B', undefined, true);
      expect(forced.ok).toBe(true);
      expect((await getTicket(t.id))!.claimed_by).toBe('B');
    });

    it('force claim still refuses a terminal-status ticket', async () => {
      const t = await upNext('done', 'high');
      const db = await getDb();
      await db.query("UPDATE tickets SET status = 'completed' WHERE id = $1", [t.id]);
      expect((await claimById(t.id, 'A', 'worker-A', undefined, true)).ok).toBe(false);
    });

    it('force-release (no worker) recalls a claim back to the self-claimable pool', async () => {
      const t = await upNext('recall-me', 'high');
      await claimById(t.id, 'A', 'worker-A');
      await release(t.id); // force-release (owner recall)
      expect((await getTicket(t.id))!.claimed_by).toBeNull();
      expect((await claimNext('B', 'worker-B'))!.id).toBe(t.id);
    });
  });

  describe('poison-ticket dead-letter (HS-8970)', () => {
    it('claimNext refuses a ticket that has hit MAX_CLAIM_ATTEMPTS', async () => {
      const t = await upNext('poison', 'high');
      await setClaimCount(t.id, MAX_CLAIM_ATTEMPTS - 1);
      // One attempt left → claimable (claim_count becomes MAX).
      expect((await claimNext('w1', 'W1'))!.id).toBe(t.id);
      await release(t.id, 'w1');
      expect((await getTicket(t.id))!.claim_count).toBe(MAX_CLAIM_ATTEMPTS);
      // Now at the budget → no longer offered.
      expect(await claimNext('w2', 'W2')).toBeNull();
    });

    it('the sweep quarantines a ticket that expired at the budget: drops Up Next, tags + notes, resets the counter', async () => {
      const t = await upNext('poison', 'high');
      await claimNext('w1', 'Worker 1');         // claimed_by set, claim_count = 1
      await setClaimCount(t.id, MAX_CLAIM_ATTEMPTS); // simulate having burned the budget
      await expireLease(t.id);

      expect(await sweepExpiredClaims()).toBe(1);

      const after = await getTicket(t.id);
      expect(after!.claimed_by).toBeNull();
      expect(after!.up_next).toBe(false);        // dropped from the claimable pool
      expect(after!.claim_count).toBe(0);        // fresh budget for a re-star
      expect(parseJsonOrNull(TagsArraySchema, after!.tags)).toContain(QUARANTINE_TAG);
      expect(parseNotes(after!.notes).some(n => n.text.startsWith('QUARANTINED:'))).toBe(true);
      // And it is no longer claimable.
      expect(await claimNext('w2', 'W2')).toBeNull();
    });

    it('re-starring a quarantined ticket (up_next → true) makes it claimable again with a fresh budget', async () => {
      const t = await upNext('poison', 'high');
      await claimNext('w1', 'W1');
      await setClaimCount(t.id, MAX_CLAIM_ATTEMPTS);
      await expireLease(t.id);
      await sweepExpiredClaims();

      // Owner re-queues it (claim_count was reset to 0 by the sweep).
      const db = await getDb();
      await db.query('UPDATE tickets SET up_next = TRUE WHERE id = $1', [t.id]);
      expect((await claimNext('w3', 'W3'))!.id).toBe(t.id);
    });
  });
});
