/**
 * HS-9392 (docs/122) — wire shape + typed caller for the ticket-commit discovery
 * endpoint feeding the "Code Review" aggregate Open-in-Glassbox button.
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

export const CommitGroupSchema = z.object({
  /** Range base (`<oldest>^`) — review as `from..to`. */
  from: z.string(),
  to: z.string(),
  count: z.number(),
  subjects: z.array(z.string()),
  earliestDate: z.string(),
  latestDate: z.string(),
  /** Present when the group lives on the ticket's integration branch, not HEAD. */
  ref: z.string().optional(),
});
export type CommitGroup = z.infer<typeof CommitGroupSchema>;

export const TicketCommitsResponseSchema = z.object({
  groups: z.array(CommitGroupSchema),
  /** Earliest→latest span across interleaved HEAD groups (null for 0–1 groups);
   *  `unrelatedCount` = non-ticket commits the span would include. */
  span: z.object({ from: z.string(), to: z.string(), unrelatedCount: z.number() }).nullable(),
  /** Working tree dirty (drives the started-ticket "review uncommitted" fallback). */
  dirty: z.boolean(),
  /** The ticket's status — the client offers the uncommitted fallback for `started`. */
  ticketStatus: z.string().nullable(),
});
export type TicketCommitsResponse = z.infer<typeof TicketCommitsResponseSchema>;

/** GET the ticket's discovered commits + linear grouping (empty groups when the
 *  project isn't a repo / nothing references the ticket in a subject line). */
export async function getTicketCommits(ticketNumber: string): Promise<TicketCommitsResponse> {
  return apiCall(TicketCommitsResponseSchema, `/tickets/${encodeURIComponent(ticketNumber)}/commits`);
}
