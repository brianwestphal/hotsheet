import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getBlockedBy, getBlockedByMap, isBlocked, setBlockedBy } from './blockedBy.js';
import { claimNext } from './claims.js';
import { createTicket, updateTicket } from './tickets.js';

let dataDir: string;
beforeEach(async () => { dataDir = await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(dataDir); });

async function upNext(title: string, priority: 'highest' | 'high' | 'default' | 'low' = 'default') {
  return createTicket(title, { up_next: true, priority });
}

describe('blocked_by gate (HS-8865)', () => {
  it('sets + reads a blocker list', async () => {
    const a = await upNext('a');
    const b = await createTicket('b');
    const c = await createTicket('c');
    const r = await setBlockedBy(a.id, [c.id, b.id, b.id]); // dup deduped
    expect(r).toEqual({ ok: true, blockedBy: [b.id, c.id].sort((x, y) => x - y) });
    expect(await getBlockedBy(a.id)).toEqual([b.id, c.id].sort((x, y) => x - y));
    expect(await isBlocked(a.id)).toBe(true);
  });

  it('rejects a self-block, an unknown ticket, and a cycle', async () => {
    const a = await upNext('a');
    const b = await createTicket('b');
    expect(await setBlockedBy(a.id, [a.id])).toEqual({ ok: false, reason: 'self' });
    expect(await setBlockedBy(a.id, [999999])).toEqual({ ok: false, reason: 'unknown_ticket' });
    // a blocks_on b; now b blocks_on a would cycle.
    await setBlockedBy(a.id, [b.id]);
    expect(await setBlockedBy(b.id, [a.id])).toEqual({ ok: false, reason: 'cycle' });
  });

  it('claim-next skips a blocked ticket and frees it when the blocker completes', async () => {
    const dependent = await upNext('dependent', 'highest'); // would be claimed first…
    const blocker = await upNext('blocker', 'low');
    await setBlockedBy(dependent.id, [blocker.id]);

    // Despite higher priority, the dependent is blocked → the blocker is claimed.
    const first = await claimNext('w1', null);
    expect(first!.id).toBe(blocker.id);
    // Nothing else claimable while the blocker is open + claimed.
    expect(await claimNext('w2', null)).toBeNull();

    // Complete the blocker → the dependent becomes claimable.
    await updateTicket(blocker.id, { status: 'completed' });
    expect(await isBlocked(dependent.id)).toBe(false);
    const next = await claimNext('w2', null);
    expect(next!.id).toBe(dependent.id);
  });

  it('a verified blocker also unblocks; an empty set clears the gate', async () => {
    const dep = await upNext('dep');
    const blk = await createTicket('blk');
    await setBlockedBy(dep.id, [blk.id]);
    expect(await isBlocked(dep.id)).toBe(true);

    await updateTicket(blk.id, { status: 'verified' });
    expect(await isBlocked(dep.id)).toBe(false);

    // Clearing the set removes the edge entirely.
    await setBlockedBy(dep.id, []);
    expect(await getBlockedBy(dep.id)).toEqual([]);
  });

  it('getBlockedByMap bulk-loads only tickets with blockers', async () => {
    const a = await upNext('a');
    const b = await createTicket('b');
    const c = await createTicket('c');
    await setBlockedBy(a.id, [b.id, c.id]);
    const map = await getBlockedByMap([a.id, b.id, c.id]);
    expect(map.get(a.id)).toEqual([b.id, c.id].sort((x, y) => x - y));
    expect(map.has(b.id)).toBe(false);
  });
});
