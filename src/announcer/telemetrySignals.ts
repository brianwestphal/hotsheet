/**
 * §78 Announcer — mid-task narration signal source (HS-8789, "option A").
 *
 * The after-the-fact collector (`collectSignals.ts`) only sees work AFTER a unit
 * lands (completion notes / status / command-log). To make live mode "more live"
 * the live generator also feeds the **§67 telemetry event stream** — the
 * `user_prompt` and `tool_result` events Claude Code emits *while it works*
 * (~every few seconds) — so narration can describe in-progress activity.
 *
 * This module reads those events from the shared telemetry DB (`getTelemetryDb`,
 * keyed by `project_secret`) since a cursor and renders them as a few chronological
 * text lines, **grouped by user-prompt turn** so a burst of tool calls becomes one
 * line, not dozens. It deliberately does NOT decide what's worth narrating — the
 * summarizer rates importance and drops the uninteresting (HS-8789), so this stays
 * a dumb, deterministic, unit-testable collector.
 *
 * Privacy: prompt text is user-authored (same trust class as the notes the
 * announcer already sends) and trimmed to a snippet; tool activity is just tool
 * names + counts. Nothing here is sent unless the live lease is held AND telemetry
 * is enabled for the project (gated by the caller).
 */
import { centralTelemetryDataDir, currentTelemetryClusterDir, runWithTelemetryDb } from '../db/connection.js';
import { readOtelJsonlRange } from '../db/otelJsonlStore.js';
import { serverLocalDay } from '../db/otelRollupIngest.js';
import { isClaudeCodeEvent } from '../db/otelRollups.js';
import { getProjectBySecret } from '../projects.js';

/** A rendered telemetry signal line + its timestamp (for chronological merge). */
export interface TelemetryLine { at: string; text: string }

/** When there's no cursor, only look this far back — mid-task narration cares
 *  about *now*, and the full telemetry history would swamp the summarizer. */
const NO_CURSOR_LOOKBACK_MS = 30 * 60 * 1000;

/** Max characters of a user prompt we feed the summarizer (it's a snippet, not
 *  the whole prompt — the summarizer only needs the gist of what's underway). */
const PROMPT_SNIPPET_LEN = 200;

interface PromptRow { at: string; prompt_id: string | null; body: string | null }

/**
 * Collect recent in-progress telemetry signals for a project since `since`
 * (ISO; null → the last 30 min). Returns one line per user-prompt turn —
 * "working on: <snippet> (used Bash ×3, Edit ×2)". Empty array when there's no
 * telemetry (caller simply contributes nothing).
 *
 * HS-8806 — tool activity whose prompt turn started BEFORE the window is
 * deliberately NOT emitted: with no prompt context it's pure tool churn ("used
 * Read, Bash, Edit"), which the summarizer turned into valueless entries like
 * "Read Bash Edit". A narration line needs the user-prompt context to be a
 * cohesive summary, so only turns with an in-window prompt contribute.
 */
export async function collectTelemetrySignals(projectSecret: string, since: string | null): Promise<TelemetryLine[]> {
  // HS-8874 — read THIS project's own telemetry DB (telemetry is per-project
  // now). The live generator runs outside the request context, so resolve the
  // project's dataDir from its secret and bind it explicitly.
  const project = getProjectBySecret(projectSecret);
  const dataDir = project !== undefined ? project.dataDir : centralTelemetryDataDir();
  return runWithTelemetryDb(dataDir, () => collectTelemetrySignalsFromCurrentDb(projectSecret, since));
}

async function collectTelemetrySignalsFromCurrentDb(projectSecret: string, since: string | null): Promise<TelemetryLine[]> {
  // HS-9286 — read recent events from the day-partitioned JSONL store instead of
  // raw `otel_events` (the same `currentTelemetryClusterDir()` store the §68 detail
  // reads use since HS-9278), so this survives the HS-9280 raw-table drop. The SQL
  // WHERE (project + `ts >= since` + event-name match) and the GROUP BY move into
  // JS over the JSONL rows.
  const dir = currentTelemetryClusterDir();
  const sinceMs = since !== null ? Date.parse(since) : Date.now() - NO_CURSOR_LOOKBACK_MS;
  // Day-range for the JSONL files (server-local day = the partition key). `toDay`
  // is today; missing/older days contribute nothing.
  const rows = await readOtelJsonlRange(dir, 'events', serverLocalDay(new Date(sinceMs)), serverLocalDay(new Date()));

  const promptRows: PromptRow[] = [];
  // Tool counts grouped by the prompt turn they belong to.
  const toolsByPrompt = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.project_secret !== projectSecret) continue;
    const at = typeof r.ts === 'string' ? r.ts : null;
    if (at === null || Date.parse(at) < sinceMs) continue;
    const eventName = typeof r.event_name === 'string' ? r.event_name : '';
    const promptId = typeof r.prompt_id === 'string' ? r.prompt_id : null;
    if (isClaudeCodeEvent(eventName, 'user_prompt')) {
      promptRows.push({ at, prompt_id: promptId, body: extractPromptBody(r.body_json) });
    } else if (isClaudeCodeEvent(eventName, 'tool_result')) {
      const attrs = r.attributes_json;
      const raw = attrs !== null && typeof attrs === 'object' ? (attrs as Record<string, unknown>).tool_name : null;
      const tool = typeof raw === 'string' ? raw.trim() : '';
      if (tool === '') continue;
      const key = promptId ?? '(none)';
      const m = toolsByPrompt.get(key) ?? new Map<string, number>();
      m.set(tool, (m.get(tool) ?? 0) + 1);
      toolsByPrompt.set(key, m);
    }
  }
  // Mirror the old `ORDER BY ts ASC` (JSONL is day-then-append order — sort to be exact).
  promptRows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const lines: TelemetryLine[] = [];
  for (const p of promptRows) {
    const snippet = promptSnippet(p.body);
    if (snippet === '') continue;
    const key = p.prompt_id ?? '(none)';
    const toolPart = formatTools(toolsByPrompt.get(key));
    lines.push({ at: p.at, text: `[in progress] working on: "${snippet}"${toolPart === '' ? '' : ` (used ${toolPart})`}` });
  }

  // HS-8806 — intentionally NO orphan-tool catch-all line. Tool activity whose
  // user_prompt is outside the window has no cohesive context to narrate (it
  // became valueless "Read Bash Edit" entries); we drop it rather than feed the
  // summarizer raw tool churn.

  return lines;
}

/**
 * JS analogue of the old prompt-body COALESCE (prompt / message / body, then the
 * whole record as text). Mirrors PostgreSQL's `->>` semantics: a JSON SCALAR
 * (string / number / boolean) renders to text; an object / array / null value
 * yields SQL null and falls through to the next key, then to the serialized
 * record. Returns null when there's nothing.
 */
function extractPromptBody(bodyJson: unknown): string | null {
  if (bodyJson === null || bodyJson === undefined) return null;
  if (typeof bodyJson === 'string') return bodyJson;
  if (typeof bodyJson === 'number' || typeof bodyJson === 'boolean') return String(bodyJson);
  if (typeof bodyJson !== 'object') return null; // symbol / function / bigint — not real JSON
  const o = bodyJson as Record<string, unknown>;
  for (const k of ['prompt', 'message', 'body'] as const) {
    const v = o[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return JSON.stringify(bodyJson);
}

/** Trim a prompt body to a single-line snippet, stripping the hotsheet ticket
 *  marker comment the channel injects (it's noise to the listener). */
function promptSnippet(body: string | null): string {
  if (body === null) return '';
  const cleaned = body.replace(/<!--\s*hotsheet:ticket=[^>]*-->/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return '';
  return cleaned.length > PROMPT_SNIPPET_LEN
    ? cleaned.slice(0, PROMPT_SNIPPET_LEN - 1).replace(/\s+\S*$/, '').trimEnd() + '…'
    : cleaned;
}

/** "Bash ×3, Edit ×2", most-used first; '' when there are none. */
function formatTools(m: Map<string, number> | undefined): string {
  if (m === undefined || m.size === 0) return '';
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => (n > 1 ? `${tool} ×${String(n)}` : tool))
    .join(', ');
}
