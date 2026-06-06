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
import { getTelemetryDb } from '../db/connection.js';
import { eventNameMatchSql } from '../db/otelRollups.js';

/** A rendered telemetry signal line + its timestamp (for chronological merge). */
export interface TelemetryLine { at: string; text: string }

/** When there's no cursor, only look this far back — mid-task narration cares
 *  about *now*, and the full telemetry history would swamp the summarizer. */
const NO_CURSOR_LOOKBACK_MS = 30 * 60 * 1000;

/** Max characters of a user prompt we feed the summarizer (it's a snippet, not
 *  the whole prompt — the summarizer only needs the gist of what's underway). */
const PROMPT_SNIPPET_LEN = 200;

interface PromptRow { at: string; prompt_id: string | null; body: string | null }
interface ToolRow { prompt_id: string | null; tool: string | null; n: bigint | number }

/**
 * Collect recent in-progress telemetry signals for a project since `since`
 * (ISO; null → the last 30 min). Returns one line per user-prompt turn —
 * "working on: <snippet> (used Bash ×3, Edit ×2)" — plus a catch-all line for
 * tool activity whose prompt turn started before the window. Empty array when
 * there's no telemetry (caller simply contributes nothing).
 */
export async function collectTelemetrySignals(projectSecret: string, since: string | null): Promise<TelemetryLine[]> {
  const db = await getTelemetryDb();
  const sinceClause = since !== null ? '$2::timestamptz' : `NOW() - INTERVAL '${String(NO_CURSOR_LOOKBACK_MS)} milliseconds'`;
  const params: string[] = since !== null ? [projectSecret, since] : [projectSecret];

  const prompts = await db.query<PromptRow>(
    `SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
            prompt_id,
            COALESCE(body_json->>'prompt', body_json->>'message', body_json->>'body', body_json::text) AS body
       FROM otel_events
      WHERE project_secret = $1 AND ts >= ${sinceClause}
        AND ${eventNameMatchSql('event_name', 'user_prompt')}
      ORDER BY ts ASC`,
    params,
  );

  const tools = await db.query<ToolRow>(
    `SELECT prompt_id, attributes_json->>'tool_name' AS tool, COUNT(*) AS n
       FROM otel_events
      WHERE project_secret = $1 AND ts >= ${sinceClause}
        AND ${eventNameMatchSql('event_name', 'tool_result')}
      GROUP BY prompt_id, attributes_json->>'tool_name'`,
    params,
  );

  // Tool counts grouped by the prompt turn they belong to.
  const toolsByPrompt = new Map<string, Map<string, number>>();
  for (const t of tools.rows) {
    const tool = (t.tool ?? '').trim();
    if (tool === '') continue;
    const key = t.prompt_id ?? '(none)';
    const m = toolsByPrompt.get(key) ?? new Map<string, number>();
    m.set(tool, (m.get(tool) ?? 0) + Number(t.n));
    toolsByPrompt.set(key, m);
  }

  const lines: TelemetryLine[] = [];
  const turnsWithPrompt = new Set<string>();
  for (const p of prompts.rows) {
    const snippet = promptSnippet(p.body);
    if (snippet === '') continue;
    const key = p.prompt_id ?? '(none)';
    turnsWithPrompt.add(key);
    const toolPart = formatTools(toolsByPrompt.get(key));
    lines.push({ at: p.at, text: `[in progress] working on: "${snippet}"${toolPart === '' ? '' : ` (used ${toolPart})`}` });
  }

  // Tool activity for turns whose user_prompt is outside the window (started
  // before the cursor) — fold into one catch-all line so it isn't lost.
  const orphanTools = new Map<string, number>();
  for (const [key, m] of toolsByPrompt) {
    if (turnsWithPrompt.has(key)) continue;
    for (const [tool, n] of m) orphanTools.set(tool, (orphanTools.get(tool) ?? 0) + n);
  }
  const orphanPart = formatTools(orphanTools);
  if (orphanPart !== '') {
    lines.push({ at: new Date().toISOString(), text: `[in progress] ongoing work (used ${orphanPart})` });
  }

  return lines;
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
