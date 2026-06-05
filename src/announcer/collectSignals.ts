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

  // Command-log channel events (trigger / permission / done). DESC from the
  // query → reverse to chronological.
  const logEntries = (await getLogEntries(since === null ? { limit: 500 } : { limit: 500, since })).reverse();
  for (const e of logEntries) {
    lines.push({ at: new Date(e.created_at).toISOString(), text: `[activity] ${e.summary}` });
  }

  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const material = lines.map(l => l.text).join('\n');
  return { material, count: lines.length, coversFrom: since, coversTo };
}
