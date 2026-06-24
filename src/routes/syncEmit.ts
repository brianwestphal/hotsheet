// HS-8980 — shared helper for emitting WebSocket-push events from mutation
// route handlers (docs/93 §93.4). Emitted ALONGSIDE the existing
// `notifyMutation` long-poll bump (additive). The per-project secret
// (`projectSecret` context var) is the bus key the `/ws/sync` endpoint
// subscribes by; a blank secret (un-secured project) is a no-op.

import type { Context } from 'hono';

import type { SyncEventInput } from '../schemas.js';
import { emitEvent } from '../sync/eventBus.js';
import type { AppEnv } from '../types.js';

export function emitSync(c: Context<AppEnv>, input: SyncEventInput): void {
  const secret = c.get('projectSecret');
  if (secret !== '') emitEvent(secret, input);
}

/** Serialize a notes value (array or already-stringified) to the JSON-string
 *  shape the `tickets.notes` column / client reducer expect. */
export function notesToString(notes: unknown): string {
  return typeof notes === 'string' ? notes : JSON.stringify(notes);
}
