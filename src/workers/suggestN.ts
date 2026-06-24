// HS-8963 — AI-suggested worker count (docs/91 §91.6). A *recommendation* (the
// owner always sets the actual N): estimate how many tickets can progress
// independently in parallel right now from the Up Next set + the flat `blocked_by`
// graph (HS-8865), and recommend N = clamp(independentClusters, 1, POOL_MAX) + a
// one-line rationale. The estimate runs through the announcer's Anthropic plumbing
// (same key resolver + Messages-API/json-schema pattern as `summarize.ts`); when
// no key is configured it falls back to a deterministic cluster heuristic so the
// button still returns something useful (clearly labeled).
import os from 'os';
import { z } from 'zod';

import { BLOCKED_TICKET_IDS_SQL } from '../db/blockedBy.js';
import { getDb } from '../db/connection.js';
import { parseJsonOrNull, TagsArraySchema } from '../schemas.js';
import { callAnnouncerJson } from './announcerJson.js';

/** One pending ticket distilled for the estimator. */
export interface PendingTicketDigest {
  ticketNumber: string;
  title: string;
  category: string;
  tags: string[];
  /** Currently blocked by an unfinished `blocked_by` dependency (can't run yet). */
  blocked: boolean;
}

export interface SuggestionResult {
  /** Recommended worker count, clamped to [1, POOL_MAX] (or 0 when nothing to do). */
  n: number;
  /** One-line human rationale. */
  rationale: string;
  /** Where the number came from. */
  source: 'ai' | 'heuristic';
}

/** A small, machine-sensible ceiling on the recommendation (mirrors the Workflow
 *  concurrency-cap shape: CPU-cores − 2, floored at 1, hard-capped at 8 so a
 *  many-core box doesn't suggest a fleet). */
export function poolMax(): number {
  const cores = os.cpus().length || 4;
  return Math.max(1, Math.min(8, cores - 2));
}

/** Clamp a raw model/heuristic number into [1, max] (or 0 when there's no work). */
export function clampN(raw: number, max: number, hasWork: boolean): number {
  if (!hasWork) return 0;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(max, Math.round(raw)));
}

/** Build the compact text digest handed to the estimator. Lists the unblocked
 *  (claimable-now) tickets with their category/tags, plus a count of blocked ones
 *  for context. Exported for testing. */
export function buildSuggestDigest(tickets: readonly PendingTicketDigest[]): string {
  const unblocked = tickets.filter(t => !t.blocked);
  const blockedCount = tickets.length - unblocked.length;
  if (unblocked.length === 0) {
    return `No unblocked Up Next tickets${blockedCount > 0 ? ` (${String(blockedCount)} blocked by unfinished dependencies)` : ''}.`;
  }
  const lines = unblocked.map(t => {
    const meta = [t.category, ...t.tags].filter(s => s !== '').join(', ');
    return `- ${t.ticketNumber} [${meta}] ${t.title}`;
  });
  const blockedNote = blockedCount > 0 ? `\n\n(${String(blockedCount)} more Up Next ticket(s) are blocked by unfinished dependencies and can't run yet.)` : '';
  return `${String(unblocked.length)} unblocked Up Next tickets:\n${lines.join('\n')}${blockedNote}`;
}

/** Deterministic fallback when no AI key is configured: count independent clusters
 *  among the unblocked tickets by grouping on shared category/tags (tickets that
 *  share a category or any tag are assumed coupled → one cluster). Exported for
 *  testing. */
export function heuristicSuggestion(tickets: readonly PendingTicketDigest[], max: number): SuggestionResult {
  const unblocked = tickets.filter(t => !t.blocked);
  if (unblocked.length === 0) {
    return { n: 0, rationale: 'No unblocked Up Next tickets to work.', source: 'heuristic' };
  }
  // Union-find by shared category/tag: each distinct group is one parallel cluster.
  const keyToCluster = new Map<string, number>();
  let next = 0;
  const clusterOf: number[] = [];
  for (const t of unblocked) {
    const keys = [`cat:${t.category}`, ...t.tags.map(tag => `tag:${tag}`)];
    const existing = keys.map(k => keyToCluster.get(k)).find(c => c !== undefined);
    const cluster = existing ?? next++;
    clusterOf.push(cluster);
    for (const k of keys) keyToCluster.set(k, cluster);
  }
  const clusters = new Set(clusterOf).size;
  const n = clampN(clusters, max, true);
  return {
    n,
    rationale: `${String(unblocked.length)} unblocked, ~${String(clusters)} independent cluster${clusters === 1 ? '' : 's'} → ${String(n)} (no AI key — estimated).`,
    source: 'heuristic',
  };
}

const SuggestSchema = z.object({ n: z.number(), rationale: z.string() });

const SYSTEM_PROMPT = `You size a pool of parallel AI worker agents for a software project. Given the project's UNBLOCKED "Up Next" tickets (the ones ready to work now), estimate how many can make progress INDEPENDENTLY in parallel — i.e. the number of independent clusters of work, where tickets that touch the same area/feature (shared category, tags, or obviously the same code) are coupled and belong to one cluster (one worker), while unrelated tickets can run concurrently. Recommend a worker count = that independent-cluster count, clamped to the given maximum. Fewer is better when in doubt — a coupled change set should land on one worker/branch. Reply with the number and a terse one-line rationale like "6 unblocked, ~3 independent clusters -> 3".`;

/** JSON Schema for the structured `{n, rationale}` reply — used by the Anthropic
 *  `output_config` and Apple guided generation; the local path appends the contract
 *  as text (HS-8976). */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { n: { type: 'integer' }, rationale: { type: 'string' } },
  required: ['n', 'rationale'],
  additionalProperties: false,
};

/** A generic local model has no output-schema enforcement, so spell out the
 *  contract (mirrors `summarize.ts`'s `LOCAL_JSON_INSTRUCTION`). */
const LOCAL_JSON_INSTRUCTION = '\n\nOUTPUT FORMAT: respond with ONLY a single JSON object and nothing else (no prose, no code fence): {"n": <integer>, "rationale": "<one line>"}.';

/** Validate the model's JSON into a clamped result. Exported for testing. */
export function parseSuggestion(text: string, max: number, hasWork: boolean): SuggestionResult | null {
  const parsed = parseJsonOrNull(SuggestSchema, text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
  if (parsed === null) return null;
  return { n: clampN(parsed.n, max, hasWork), rationale: parsed.rationale, source: 'ai' };
}

/** Fetch the project's pending tickets (Up Next, actionable) + their blocked flag. */
async function fetchPending(): Promise<PendingTicketDigest[]> {
  const db = await getDb();
  const rows = (await db.query<{ ticket_number: string; title: string; category: string; tags: string; blocked: boolean }>(
    `SELECT ticket_number, title, category, tags,
            (id IN (${BLOCKED_TICKET_IDS_SQL})) AS blocked
       FROM tickets
      WHERE up_next = TRUE AND status NOT IN ('completed','verified','deleted','archive')
      ORDER BY id DESC`,
  )).rows;
  return rows.map(r => ({
    ticketNumber: r.ticket_number,
    title: r.title,
    category: r.category,
    tags: parseJsonOrNull(TagsArraySchema, r.tags) ?? [],
    blocked: r.blocked,
  }));
}

/** Recommend a worker count for the current Up Next set. Uses the configured AI
 *  provider (Anthropic / local / Apple, HS-8976, via `callAnnouncerJson`); falls
 *  back to the deterministic cluster heuristic when no provider can run or the AI
 *  errors / returns garbage. */
export async function suggestWorkerCount(): Promise<SuggestionResult> {
  const tickets = await fetchPending();
  const max = poolMax();
  const hasWork = tickets.some(t => !t.blocked);
  if (!hasWork) {
    return { n: 0, rationale: 'No unblocked Up Next tickets to work.', source: 'heuristic' };
  }

  const material = `${buildSuggestDigest(tickets)}\n\nMaximum workers: ${String(max)}.`;
  try {
    const text = await callAnnouncerJson(SYSTEM_PROMPT, material, OUTPUT_SCHEMA, LOCAL_JSON_INSTRUCTION, 512);
    if (text !== null) {
      const parsed = parseSuggestion(text, max, hasWork);
      if (parsed !== null) return parsed;
    }
  } catch {
    // AI unavailable / errored → fall back to the deterministic estimate.
  }
  return heuristicSuggestion(tickets, max);
}
