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

const SYSTEM_PROMPT = `You partition a set of UNBLOCKED "Up Next" tickets across a fixed set of named AI worker agents for a software project. Group small, RELATED tickets (shared area/feature — same category, tags, or obviously the same code) onto the SAME worker so a coherent change set lands together on one worker's branch; spread unrelated work across different workers to parallelize. ISOLATE large or risky tickets — migrations, refactors/rewrites, anything touching a hot or shared module — onto their OWN worker (a chunk of one) so a failure or nasty conflict stays contained. Never put a ticket in the same chunk as one of its own dependencies. Assign EVERY ticket to exactly ONE worker (no ticket left out, none duplicated); a worker may get zero tickets if there isn't enough independent work. Return one assignment entry per worker using its exact label, listing the ticket numbers (e.g. "HS-12").`;

/** Empty assignment list, one entry per worker (for the no-AI / no-work paths). */
function emptyAssignments(workers: readonly WorkerRefInput[]): PartitionAssignment[] {
  return workers.map(w => ({ worker: w.worker, label: w.label, ticketIds: [], ticketNumbers: [] }));
}

/** Deterministic round-robin the tickets across workers in order. Kept as a
 *  low-level utility; `clusterPartition` (HS-9073) is the default deterministic
 *  split. Exported for testing. */
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

/** Title keywords that mark a ticket as large/risky → isolate it onto its own
 *  chunk so a failure or nasty conflict stays contained (docs/98 §98.2). */
const RISKY_TITLE_RE = /\b(migrat\w+|refactor\w*|rewrite\w*|overhaul\w*|redesign\w*|re-?architect\w*|breaking|upgrade\w+)\b/i;

function isRiskyOrLarge(row: PendingTicketRow): boolean {
  return RISKY_TITLE_RE.test(row.title);
}

/**
 * HS-9073 (docs/98 §98.2-98.4) — the deterministic clustering partition: group
 * small, RELATED tickets (sharing a tag) into the SAME worker chunk and ISOLATE
 * large/risky tickets onto their own chunk, then balance the chunks across
 * workers (greedy least-loaded). Replaces the naive round-robin-by-index so the
 * default split lands coherent change sets together instead of scattering related
 * work across N branches. Exported for testing.
 *
 * The unblocked Up Next set is already free of intra-set `blocked_by` edges (a
 * ticket blocked by a non-completed dependency is excluded by `fetchUnblocked`),
 * so §98.2's "never co-batch a ticket with its own dependency" rule is
 * structurally satisfied here; the AI path (which sees the broader set) gets it
 * via the system prompt.
 */
export function clusterPartition(rows: readonly PendingTicketRow[], workers: readonly WorkerRefInput[]): PartitionAssignment[] {
  const out = emptyAssignments(workers);
  if (workers.length === 0 || rows.length === 0) return out;

  // Risky/large tickets each become their own cluster; the rest cluster by tag.
  const clusters: PendingTicketRow[][] = [];
  const normal: PendingTicketRow[] = [];
  for (const r of rows) {
    if (isRiskyOrLarge(r)) clusters.push([r]);
    else normal.push(r);
  }

  // Union-find over `normal` by shared tag (two tickets that share any tag merge).
  const parent = new Map<number, number>(normal.map(r => [r.id, r.id]));
  const find = (x: number): number => {
    let root = x;
    for (;;) {
      const p = parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    let cur = x; // path-compress
    for (;;) {
      const p = parent.get(cur);
      if (p === undefined || p === root) break;
      parent.set(cur, root);
      cur = p;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const tagFirst = new Map<string, number>();
  for (const r of normal) {
    for (const tag of r.tags) {
      const seen = tagFirst.get(tag);
      if (seen === undefined) tagFirst.set(tag, r.id);
      else union(seen, r.id);
    }
  }
  // Group `normal` by cluster root, preserving first-seen order.
  const byRoot = new Map<number, PendingTicketRow[]>();
  for (const r of normal) {
    const root = find(r.id);
    const arr = byRoot.get(root);
    if (arr === undefined) byRoot.set(root, [r]); else arr.push(r);
  }
  clusters.push(...byRoot.values());

  // Greedy balance: assign the largest clusters first to the least-loaded worker
  // (stable: ties broken by the cluster's original order, then the lowest worker
  // index) so a coherent chunk stays intact on one worker.
  const order = clusters.map((c, i) => ({ c, i }));
  order.sort((a, b) => b.c.length - a.c.length || a.i - b.i);
  const load = out.map(() => 0);
  for (const { c } of order) {
    let best = 0;
    for (let i = 1; i < out.length; i++) if (load[i] < load[best]) best = i;
    for (const r of c) { out[best].ticketIds.push(r.id); out[best].ticketNumbers.push(r.ticketNumber); }
    load[best] += c.length;
  }
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
 *  provider is configured, else the deterministic `clusterPartition`. HS-9080 —
 *  `opts.tag` scopes it to tickets carrying that tag ("Parallelize tag…"). */
export async function partitionTickets(
  workers: readonly WorkerRefInput[],
  opts: { tag?: string } = {},
): Promise<PartitionAssignment[]> {
  if (workers.length === 0) return [];
  let rows = await fetchUnblocked();
  if (opts.tag !== undefined && opts.tag !== '') {
    const tag = opts.tag;
    rows = rows.filter(r => r.tags.includes(tag));
  }
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
    // AI unavailable / errored → deterministic clustering split.
  }
  return clusterPartition(rows, workers);
}
