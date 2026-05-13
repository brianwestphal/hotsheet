import type { PGlite } from '@electric-sql/pglite';

/**
 * HS-8378 — server-side mirror of `hasPendingFeedback(ticket)` from
 * `src/client/ticketRow.tsx`. Used by the cross-project feedback-state
 * aggregator (`GET /api/projects/feedback-state`) to decide whether any
 * project tab's purple dot should light up — pre-fix the dot only ever
 * reflected the *active* project because the client-side check ran on
 * `state.tickets` (active project only), so a ticket with FEEDBACK NEEDED
 * in some other project was invisible on its tab until the user switched
 * to that project.
 *
 * Lives in its own module so the helper is trivially unit-testable
 * (pure JSON parsing, no DB) and so the per-project loop in the route
 * handler stays readable.
 */

const FEEDBACK_PREFIX = 'FEEDBACK NEEDED:';
const IMMEDIATE_PREFIX = 'IMMEDIATE FEEDBACK NEEDED:';

/** Returns true when the LAST note in the JSON-encoded `notes` column
 *  starts with one of the feedback-needed prefixes. Mirrors the client
 *  `hasPendingFeedback` shape — same prefix list, same "only the most
 *  recent note matters" rule.
 *
 *  Defensive: tolerates `null`, `undefined`, `''`, `'[]'`, non-JSON,
 *  non-array, missing `text` on the last entry, etc. Any of those returns
 *  `false` rather than throwing.
 */
export function notesEndWithFeedback(notes: string | null | undefined): boolean {
  if (notes === null || notes === undefined) return false;
  const trimmed = notes.trim();
  if (trimmed === '' || trimmed === '[]') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const last: unknown = parsed[parsed.length - 1];
  if (last === null || typeof last !== 'object') return false;
  const text = (last as { text?: unknown }).text;
  if (typeof text !== 'string') return false;
  const head = text.trim();
  return head.startsWith(FEEDBACK_PREFIX) || head.startsWith(IMMEDIATE_PREFIX);
}

/** Returns true when ANY non-deleted ticket in the project has a pending
 *  feedback prompt as its most recent note. A SQL `LIKE` pre-filter
 *  narrows the JSON-parse loop to rows that contain the prefix string
 *  anywhere — a much smaller set than every-non-deleted-ticket — and the
 *  `notesEndWithFeedback` parse then confirms the prefix is on the LAST
 *  note (which is what the client's `hasPendingFeedback` check enforces).
 *
 *  Returns `false` on any DB error so the route handler can fall through
 *  to a `{ secret: false }` answer rather than 500'ing the whole bulk
 *  query.
 */
export async function projectHasPendingFeedback(db: PGlite): Promise<boolean> {
  try {
    // Cheap pre-filter: tickets whose notes JSON literally contains one
    // of the prefix strings somewhere. Saves a JSON.parse on every ticket
    // in projects where most tickets have no notes at all.
    //
    // HS-8381 — exclude `backlog` + `archive` (in addition to `deleted`)
    // from the candidate set. The purple project-tab dot is meant to
    // flag actionable feedback prompts; a FEEDBACK NEEDED note left on
    // a ticket the user has moved to backlog or archive isn't actionable
    // from that tab (the user deliberately set it aside) and shouldn't
    // pull attention to the project.
    const res = await db.query<{ notes: string }>(
      `SELECT notes FROM tickets
        WHERE status NOT IN ('deleted', 'backlog', 'archive')
          AND notes != ''
          AND notes != '[]'
          AND (notes LIKE '%FEEDBACK NEEDED:%' OR notes LIKE '%IMMEDIATE FEEDBACK NEEDED:%')`,
    );
    for (const row of res.rows) {
      if (notesEndWithFeedback(row.notes)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
