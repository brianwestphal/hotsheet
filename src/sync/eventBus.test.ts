import { describe, expect, it, vi } from 'vitest';

import type { SyncEvent } from '../schemas.js';
import { createEventBus, DEFAULT_RING_CAPACITY } from './eventBus.js';

const A = 'secret-project-a';
const B = 'secret-project-b';

function created(id: number) {
  return {
    type: 'ticket-created' as const,
    ticket: {
      id,
      ticket_number: `HS-${id}`,
      title: `t${id}`,
      details: '',
      category: 'task',
      priority: 'default' as const,
      status: 'not_started' as const,
      up_next: false,
      created_at: '2026-06-24T00:00:00.000Z',
      updated_at: '2026-06-24T00:00:00.000Z',
      completed_at: null,
      verified_at: null,
      deleted_at: null,
      notes: '[]',
      tags: '[]',
      last_read_at: null,
    },
  };
}

describe('eventBus seq', () => {
  it('assigns a monotonic per-project seq starting at 1', () => {
    const bus = createEventBus();
    expect(bus.currentSeq(A)).toBe(0);
    expect(bus.emit(A, created(1)).seq).toBe(1);
    expect(bus.emit(A, created(2)).seq).toBe(2);
    expect(bus.emit(A, created(3)).seq).toBe(3);
    expect(bus.currentSeq(A)).toBe(3);
  });

  it('keeps each project on its own seq line', () => {
    const bus = createEventBus();
    expect(bus.emit(A, created(1)).seq).toBe(1);
    expect(bus.emit(B, created(1)).seq).toBe(1); // B is independent of A
    expect(bus.emit(A, created(2)).seq).toBe(2);
    expect(bus.emit(B, created(2)).seq).toBe(2);
  });

  it('returns the stamped event from emit', () => {
    const bus = createEventBus();
    const ev = bus.emit(A, { type: 'ticket-deleted', id: 7 });
    expect(ev).toEqual({ type: 'ticket-deleted', id: 7, seq: 1 });
  });
});

describe('eventBus ring', () => {
  it('evicts the oldest events past capacity', () => {
    const bus = createEventBus(3);
    for (let i = 1; i <= 5; i++) bus.emit(A, created(i));
    // Ring now holds seq 3,4,5; 1,2 are evicted.
    const { evicted, events } = bus.getEventsSince(A, 0);
    expect(evicted).toBe(true); // seq 1,2 are gone → must full-resync
    expect(events).toEqual([]);
  });

  it('defaults to a 1000-event ring', () => {
    const bus = createEventBus();
    for (let i = 1; i <= DEFAULT_RING_CAPACITY + 5; i++) bus.emit(A, created(i));
    // The oldest retained seq is 6 (1..5 evicted), so a client at seq 5 is fine
    // but a client at seq 4 has lost seq 5.
    expect(bus.getEventsSince(A, 5).evicted).toBe(false);
    expect(bus.getEventsSince(A, 4).evicted).toBe(true);
  });

  it('rejects a capacity below 1', () => {
    expect(() => createEventBus(0)).toThrow();
  });
});

describe('eventBus getEventsSince', () => {
  it('returns the tail after the given seq', () => {
    const bus = createEventBus();
    for (let i = 1; i <= 5; i++) bus.emit(A, created(i));
    const { evicted, events } = bus.getEventsSince(A, 3);
    expect(evicted).toBe(false);
    expect(events.map((e: SyncEvent) => e.seq)).toEqual([4, 5]);
  });

  it('returns empty when the client is already current', () => {
    const bus = createEventBus();
    bus.emit(A, created(1));
    expect(bus.getEventsSince(A, 1)).toEqual({ evicted: false, events: [] });
    expect(bus.getEventsSince(A, 99)).toEqual({ evicted: false, events: [] });
  });

  it('returns empty (not evicted) for a project that never emitted', () => {
    const bus = createEventBus();
    expect(bus.getEventsSince('never', 0)).toEqual({ evicted: false, events: [] });
  });

  it('is not evicted when sinceSeq is exactly the oldest-minus-one boundary', () => {
    const bus = createEventBus(3);
    for (let i = 1; i <= 5; i++) bus.emit(A, created(i)); // retains seq 3,4,5
    // sinceSeq=2 → next needed is 3, which is the oldest retained → no gap.
    const r = bus.getEventsSince(A, 2);
    expect(r.evicted).toBe(false);
    expect(r.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});

describe('eventBus sinks', () => {
  it('delivers events only to sinks of the same project', () => {
    const bus = createEventBus();
    const aSink = vi.fn();
    const bSink = vi.fn();
    bus.registerSink(A, aSink);
    bus.registerSink(B, bSink);

    bus.emit(A, created(1));
    expect(aSink).toHaveBeenCalledTimes(1);
    expect(bSink).not.toHaveBeenCalled();
    expect(aSink.mock.calls[0][0]).toMatchObject({ type: 'ticket-created', seq: 1 });

    bus.emit(B, created(2));
    expect(aSink).toHaveBeenCalledTimes(1);
    expect(bSink).toHaveBeenCalledTimes(1);
  });

  it('fans out to every sink of a project', () => {
    const bus = createEventBus();
    const s1 = vi.fn();
    const s2 = vi.fn();
    bus.registerSink(A, s1);
    bus.registerSink(A, s2);
    bus.emit(A, created(1));
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unregister', () => {
    const bus = createEventBus();
    const sink = vi.fn();
    const off = bus.registerSink(A, sink);
    bus.emit(A, created(1));
    off();
    bus.emit(A, created(2));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(bus.sinkCount(A)).toBe(0);
  });

  it('tolerates a sink that unsubscribes itself mid-dispatch', () => {
    const bus = createEventBus();
    const seen: number[] = [];
    let off2: () => void = () => {};
    const s1 = vi.fn(() => off2()); // s1 removes s2 while dispatching
    const s2 = vi.fn((e: SyncEvent) => seen.push(e.seq));
    bus.registerSink(A, s1);
    off2 = bus.registerSink(A, s2);
    // Both still receive the in-flight event (dispatch is over a snapshot).
    expect(() => bus.emit(A, created(1))).not.toThrow();
    expect(s2).toHaveBeenCalledTimes(1);
    // Next event: s2 is gone.
    bus.emit(A, created(2));
    expect(s2).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([1]);
  });
});

describe('eventBus validation', () => {
  it('throws on a malformed event input', () => {
    const bus = createEventBus();
    // Missing the required `id` for ticket-deleted.
    // @ts-expect-error — deliberately invalid to exercise runtime validation.
    expect(() => bus.emit(A, { type: 'ticket-deleted' })).toThrow();
  });

  it('throws on an unknown event type', () => {
    const bus = createEventBus();
    // @ts-expect-error — not a member of the discriminated union.
    expect(() => bus.emit(A, { type: 'nope' })).toThrow();
  });
});
