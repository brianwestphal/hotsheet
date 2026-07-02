/**
 * HS-9223 / HS-9293 (docs/111) — typed API for the READ-side review-proof surface:
 * the Glassbox `.pr-notes/` SARIF notes that reference a Hot Sheet ticket. Wire
 * shape defined ONCE here (§9); the server's `prNotesReader.ts` infers its
 * `ReviewProofNote` return type from these schemas and the client caller validates
 * the response through them.
 *
 * Endpoint (see `src/routes/tickets.ts`):
 *   - `GET /tickets/:number/review-proof` → `{ notes: ReviewProofNote[] }`
 *     (presence-gated: empty `notes` when there's no `.pr-notes/` or no match).
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

/** One proof artifact referenced by a note (`result.attachments[]`). `kind` is
 *  inferred from the URI extension so the client knows whether to render an image
 *  or inline text. */
export const ReviewProofAttachmentSchema = z.object({
  /** Artifact URI as written in the SARIF (repo-relative path under `.pr-notes/`). */
  uri: z.string(),
  kind: z.enum(['image', 'text']),
  description: z.string().optional(),
});
export type ReviewProofAttachment = z.infer<typeof ReviewProofAttachmentSchema>;

/** One `.pr-notes/` SARIF `result` linked to the ticket, flattened for display. */
export const ReviewProofNoteSchema = z.object({
  /** Note kind from `result.properties.tags[0]` (proof / rationale / risk / …). */
  noteKind: z.string().nullable(),
  /** Anchored source file (`physicalLocation.artifactLocation.uri`). */
  file: z.string().nullable(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  /** First line of `result.message.text` — the one-line list summary. */
  summary: z.string(),
  /** `result.rank` (0–100) — sort key (most important first). */
  rank: z.number().nullable(),
  /** `result.level` (`warning` for risk notes, else `none`). */
  level: z.string().nullable(),
  attachments: z.array(ReviewProofAttachmentSchema),
  /** Repo-relative path of the SARIF shard (stable key). */
  sourceFile: z.string(),
});
export type ReviewProofNote = z.infer<typeof ReviewProofNoteSchema>;

export const ReviewProofResponseSchema = z.object({
  notes: z.array(ReviewProofNoteSchema),
});
export type ReviewProofResponse = z.infer<typeof ReviewProofResponseSchema>;

/** GET the `.pr-notes/` proof notes linked to `ticketNumber` (e.g. `HS-1234`).
 *  Empty `notes` when the repo has no `.pr-notes/` or nothing references the ticket. */
export async function getReviewProof(ticketNumber: string): Promise<ReviewProofResponse> {
  return apiCall(ReviewProofResponseSchema, `/tickets/${encodeURIComponent(ticketNumber)}/review-proof`);
}
