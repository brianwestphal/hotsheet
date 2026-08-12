// HS-9623 — synthesize a per-turn `prompt_id` for tools that don't stamp Claude's
// `prompt.id`, so the docs/68 timeline (recent-prompts list + per-prompt
// drilldown) can cluster their events into "prompts". Registry-driven off each
// tool's `promptGrouping` spec (§132) — a tool opts in by declaring the spec,
// nothing here branches on a tool id.
//
// Why READ time, not ingest: the anchor is a tool *turn* (one `user_prompt`
// through the following `response.completed`), but codex's `api_request` records
// carry NO correlation id at all — not even `conversation.id` — so they can only
// be attached to a turn by timestamp order within the turn's window, which needs
// every event of the turn visible at once. Ingest sees one record at a time
// across many POST batches, so it cannot do this without cross-batch state; a
// read pass over the day-partitioned JSONL sees them all. The synthesized id is
// DETERMINISTIC from the turn-start event (`<prefix>.<thread>.<epochMs>`), so the
// recent-prompts list and the drilldown independently compute the SAME id for a
// given turn and the drilldown's `prompt_id === id` filter matches.

import { listPlugins } from '../aiTools/registry.js';

interface Grouper {
  readonly prefix: string;
  readonly threadAttr: string;
  readonly turnStartEvent: string;
  readonly turnIdPrefix: string;
}

/** Grouping specs from the registry, each paired with the emitting tool's
 *  namespace prefix so a record can be matched to its tool by `event_name`. */
function groupers(): Grouper[] {
  return listPlugins()
    .flatMap(p => {
      const g = p.promptGrouping;
      const prefix = p.telemetryMetricPrefix;
      if (g === undefined || prefix === undefined || prefix === '') return [];
      return [{ prefix, threadAttr: g.threadAttr, turnStartEvent: g.turnStartEvent, turnIdPrefix: g.turnIdPrefix }];
    });
}

function str(rec: Record<string, unknown>, key: string): string {
  return typeof rec[key] === 'string' ? rec[key] : '';
}

function attrsOf(e: Record<string, unknown>): Record<string, unknown> {
  const a = e.attributes_json;
  return a !== null && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {};
}

/**
 * The synthetic id for a turn-START record: `<prefix>.<anchor>.<epochMs>`, where
 * `anchor` is the thread id (`conversation.id`), falling back to the session id,
 * then a constant — the `epochMs` tail keeps successive turns distinct even under
 * the fallback. Derivable from a SINGLE record, which is what lets both the
 * read-time synthesis and the ingest-time distinct-turn count (HS-9624) compute
 * the SAME id for a turn. `ts.getTime()` and `new Date(ts.toISOString()).getTime()`
 * agree to the ms (ingest truncates nanos to ms before storing), so the two paths
 * cannot diverge.
 */
function turnStartId(g: Pick<Grouper, 'threadAttr' | 'turnIdPrefix'>, attrs: Record<string, unknown>, ts: Date, sessionId: string): string {
  const thread = typeof attrs[g.threadAttr] === 'string' ? attrs[g.threadAttr] as string : '';
  const anchor = thread !== '' ? thread : (sessionId !== '' ? sessionId : 'session');
  const ms = ts.getTime();
  return `${g.turnIdPrefix}.${anchor}.${Number.isFinite(ms) ? String(ms) : '0'}`;
}

/**
 * The synthetic per-turn prompt id for a turn-START event (codex `user_prompt`),
 * or `null` when the event is not any registered tool's turn-start. Unlike a
 * mid-turn event (a codex `api_request` carries no correlation id), a turn-start
 * is self-identifying, so INGEST can compute the same id the read-time synthesis
 * would — used by HS-9624 to mark the turn in the daily/hourly distinct-prompt set
 * so codex turns are counted like Claude prompts.
 */
export function syntheticTurnIdForEvent(
  eventName: string,
  attrs: Record<string, unknown>,
  ts: Date,
  sessionId: string | null,
): string | null {
  for (const g of groupers()) {
    if (eventName === g.turnStartEvent) return turnStartId(g, attrs, ts, sessionId ?? '');
  }
  return null;
}

/**
 * Fill in a synthetic `prompt_id` (IN PLACE) on every event that lacks a real one
 * but belongs to a tool with a `promptGrouping` spec. Events that already carry a
 * `prompt_id` (Claude) and events from tools without a spec are left untouched, so
 * this is a no-op for a Claude-only project and safe to call unconditionally.
 *
 * Turn assignment, per grouped tool, walking events in timestamp order:
 *  - a `turnStartEvent` (codex `user_prompt`) opens a new turn and takes a fresh
 *    synthetic id;
 *  - any other grouped event joins the most recent open turn for its own thread
 *    (`conversation.id`) when it has one, else the most recent open turn overall
 *    — the fallback that lets a thread-less `api_request` attach by time order.
 *
 * The single-project caveat is real but bounded: `api_request` (no thread) is
 * correlated by global time order, so two truly-concurrent turns could cross
 * wires. Codex telemetry is routed to a PER-PROJECT cluster (it always carries
 * `hotsheet_project`), so a cluster holds one project's stream, and concurrent
 * turns within it were accepted as a documented risk on HS-9623.
 */
export function fillSyntheticPromptIds(events: Record<string, unknown>[]): void {
  const specs = groupers();
  if (specs.length === 0) return;

  // Walk in ts order without reordering the caller's array (downstream code keeps
  // its own order). Stable on equal timestamps via the original index.
  const order = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => str(a.e, 'ts').localeCompare(str(b.e, 'ts')) || a.i - b.i);

  const lastTurnByThread = new Map<string, string>();
  let lastTurnGlobal: string | null = null;

  for (const { e } of order) {
    if (str(e, 'prompt_id') !== '') continue; // real prompt id — Claude, untouched
    const name = str(e, 'event_name');
    const g = specs.find(s => name.startsWith(s.prefix));
    if (g === undefined) continue;

    const attrs = attrsOf(e);
    const thread = typeof attrs[g.threadAttr] === 'string' ? attrs[g.threadAttr] as string : '';
    if (name === g.turnStartEvent) {
      // Same id the ingest-time distinct-turn count computes — see `turnStartId`.
      const id = turnStartId(g, attrs, new Date(str(e, 'ts')), str(e, 'session_id'));
      if (thread !== '') lastTurnByThread.set(thread, id);
      lastTurnGlobal = id;
      e.prompt_id = id;
    } else {
      const id = (thread !== '' ? lastTurnByThread.get(thread) : undefined) ?? lastTurnGlobal;
      // Events before any turn-start (a stray leading api_request) stay ungrouped.
      if (id !== null) e.prompt_id = id;
    }
  }
}
