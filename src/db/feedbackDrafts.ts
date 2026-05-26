import { z } from 'zod';

import type { FeedbackDraft, FeedbackDraftPartitions } from '../api/feedbackDrafts.js';
import { getDb } from './connection.js';

// HS-8642 — `FeedbackDraft` is now defined once as the wire SSOT in
// `src/api/feedbackDrafts.ts` (inferred from `FeedbackDraftSchema`). The DB
// layer returns that exact shape (minus the GET-only `attachments`, which the
// route hydrates), so server + client can never drift. Re-exported so existing
// `import { FeedbackDraft } from '../db/feedbackDrafts.js'` server consumers
// keep working. `SavedPartitions` aliases the schema's partitions type.
export type { FeedbackDraft };
export type SavedPartitions = FeedbackDraftPartitions;

/**
 * HS-7599 — Feedback drafts (per docs/21-feedback.md §21.2.3).
 *
 * A draft is a partially-filled response to a FEEDBACK NEEDED note that the
 * user wants to save without sending. Stored in its own table (NOT in
 * `tickets.notes`) so drafts don't sync to GitHub / other plugins — feedback
 * drafts are private, local-only state. Click on a draft re-opens the
 * feedback dialog with the saved partition structure restored verbatim.
 *
 * Schema rationale:
 * - `id` is a client-generated text id (`fd_<base36-time>_<base36-rand>`) so
 *   the client can render the new draft optimistically without a round-trip.
 * - `parent_note_id` links the draft back to the FEEDBACK NEEDED note that
 *   prompted it. Null when the parent note has been deleted (per §21.2.3
 *   the draft is preserved as "free-floating" in that case).
 * - `prompt_text` snapshots the original feedback prompt so the dialog can
 *   reconstruct the question text even after the parent note is gone.
 * - `partitions_json` stores `{blocks, inlineResponses, catchAll}` verbatim
 *   so future changes to `parseFeedbackBlocks` (HS-7558-style heuristic
 *   tweaks) don't reshape an existing draft when it's re-opened.
 */
export interface FeedbackDraftRow {
  id: string;
  ticket_id: number;
  parent_note_id: string | null;
  prompt_text: string;
  partitions_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: FeedbackDraftRow): FeedbackDraft {
  // HS-8567 — zod-validated partitions schema. `.loose()` because we
  // tolerate forward-compat additions.
  const PartitionsSchema = z.object({
    blocks: z.array(z.object({
      markdown: z.string(),
      html: z.string(),
    }).loose()).optional(),
    inlineResponses: z.array(z.object({
      blockIndex: z.number(),
      text: z.string(),
    }).loose()).optional(),
    catchAll: z.string().optional(),
  }).loose();
  let partitions: SavedPartitions = { blocks: [], inlineResponses: [], catchAll: '' };
  try {
    const raw: unknown = JSON.parse(row.partitions_json);
    const parsed = PartitionsSchema.safeParse(raw);
    if (parsed.success) {
      partitions = {
        blocks: parsed.data.blocks ?? [],
        inlineResponses: parsed.data.inlineResponses ?? [],
        catchAll: parsed.data.catchAll ?? '',
      };
    }
  } catch { /* malformed → fall back to empty partitions */ }
  return {
    id: row.id,
    ticketId: row.ticket_id,
    parentNoteId: row.parent_note_id,
    promptText: row.prompt_text,
    partitions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listFeedbackDrafts(ticketId: number): Promise<FeedbackDraft[]> {
  const db = await getDb();
  const result = await db.query<FeedbackDraftRow>(
    `SELECT id, ticket_id, parent_note_id, prompt_text, partitions_json, created_at, updated_at
       FROM feedback_drafts
      WHERE ticket_id = $1
      ORDER BY created_at ASC`,
    [ticketId],
  );
  return result.rows.map(fromRow);
}

export async function getFeedbackDraft(draftId: string): Promise<FeedbackDraft | null> {
  const db = await getDb();
  const result = await db.query<FeedbackDraftRow>(
    `SELECT id, ticket_id, parent_note_id, prompt_text, partitions_json, created_at, updated_at
       FROM feedback_drafts
      WHERE id = $1`,
    [draftId],
  );
  return result.rows.length === 0 ? null : fromRow(result.rows[0]);
}

export async function createFeedbackDraft(input: {
  id: string;
  ticketId: number;
  parentNoteId: string | null;
  promptText: string;
  partitions: SavedPartitions;
}): Promise<FeedbackDraft> {
  const db = await getDb();
  const partitionsJson = JSON.stringify(input.partitions);
  const result = await db.query<FeedbackDraftRow>(
    `INSERT INTO feedback_drafts (id, ticket_id, parent_note_id, prompt_text, partitions_json)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, ticket_id, parent_note_id, prompt_text, partitions_json, created_at, updated_at`,
    [input.id, input.ticketId, input.parentNoteId, input.promptText, partitionsJson],
  );
  return fromRow(result.rows[0]);
}

export async function updateFeedbackDraft(
  draftId: string,
  partitions: SavedPartitions,
): Promise<FeedbackDraft | null> {
  const db = await getDb();
  const partitionsJson = JSON.stringify(partitions);
  const result = await db.query<FeedbackDraftRow>(
    `UPDATE feedback_drafts
        SET partitions_json = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, ticket_id, parent_note_id, prompt_text, partitions_json, created_at, updated_at`,
    [partitionsJson, draftId],
  );
  return result.rows.length === 0 ? null : fromRow(result.rows[0]);
}

export async function deleteFeedbackDraft(draftId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `DELETE FROM feedback_drafts WHERE id = $1`,
    [draftId],
  );
  return (result.affectedRows ?? 0) > 0;
}
