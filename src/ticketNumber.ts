/**
 * Shared, dependency-free ticket-number helpers used by BOTH the server
 * (`src/db/tickets.ts`) and the client (`src/client/ticketsStore.ts`). Kept in
 * its own module so the two sides can't drift — the exact-id search semantics
 * MUST agree (the server returns the ticket regardless of status, and the
 * client must then not re-hide it).
 */

/**
 * HS-8100 / HS-8653 — true when `search` is an exact ticket-number reference
 * (e.g. `HS-100`, `BUG-42`, `MIGRATION_V2-7`). When the user types a complete
 * ticket id, they want THAT ticket regardless of which bucket it lives in —
 * backlog, archive, or even trash. Matches the same shape
 * `ticketRefs.ts::buildTicketRefRegex` recognizes for inline links, but
 * anchored to the full string (case-insensitive, surrounding whitespace
 * tolerated).
 *
 * Server (`buildTicketWhereClause`): short-circuits the status gate + matches
 * `LOWER(ticket_number) = LOWER(search)`. Client (`filteredTickets`): bypasses
 * the view-filter exclusion for the matching ticket so an archived / trashed
 * exact match the server returned isn't dropped again on the way to the DOM.
 */
export function isExactTicketIdSearch(search: string): boolean {
  return /^\s*[A-Za-z][A-Za-z0-9_]*-\d+\s*$/.test(search);
}

/**
 * HS-8646 — split a free-text search query into whitespace-separated terms.
 * A multi-word search matches on the UNION of its words rather than the literal
 * phrase: each term must appear in at least one searched column (AND across
 * terms, OR across columns), in any order/position. So `login bug` finds a
 * ticket titled "bug" whose details mention "login", which a literal-phrase
 * ILIKE would have missed.
 *
 * Splits on ANY run of whitespace and drops empty tokens; an all-whitespace
 * query yields `[]` (both layers treat that as "no narrowing"). Single source
 * of truth for the split rule so the server (`buildTicketWhereClause` +
 * `countSearchMatchesInExcludedStatuses`) and the client (`ticketMatchesSearch`)
 * can't drift — cf. HS-8380, which fixed a prior client/server search desync.
 */
export function splitSearchTerms(search: string): string[] {
  return search.trim().split(/\s+/).filter(term => term !== '');
}
