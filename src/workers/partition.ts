// HS-8965 — AI "partition into N coherent chunks" dispatch helper (docs/92 §92.6).
// A convenience over manual drag-to-worker: group the unblocked Up Next tickets
// into one chunk per live worker (related tickets — shared area/tags/category —
// onto the same worker so a coherent change set lands on one branch), so the owner
// can review + apply in one shot (each chunk dispatched via the §92 claim-by-id
// path). Reuses the HS-8963/8976 announcer-provider plumbing; falls back to a
// deterministic round-robin when no AI provider can run or the AI errors.
import { z } from 'zod';

import { BLOCKED_TICKET_IDS_SQL } from '../db/blockedBy.js';
import { getDb } from '../db/connection.js';
import { parseJsonOrNull, TagsArraySchema } from '../schemas.js';
import { callAnnouncerJson } from './announcerJson.js';
import { buildSuggestDigest, type PendingTicketDigest } from './suggestN.js';

/** A live worker to partition tickets across. */
export interface WorkerRefInput { worker: string; label: string }

/** A row from the unblocked Up Next set. */
export interface PendingTicketRow extends PendingTicketDigest { id: number }

/** One worker's assigned chunk. `ticketIds` / `ticketNumbers` are parallel. */
export interface PartitionAssignment {
  worker: string;
  label: string;
  ticketIds: number[];
  ticketNumbers: string[];
}

const PARTITION_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          worker: { type: 'string' },
          tickets: { type: 'array', items: { type: 'string' } },
        },
        required: ['worker', 'tickets'],
        additionalProperties: false,
      },
    },
  },
  required: ['assignments'],
  additionalProperties: false,
};

const PartitionJsonSchema = z.object({
  assignments: z.array(z.object({ worker: z.string(), tickets: z.array(z.string()) })),
});

const LOCAL_JSON_INSTRUCTION = '\n\nOUTPUT FORMAT: respond with ONLY a single JSON object and nothing else (no prose, no code fence): {"assignments":[{"worker":"<label>","tickets":["HS-1","HS-2"]}]}. One entry per worker; assign every ticket to exactly one worker.';

const SYSTEM_PROMPT = `You partition a set of UNBLOCKED "Up Next" tickets across a fixed set of named AI worker agents for a software project. Group RELATED tickets (shared area/feature — same category, tags, or obviously the same code) onto the SAME worker so a coherent change set lands together on one worker's branch; spread unrelated work across different workers to parallelize. Assign EVERY ticket to exactly ONE worker (no ticket left out, none duplicated); a worker may get zero tickets if there isn't enough independent work. Return one assignment entry per worker using its exact label, listing the ticket numbers (e.g. "HS-12").`;

/** Empty assignment list, one entry per worker (for the no-AI / no-work paths). */
function emptyAssignments(workers: readonly WorkerRefInput[]): PartitionAssignment[] {
  return workers.map(w => ({ worker: w.worker, label: w.label, ticketIds: [], ticketNumbers: [] }));
}

/** Deterministic fallback: round-robin the tickets across workers in order.
 *  Exported for testing. */
export function roundRobinPartition(rows: readonly PendingTicketRow[], workers: readonly WorkerRefInput[]): PartitionAssignment[] {
  const out = emptyAssignments(workers);
  if (workers.length === 0) return out;
  rows.forEach((row, i) => {
    const slot = out[i % workers.length];
    slot.ticketIds.push(row.id);
    slot.ticketNumbers.push(row.ticketNumber);
  });
  return out;
}

/** Parse the model's assignment JSON into per-worker chunks, mapping ticket
 *  numbers back to ids and dropping unknown/duplicate tickets + unknown workers.
 *  Returns null on malformed output (caller falls back to round-robin). Exported
 *  for testing. */
export function parsePartition(text: string, rows: readonly PendingTicketRow[], workers: readonly WorkerRefInput[]): PartitionAssignment[] | null {
  const parsed = parseJsonOrNull(PartitionJsonSchema, text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
  if (parsed === null) return null;
  const byLabel = new Map(workers.map(w => [w.label, w]));
  const rowByNumber = new Map(rows.map(r => [r.ticketNumber, r]));
  const out = emptyAssignments(workers);
  const slotByLabel = new Map(out.map(a => [a.label, a]));
  const taken = new Set<string>();
  for (const a of parsed.assignments) {
    const slot = slotByLabel.get(a.worker);
    if (slot === undefined || !byLabel.has(a.worker)) continue; // unknown worker
    for (const num of a.tickets) {
      const row = rowByNumber.get(num);
      if (row === undefined || taken.has(num)) continue; // unknown / already assigned
      taken.add(num);
      slot.ticketIds.push(row.id);
      slot.ticketNumbers.push(row.ticketNumber);
    }
  }
  return out;
}

/** Fetch the unblocked Up Next tickets (with ids, for dispatch). */
async function fetchUnblocked(): Promise<PendingTicketRow[]> {
  const db = await getDb();
  const rows = (await db.query<{ id: number; ticket_number: string; title: string; category: string; tags: string }>(
    `SELECT id, ticket_number, title, category, tags
       FROM tickets
      WHERE up_next = TRUE AND status NOT IN ('completed','verified','deleted','archive')
        AND id NOT IN (${BLOCKED_TICKET_IDS_SQL})
      ORDER BY id DESC`,
  )).rows;
  return rows.map(r => ({
    id: r.id,
    ticketNumber: r.ticket_number,
    title: r.title,
    category: r.category,
    tags: parseJsonOrNull(TagsArraySchema, r.tags) ?? [],
    blocked: false,
  }));
}

/** Partition the current unblocked Up Next set across `workers`. AI when a
 *  provider is configured, else a deterministic round-robin. */
export async function partitionTickets(workers: readonly WorkerRefInput[]): Promise<PartitionAssignment[]> {
  if (workers.length === 0) return [];
  const rows = await fetchUnblocked();
  if (rows.length === 0) return emptyAssignments(workers);

  const material = `${buildSuggestDigest(rows)}\n\nWorkers (assign tickets across these exact labels): ${workers.map(w => w.label).join(', ')}.`;
  try {
    const text = await callAnnouncerJson(SYSTEM_PROMPT, material, PARTITION_SCHEMA, LOCAL_JSON_INSTRUCTION);
    if (text !== null) {
      const parsed = parsePartition(text, rows, workers);
      // Use the AI partition only if it actually placed at least one ticket;
      // otherwise fall back so the owner gets a usable distribution.
      if (parsed !== null && parsed.some(a => a.ticketIds.length > 0)) return parsed;
    }
  } catch {
    // AI unavailable / errored → deterministic round-robin.
  }
  return roundRobinPartition(rows, workers);
}
