/**
 * §78 Announcer (HS-8745) — collect the raw "work signals" since a cursor and
 * assemble them into a deterministic text payload for the summarizer.
 *
 * Per the HS-8744 spike, the high-quality material is (a) the structured
 * completion / ticket notes the agent already writes and (b) the §14 command
 * log. This module gathers both since `since` (null = everything), orders them
 * chronologically, and renders a plain-text block — no AI here, so it's fully
 * unit-testable. Attachments / raw code are intentionally NOT included (privacy
 * + the notes are already summaries).
 */
import { getLogEntries } from '../db/commandLog.js';
import { getDb } from '../db/connection.js';
import { parseNotes } from '../db/notes.js';

export interface CollectedSignals {
  /** The assembled text material for the summarizer (empty string = nothing new). */
  material: string;
  /** Number of distinct signals gathered (notes + status changes + log events). */
  count: number;
  /** Start of the covered window (the cursor), or null when summarizing all history. */
  coversFrom: string | null;
  /** End of the covered window (when collection ran). */
  coversTo: string;
}

interface TicketRow {
  ticket_number: string;
  title: string;
  status: string;
  completed_at: string | null;
  updated_at: string;
  notes: string | null;
}

interface TimedLine {
  at: string;
  text: string;
}

/**
 * Cap on the assembled material handed to the summarizer. The Anthropic Messages
 * API rejects prompts over 1,000,000 input tokens with a 400 — HS-8752: a
 * project with a long history produced ~1.67M tokens of signals on a
 * from-scratch (`since === null`) generate, so the whole "Listen" failed with
 * "Summarization failed: prompt is too long". We bound the material well under
 * that limit, keeping the MOST RECENT signals (an after-the-fact briefing cares
 * about what just happened) and dropping older ones behind an explicit elision
 * marker so the summarizer knows the window was trimmed. This is the static form
 * of §78.4.1's "adaptive compression under backlog".
 *
 * ~3 chars/token deliberately OVER-estimates tokens for typical prose (~4
 * chars/token), so the char budget never undershoots the real token count even
 * for denser code/identifier text.
 */
export const MAX_INPUT_TOKENS = 600_000;
const CHARS_PER_TOKEN = 3;
const MAX_MATERIAL_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;
const ELISION_MARKER = '[…older work omitted to fit the summarization budget; the signals below are the most recent…]';

/**
 * Join the (chronological, oldest→newest) signal texts into the material block,
 * bounding it to `MAX_MATERIAL_CHARS`. Under budget → the full join. Over budget
 * → keep the newest lines that fit, prefixed with `ELISION_MARKER`. A single
 * line larger than the whole budget is itself tail-truncated so we always emit
 * something narratable.
 */
export function capMaterial(texts: string[]): string {
  const full = texts.join('\n');
  if (full.length <= MAX_MATERIAL_CHARS) return full;

  const budget = MAX_MATERIAL_CHARS - ELISION_MARKER.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    const cost = texts[i].length + 1; // + the joining newline
    if (used + cost > budget) {
      // The newest single line alone overflows the budget: keep its tail so the
      // material isn't just the marker. Otherwise we've kept all we can fit.
      if (kept.length === 0) kept.unshift(texts[i].slice(-budget));
      break;
    }
    used += cost;
    kept.unshift(texts[i]);
  }
  return [ELISION_MARKER, ...kept].join('\n');
}

/**
 * Gather work signals since `since` (ISO string; null = all non-deleted tickets'
 * notes + the full command log) and render them as a chronological text block.
 */
export async function collectWorkSignals(since: string | null): Promise<CollectedSignals> {
  const coversTo = new Date().toISOString();
  const db = await getDb();

  // Tickets touched since the cursor (or all non-deleted). We read their notes
  // and keep only the note entries written at/after `since` so we narrate fresh
  // work, not the whole history of an old ticket that happened to be re-touched.
  const ticketWhere = since === null
    ? `status != 'deleted'`
    : `status != 'deleted' AND updated_at >= $1`;
  const ticketParams = since === null ? [] : [since];
  const ticketRes = await db.query<TicketRow>(
    `SELECT ticket_number, title, status, completed_at, updated_at, notes
       FROM tickets WHERE ${ticketWhere} ORDER BY updated_at ASC`,
    ticketParams,
  );

  const lines: TimedLine[] = [];

  for (const t of ticketRes.rows) {
    const freshNotes = parseNotes(t.notes).filter(n => since === null || n.created_at >= since);
    for (const n of freshNotes) {
      lines.push({ at: n.created_at, text: `[${t.ticket_number} "${t.title}" — note] ${n.text}` });
    }
    // A completion that happened within the window is itself a signal worth
    // narrating even if no note was attached. `completed_at` comes back in the
    // DB's TIMESTAMPTZ wire format (`2026-06-05 14:00:00+00`), so compare via
    // Date — a lexical string compare against an ISO cursor mis-orders on the
    // space-vs-`T` separator. Normalize the emitted timestamp to ISO too so the
    // chronological sort below is consistent with the note/activity ISO stamps.
    if (t.completed_at !== null) {
      const completedIso = new Date(t.completed_at).toISOString();
      if (since === null || completedIso >= since) {
        lines.push({ at: completedIso, text: `[${t.ticket_number} "${t.title}"] marked ${t.status}.` });
      }
    }
  }

  // Command-log channel events. DESC from the query → reverse to chronological.
  // HS-8795 — permission checks (`permission_request`, needed AND granted) and
  // the "Claude finished" `done` event are channel chatter, not project work, so
  // they're excluded from the narrated material. The live spoken permission
  // announcement (HS-8781) already covers a permission the moment it's needed;
  // re-narrating long-resolved grants / "Claude finished" in the after-the-fact
  // reel is noise. Triggers (the worklist message that kicked off the work) stay.
  const logEntries = (await getLogEntries(since === null ? { limit: 500 } : { limit: 500, since })).reverse();
  for (const e of logEntries) {
    if (e.event_type === 'permission_request' || e.event_type === 'done') continue;
    lines.push({ at: new Date(e.created_at).toISOString(), text: `[activity] ${e.summary}` });
  }

  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const material = capMaterial(lines.map(l => l.text));
  return { material, count: lines.length, coversFrom: since, coversTo };
}
