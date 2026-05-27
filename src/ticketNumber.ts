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
