import { beforeEach, describe, expect, it } from 'vitest';

import {
  _pendingCountForTesting,
  _resetForTesting,
  _snapshotForTesting,
  clearAllPermissions,
  completePermission,
  enqueuePermission,
  peekPending,
  type PendingPermission,
  PERMISSION_TTL_MS,
} from './channelPermissions.js';

function makePerm(id: string, ts: number): PendingPermission {
  return {
    request_id: id,
    tool_name: 'Bash',
    description: `tool call ${id}`,
    input_preview: '',
    timestamp: ts,
  };
}

beforeEach(() => {
  _resetForTesting();
});

describe('channelPermissions queue (HS-8047)', () => {
  it('starts empty', () => {
    expect(_pendingCountForTesting()).toBe(0);
    expect(peekPending()).toBeNull();
  });

  it('enqueue + peek returns the first request', () => {
    const a = makePerm('A', 1000);
    enqueuePermission(a);
    expect(peekPending(2000)).toEqual(a);
  });

  // Core regression: pre-fix the channel server held a single
  // `pendingPermission` slot — a follow-up enqueue overwrote the prior one
  // and the popup the user was looking at vanished. The queue must
  // preserve every concurrently-pending request in arrival order.
  it('preserves earlier requests when later ones arrive (the HS-8047 root cause)', () => {
    const a = makePerm('A', 1000);
    const b = makePerm('B', 1100);
    const c = makePerm('C', 1200);

    enqueuePermission(a);
    enqueuePermission(b);
    enqueuePermission(c);

    expect(_pendingCountForTesting()).toBe(3);
    // Wire surface returns the head — the user sees A first.
    expect(peekPending(1500)).toEqual(a);
    // After A is responded to, the next peek surfaces B (NOT silently
    // dropped pre-fix).
    completePermission('A');
    expect(peekPending(1500)).toEqual(b);
    completePermission('B');
    expect(peekPending(1500)).toEqual(c);
    completePermission('C');
    expect(peekPending(1500)).toBeNull();
  });

  it('skips duplicate enqueue of the same request_id (defensive against MCP retries)', () => {
    const a = makePerm('A', 1000);
    enqueuePermission(a);
    enqueuePermission({ ...a, description: 'a different description for the same id' });
    expect(_pendingCountForTesting()).toBe(1);
    expect(peekPending(1500)?.description).toBe('tool call A'); // first one wins
  });

  it('completePermission removes by id regardless of position', () => {
    enqueuePermission(makePerm('A', 1000));
    enqueuePermission(makePerm('B', 1100));
    enqueuePermission(makePerm('C', 1200));

    // Respond to B first (out-of-order — rare but cheap to support).
    expect(completePermission('B')).toBe(true);
    expect(_snapshotForTesting().map(p => p.request_id)).toEqual(['A', 'C']);

    // Unknown id is a no-op + returns false.
    expect(completePermission('Z')).toBe(false);
    expect(_pendingCountForTesting()).toBe(2);
  });

  it('peekPending auto-expires entries older than the TTL', () => {
    const t0 = 1000;
    enqueuePermission(makePerm('A', t0));
    enqueuePermission(makePerm('B', t0 + 5000));

    // Within the TTL window — head still A.
    expect(peekPending(t0 + 1000)?.request_id).toBe('A');

    // Step past A's TTL but still inside B's. A drops; head becomes B.
    expect(peekPending(t0 + PERMISSION_TTL_MS + 1)?.request_id).toBe('B');
    expect(_pendingCountForTesting()).toBe(1);
  });

  it('peekPending sweeps multiple expired entries from the head in one call', () => {
    const t0 = 1000;
    enqueuePermission(makePerm('A', t0));
    enqueuePermission(makePerm('B', t0 + 100));
    enqueuePermission(makePerm('C', t0 + 200));
    enqueuePermission(makePerm('D', t0 + PERMISSION_TTL_MS + 5000));

    // Past A's, B's, C's TTLs but inside D's.
    const head = peekPending(t0 + PERMISSION_TTL_MS + 1000);
    expect(head?.request_id).toBe('D');
    expect(_pendingCountForTesting()).toBe(1);
  });

  it('clearAllPermissions empties the queue', () => {
    enqueuePermission(makePerm('A', 1000));
    enqueuePermission(makePerm('B', 1100));
    clearAllPermissions();
    expect(_pendingCountForTesting()).toBe(0);
    expect(peekPending()).toBeNull();
  });
});
