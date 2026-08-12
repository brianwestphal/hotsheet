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

    const thread = typeof attrsOf(e)[g.threadAttr] === 'string' ? attrsOf(e)[g.threadAttr] as string : '';
    if (name === g.turnStartEvent) {
      // A turn-start with no thread id falls back to session, then a constant, so
      // the epoch-ms tail still keeps successive turns distinct.
      const anchor = thread !== '' ? thread : (str(e, 'session_id') || 'session');
      const ms = new Date(str(e, 'ts')).getTime();
      const id = `${g.turnIdPrefix}.${anchor}.${Number.isFinite(ms) ? String(ms) : '0'}`;
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
