// HS-8982 — event coalescing for WebSocket push (docs/93 §93.8). Collapses a
// run of consecutive same-type mutation events into a single `batch-operation`
// frame so a burst (a bulk import, a far-behind `?since` catch-up of up to the
// full ring) doesn't put hundreds of frames on the wire. Pure + synchronous.
//
// Applied today to the `?since` replay in `src/routes/wsSync.ts` (a real,
// bounded, always-on use). The live-fanout path stays uncoalesced — the client
// already debounces pushed events into one refresh, so there's no current flood
// to absorb there; this helper is ready to wire into fanout if one appears.

import type { SyncEvent } from '../schemas.js';

/** Default: coalesce a same-type run once it reaches this many events. */
export const DEFAULT_COALESCE_THRESHOLD = 20;

/** Event types whose payloads carry ticket id(s) and so can be merged into a
 *  batch-operation. `settings-changed` (no ids) and `batch-operation` (already
 *  merged) are passed through. */
const MERGEABLE = new Set([
  'ticket-created', 'ticket-updated', 'ticket-deleted',
  'note-added', 'note-deleted',
  'category-changed', 'priority-changed', 'status-changed',
  'attachment-added', 'attachment-deleted',
]);

function idsOf(event: SyncEvent): number[] {
  switch (event.type) {
    case 'ticket-created': return [event.ticket.id];
    case 'ticket-updated':
    case 'ticket-deleted': return [event.id];
    case 'note-added':
    case 'note-deleted':
    case 'attachment-added':
    case 'attachment-deleted': return [event.ticketId];
    case 'category-changed':
    case 'priority-changed':
    case 'status-changed': return [...event.ticketIds];
    case 'settings-changed':
    case 'batch-operation': return [];
  }
}

/**
 * Coalesce consecutive same-type mergeable runs of `threshold` or more into one
 * `batch-operation` frame carrying the union of affected ids (deduped, order-
 * preserving) and the MAX seq of the run (so a client tracking `seq` advances
 * exactly as if it had applied the whole run). Shorter runs and non-mergeable
 * events pass through unchanged, preserving order.
 */
export function coalesceEvents(events: readonly SyncEvent[], threshold = DEFAULT_COALESCE_THRESHOLD): SyncEvent[] {
  const out: SyncEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const type = events[i].type;
    let j = i;
    while (j < events.length && events[j].type === type) j++;
    const run = events.slice(i, j);
    if (run.length >= threshold && MERGEABLE.has(type)) {
      const seen = new Set<number>();
      const ids: number[] = [];
      let maxSeq = 0;
      for (const ev of run) {
        for (const id of idsOf(ev)) if (!seen.has(id)) { seen.add(id); ids.push(id); }
        if (ev.seq > maxSeq) maxSeq = ev.seq;
      }
      out.push({ type: 'batch-operation', op: type, ids, changes: {}, seq: maxSeq });
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}
