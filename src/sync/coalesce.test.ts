import { describe, expect, it } from 'vitest';

import type { SyncEvent } from '../schemas.js';
import { coalesceEvents } from './coalesce.js';

const upd = (id: number, seq: number): SyncEvent => ({ type: 'ticket-updated', id, changes: {}, seq });
const del = (id: number, seq: number): SyncEvent => ({ type: 'ticket-deleted', id, seq });
const settings = (key: string, seq: number): SyncEvent => ({ type: 'settings-changed', key, value: 1, seq });

describe('coalesceEvents', () => {
  it('passes a short run through unchanged (below threshold)', () => {
    const events = [upd(1, 1), upd(2, 2), upd(3, 3)];
    expect(coalesceEvents(events, 5)).toEqual(events);
  });

  it('merges a long same-type run into one batch-operation (union ids, max seq)', () => {
    const events = Array.from({ length: 5 }, (_, k) => upd(k + 1, k + 1));
    const out = coalesceEvents(events, 5);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'batch-operation', op: 'ticket-updated', ids: [1, 2, 3, 4, 5], changes: {}, seq: 5 });
  });

  it('dedups ids across the run', () => {
    const events = [upd(1, 1), upd(1, 2), upd(2, 3), upd(2, 4)];
    const out = coalesceEvents(events, 3);
    expect(out[0]).toMatchObject({ op: 'ticket-updated', ids: [1, 2], seq: 4 });
  });

  it('coalesces each same-type run independently, preserving order', () => {
    const events = [
      upd(1, 1), upd(2, 2), upd(3, 3),     // run of ticket-updated (>=3)
      del(4, 4), del(5, 5), del(6, 6),     // run of ticket-deleted (>=3)
    ];
    const out = coalesceEvents(events, 3);
    expect(out).toEqual([
      { type: 'batch-operation', op: 'ticket-updated', ids: [1, 2, 3], changes: {}, seq: 3 },
      { type: 'batch-operation', op: 'ticket-deleted', ids: [4, 5, 6], changes: {}, seq: 6 },
    ]);
  });

  it('does not merge across a type boundary (each run measured separately)', () => {
    // 2 updated + 2 deleted, threshold 3 → neither run reaches it → unchanged.
    const events = [upd(1, 1), upd(2, 2), del(3, 3), del(4, 4)];
    expect(coalesceEvents(events, 3)).toEqual(events);
  });

  it('passes settings-changed through (not mergeable) even in a long run', () => {
    const events = Array.from({ length: 5 }, (_, k) => settings(`k${k}`, k + 1));
    expect(coalesceEvents(events, 3)).toEqual(events);
  });

  it('handles category-changed ticketIds in the union', () => {
    const events: SyncEvent[] = [
      { type: 'category-changed', ticketIds: [1, 2], to: 'bug', seq: 1 },
      { type: 'category-changed', ticketIds: [2, 3], to: 'task', seq: 2 },
      { type: 'category-changed', ticketIds: [4], to: 'task', seq: 3 },
    ];
    const out = coalesceEvents(events, 3);
    expect(out[0]).toMatchObject({ op: 'category-changed', ids: [1, 2, 3, 4], seq: 3 });
  });
});
