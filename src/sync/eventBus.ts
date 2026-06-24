// HS-7945 / HS-8978 — server-side event bus for WebSocket push sync
// (docs/93-websocket-push-sync.md §93.2). The foundation phase: a small,
// pure, network-free module that every other WS-push phase consumes. It knows
// nothing about WebSockets — the `/ws/sync` endpoint (HS-8979) registers a
// sink that serializes + sends; mutation routes (HS-8980) call `emitEvent`.
//
// Scoping is per-project (today's trust boundary, keyed by the project
// secret): each project has its own monotonic `seq` counter, its own bounded
// ring of recent events, and its own set of live sinks. A sink only ever sees
// events for the project it registered against — no cross-project leakage.
//
// State is process-lifetime and in-memory (not persisted): a restart resets
// every `seq` to 0, at which point reconnecting clients fall back to a full
// refetch via the `resync` path (§93.6). Additive — this module does NOT
// touch the existing `src/routes/notify.ts` long-poll counter.

import { type SyncEvent, type SyncEventInput,SyncEventInputSchema } from '../schemas.js';

/** Bounded ring size per project. ~15 min of typical activity. */
export const DEFAULT_RING_CAPACITY = 1000;

/** A consumer of a project's events — one per live WebSocket. */
export type SyncEventSink = (event: SyncEvent) => void;

/** Result of a `?since=<seq>` catch-up request. When `evicted` is true the
 *  client asked for a `seq` older than the ring still holds, so it must do a
 *  full refetch (`resync`) instead of replaying the returned (empty) tail. */
export interface CatchUpResult {
  evicted: boolean;
  events: SyncEvent[];
}

interface ProjectBus {
  seq: number;            // last assigned seq (next emit is `++seq`)
  ring: SyncEvent[];      // most-recent events, oldest first, length <= capacity
  sinks: Set<SyncEventSink>;
}

export interface EventBus {
  /** Stamp the next per-project `seq`, append to the ring (evicting the
   *  oldest past capacity), and fan out to every sink of that project.
   *  Returns the sequenced event. Throws if `input` fails schema validation. */
  emit(projectSecret: string, input: SyncEventInput): SyncEvent;
  /** Replay events with `seq > sinceSeq` for the project. `evicted` is true
   *  when the requested `sinceSeq` predates the oldest retained event (the
   *  client is too far behind and must full-refetch). */
  getEventsSince(projectSecret: string, sinceSeq: number): CatchUpResult;
  /** Subscribe a sink to a project's events. Returns an unsubscribe fn. */
  registerSink(projectSecret: string, sink: SyncEventSink): () => void;
  /** Live sink count for a project (test/diagnostic aid). */
  sinkCount(projectSecret: string): number;
  /** Highest `seq` assigned for a project so far (0 if none). */
  currentSeq(projectSecret: string): number;
}

export function createEventBus(capacity: number = DEFAULT_RING_CAPACITY): EventBus {
  if (capacity < 1) throw new Error(`eventBus capacity must be >= 1, got ${capacity}`);
  const projects = new Map<string, ProjectBus>();

  function bus(secret: string): ProjectBus {
    let p = projects.get(secret);
    if (!p) {
      p = { seq: 0, ring: [], sinks: new Set() };
      projects.set(secret, p);
    }
    return p;
  }

  return {
    emit(projectSecret, input) {
      const parsed = SyncEventInputSchema.parse(input);
      const p = bus(projectSecret);
      const event: SyncEvent = { ...parsed, seq: ++p.seq };
      p.ring.push(event);
      if (p.ring.length > capacity) p.ring.shift();
      // Snapshot the sink set so a sink that unsubscribes itself mid-dispatch
      // doesn't perturb the iteration.
      for (const sink of [...p.sinks]) sink(event);
      return event;
    },

    getEventsSince(projectSecret, sinceSeq) {
      const p = projects.get(projectSecret);
      if (!p || sinceSeq >= p.seq) return { evicted: false, events: [] };
      const earliest = p.ring[0]?.seq ?? p.seq + 1;
      // Evicted when the next event the client needs (sinceSeq + 1) is older
      // than the oldest we still retain.
      if (earliest > sinceSeq + 1) return { evicted: true, events: [] };
      return { evicted: false, events: p.ring.filter((e) => e.seq > sinceSeq) };
    },

    registerSink(projectSecret, sink) {
      const p = bus(projectSecret);
      p.sinks.add(sink);
      return () => {
        p.sinks.delete(sink);
      };
    },

    sinkCount(projectSecret) {
      return projects.get(projectSecret)?.sinks.size ?? 0;
    },

    currentSeq(projectSecret) {
      return projects.get(projectSecret)?.seq ?? 0;
    },
  };
}

// Process-wide singleton the app wires through. The `/ws/sync` endpoint and
// the mutation routes share this instance; tests construct their own via
// `createEventBus(capacity)` for isolation + cheap eviction testing.
export const eventBus: EventBus = createEventBus();

/** Convenience free functions over the singleton, for route wiring (HS-8980)
 *  and the endpoint (HS-8979). */
export function emitEvent(projectSecret: string, input: SyncEventInput): SyncEvent {
  return eventBus.emit(projectSecret, input);
}

export function getEventsSince(projectSecret: string, sinceSeq: number): CatchUpResult {
  return eventBus.getEventsSince(projectSecret, sinceSeq);
}

export function registerSyncSink(projectSecret: string, sink: SyncEventSink): () => void {
  return eventBus.registerSink(projectSecret, sink);
}
