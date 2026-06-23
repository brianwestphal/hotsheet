// HS-8863 — worker loop tests (docs/90 §90.5/§90.7). Exercises the canonical
// claim → work → complete + release → repeat cycle against a real test DB, plus
// the multi-worker invariants the ticket calls for: two workers drain a pool with
// no double-work, and a killed worker's in-flight ticket is reclaimed + finished
// by another.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext } from '../db/claims.js';
import { getDb } from '../db/connection.js';
import { createTicket, getTicket } from '../db/tickets.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { startWorker } from './workerLoop.js';

let dataDir: string;
beforeEach(async () => { dataDir = await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(dataDir); });

const noSleep = (): Promise<void> => Promise.resolve();

/** Force a ticket's lease into the past (simulate a dead worker). */
async function expireLease(id: number): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE tickets SET claim_lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [id]);
}

describe('worker loop (HS-8863)', () => {
  it('drains the pool solo: claims, completes (status + notes), releases, in priority order', async () => {
    const low = await createTicket('low', { up_next: true, priority: 'low' });
    const high = await createTicket('high', { up_next: true, priority: 'high' });

    const order: number[] = [];
    const { done } = startWorker({
      worker: 'w1', label: 'Worker 1',
      maxIdleRounds: 1, idleBackoffMs: 0, heartbeatMs: 0, sleep: noSleep,
      doWork: (t) => { order.push(t.id); return Promise.resolve({ notes: `did ${t.ticket_number}` }); },
    });
    const summary = await done;

    expect(summary.reason).toBe('drained');
    expect(summary.completed).toBe(2);
    // High priority claimed before low.
    expect(order).toEqual([high.id, low.id]);

    for (const id of [high.id, low.id]) {
      const t = await getTicket(id);
      expect(t!.status).toBe('completed');
      expect(t!.claimed_by).toBeNull();             // released
      expect(t!.claim_lease_expires_at).toBeNull();
      expect(t!.notes).toContain('did ');           // notes written
    }
  });

  it('two workers drain a shared pool with no double-work and no orphaned claims', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push((await createTicket(`t${i}`, { up_next: true })).id);

    const claimedBy = new Map<number, string>();
    const mkWorker = (name: string) => startWorker({
      worker: name, label: name,
      maxIdleRounds: 1, idleBackoffMs: 0, heartbeatMs: 0, sleep: noSleep,
      doWork: (t) => {
        // First worker to reach here for this ticket records ownership; a double
        // claim would overwrite and the assertion below would catch it.
        expect(claimedBy.has(t.id)).toBe(false);
        claimedBy.set(t.id, name);
        return Promise.resolve({ notes: `done by ${name}` });
      },
    });

    const [a, b] = await Promise.all([mkWorker('A').done, mkWorker('B').done]);

    // Every ticket completed exactly once, across the two workers.
    expect(a.completed + b.completed).toBe(ids.length);
    expect(new Set([...a.completedIds, ...b.completedIds]).size).toBe(ids.length);
    for (const id of ids) {
      const t = await getTicket(id);
      expect(t!.status).toBe('completed');
      expect(t!.claimed_by).toBeNull();             // no orphaned claims
    }
  });

  it("reclaims a dead worker's in-flight ticket: another worker finishes it (lease expiry)", async () => {
    const t = await createTicket('orphan', { up_next: true });

    // Worker A claims the ticket then "dies" — we simulate the crash by expiring
    // its lease without completing the work.
    const claimed = await claimNext('A', 'Worker A');
    expect(claimed!.id).toBe(t.id);
    await expireLease(t.id);

    // Worker B's loop should reclaim and finish it.
    const { done } = startWorker({
      worker: 'B', label: 'Worker B',
      maxIdleRounds: 1, idleBackoffMs: 0, heartbeatMs: 0, sleep: noSleep,
      doWork: () => Promise.resolve({ notes: 'finished by B after A died' }),
    });
    const summary = await done;

    expect(summary.completedIds).toEqual([t.id]);
    const after = await getTicket(t.id);
    expect(after!.status).toBe('completed');
    expect(after!.claimed_by).toBeNull();
  });

  it('does NOT complete a ticket whose lease it lost mid-work (reclaimed by another)', async () => {
    const t = await createTicket('stolen', { up_next: true });
    const events: string[] = [];

    const { done } = startWorker({
      worker: 'slow', label: 'Slow',
      maxIdleRounds: 1, idleBackoffMs: 0,
      heartbeatMs: 10, ttlSeconds: 120, sleep: noSleep,
      onEvent: (e) => events.push(e.type),
      doWork: async (ticket) => {
        // Simulate the lease being stolen mid-work: expire ours, then let another
        // worker grab it with a LIVE lease, so our heartbeat renew fails and the
        // ticket is no longer claimable by us (the loop then drains cleanly).
        await expireLease(ticket.id);
        await claimNext('thief', 'Thief');
        await new Promise(r => setTimeout(r, 40)); // allow ≥1 heartbeat to detect the loss
        return { notes: 'should be ignored' };
      },
    });
    const summary = await done;

    expect(events).toContain('lease-lost');
    expect(summary.completed).toBe(0);              // it did not complete the stolen ticket
    const after = await getTicket(t.id);
    expect(after!.status).not.toBe('completed');
    expect(after!.claimed_by).toBe('thief');        // still owned by whoever stole it
  });

  it('graceful stop finishes the current ticket but claims no more', async () => {
    await createTicket('first', { up_next: true });
    await createTicket('second', { up_next: true });

    const handle = startWorker({
      worker: 'g', label: 'Graceful',
      maxIdleRounds: 1, idleBackoffMs: 0, heartbeatMs: 0, sleep: noSleep,
      doWork: (t) => {
        handle.stop();                              // request stop mid-first-ticket
        return Promise.resolve({ notes: `finished ${t.id}` });
      },
    });
    const summary = await handle.done;

    expect(summary.reason).toBe('stopped');
    expect(summary.completed).toBe(1);              // finished the in-flight ticket, then stopped
  });

  it('parks a ticket (records an error note, no hot-loop) when doWork throws', async () => {
    const t = await createTicket('boom', { up_next: true });
    const events: string[] = [];
    const { done } = startWorker({
      worker: 'e', label: 'Err',
      maxIdleRounds: 1, idleBackoffMs: 0, heartbeatMs: 0, sleep: noSleep,
      onEvent: (e) => events.push(e.type),
      doWork: () => { throw new Error('work failed'); },
    });
    const summary = await done;

    expect(events).toContain('work-error');
    expect(summary.completed).toBe(0);
    expect(summary.reason).toBe('drained');          // it did NOT hot-loop on the failing ticket
    const after = await getTicket(t.id);
    expect(after!.status).not.toBe('completed');
    expect(after!.claimed_by).toBe('e');             // parked under the worker's lease (expires → retry later)
    expect(after!.notes).toContain('hit an error: work failed');
  });
});
