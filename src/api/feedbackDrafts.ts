/**
 * HS-8642 (HS-8522 typed-API layer) — typed callers + wire SSOT for the
 * feedback-draft endpoints (§21 feedback domain, `src/routes/tickets.ts` +
 * the promote-attachments route in `src/routes/attachments.ts`):
 *
 *   - `GET    /tickets/:id/feedback-drafts`              → FeedbackDraft[]
 *   - `POST   /tickets/:id/feedback-drafts`              → FeedbackDraft
 *   - `PATCH  /tickets/:id/feedback-drafts/:draftId`     → FeedbackDraft
 *   - `DELETE /tickets/:id/feedback-drafts/:draftId`     → ok + droppedAttachments count
 *   - `POST   …/feedback-drafts/:draftId/promote-attachments` → promoted count + attachments
 *
 * Before HS-8642 the `FeedbackDraft` wire shape was declared TWICE — once on
 * the server (`src/db/feedbackDrafts.ts`) and once on the client
 * (`noteRenderer.tsx`), kept in sync by hand. `FeedbackDraftSchema` here is
 * now the single source of truth: the server's DB layer + the client's
 * note renderer both consume the inferred type. Request bodies reuse the
 * existing server-side `FeedbackDraftCreateSchema` / `FeedbackDraftUpdateSchema`
 * (zod-only, safe to import client-side) so each wire body is defined once.
 */
import { z } from 'zod';

import type { FeedbackDraftCreateSchema, FeedbackDraftUpdateSchema } from '../routes/validation.js';
import { apiCall } from './_runner.js';

/** Saved partition structure — mirrors the feedback dialog's working state so
 *  a reopened draft round-trips back to the exact same UI. Same shape as the
 *  `partitions` in `FeedbackDraftCreateSchema`. */
export const FeedbackDraftPartitionsSchema = z.object({
  blocks: z.array(z.object({ markdown: z.string(), html: z.string() })),
  inlineResponses: z.array(z.object({ blockIndex: z.number(), text: z.string() })),
  catchAll: z.string(),
});
export type FeedbackDraftPartitions = z.infer<typeof FeedbackDraftPartitionsSchema>;

/** HS-8428 — a draft-scoped attachment hydrated server-side onto the GET
 *  response by `draft_id` so a click-to-reopen can pre-populate the dialog's
 *  file list without an extra round-trip. */
export const FeedbackDraftAttachmentSchema = z.object({
  id: z.number(),
  ticket_id: z.number(),
  draft_id: z.string().nullable(),
  original_filename: z.string(),
  stored_path: z.string(),
  created_at: z.string(),
});
export type FeedbackDraftAttachmentSummary = z.infer<typeof FeedbackDraftAttachmentSchema>;

/** A saved feedback draft. `attachments` is present only on the GET-list
 *  response (hydrated server-side); the POST / PATCH responses omit it, hence
 *  optional. */
export const FeedbackDraftSchema = z.object({
  id: z.string(),
  ticketId: z.number(),
  parentNoteId: z.string().nullable(),
  promptText: z.string(),
  partitions: FeedbackDraftPartitionsSchema,
  attachments: z.array(FeedbackDraftAttachmentSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FeedbackDraft = z.infer<typeof FeedbackDraftSchema>;

const FeedbackDraftListSchema = z.array(FeedbackDraftSchema);

/** DELETE returns `{ ok, droppedAttachments }` — the attachment count lets the
 *  caller know whether an orphan-cleanup actually removed anything. */
const DeleteFeedbackDraftRespSchema = z.object({
  ok: z.literal(true),
  droppedAttachments: z.number(),
});
export type DeleteFeedbackDraftResp = z.infer<typeof DeleteFeedbackDraftRespSchema>;

/** promote-attachments flips `draft_id` → NULL on every attachment linked to
 *  the draft, making them visible on the ticket's main list. */
const PromoteAttachmentsRespSchema = z.object({
  promoted: z.number(),
  attachments: z.array(FeedbackDraftAttachmentSchema),
});
export type PromoteAttachmentsResp = z.infer<typeof PromoteAttachmentsRespSchema>;

// --- Request input types (inferred from the shared server-side schemas) ---
export type FeedbackDraftCreateReq = z.infer<typeof FeedbackDraftCreateSchema>;
export type FeedbackDraftUpdateReq = z.infer<typeof FeedbackDraftUpdateSchema>;

/** GET `/tickets/:id/feedback-drafts` → every draft for this ticket, each
 *  hydrated with its draft-scoped attachments. */
export async function getFeedbackDrafts(ticketId: number): Promise<FeedbackDraft[]> {
  return apiCall(FeedbackDraftListSchema, `/tickets/${ticketId}/feedback-drafts`);
}

/** POST `/tickets/:id/feedback-drafts` → create a draft (id is client-generated). */
export async function createFeedbackDraft(ticketId: number, body: FeedbackDraftCreateReq): Promise<FeedbackDraft> {
  return apiCall(FeedbackDraftSchema, `/tickets/${ticketId}/feedback-drafts`, { method: 'POST', body });
}

/** PATCH `/tickets/:id/feedback-drafts/:draftId` → update a draft's partitions. */
export async function updateFeedbackDraft(ticketId: number, draftId: string, partitions: FeedbackDraftPartitions): Promise<FeedbackDraft> {
  const body: FeedbackDraftUpdateReq = { partitions };
  return apiCall(FeedbackDraftSchema, `/tickets/${ticketId}/feedback-drafts/${encodeURIComponent(draftId)}`, { method: 'PATCH', body });
}

/** DELETE `/tickets/:id/feedback-drafts/:draftId` → delete a draft + its
 *  draft-scoped attachments. Tolerant: returns ok even when the draft row was
 *  already gone but attachments were cleaned up (orphan-cleanup path). */
export async function deleteFeedbackDraft(ticketId: number, draftId: string): Promise<DeleteFeedbackDraftResp> {
  return apiCall(DeleteFeedbackDraftRespSchema, `/tickets/${ticketId}/feedback-drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
}

/** POST `…/feedback-drafts/:draftId/promote-attachments` → promote draft-scoped
 *  attachments to real (ticket-scoped). No-op when the draft has none. */
export async function promoteFeedbackDraftAttachments(ticketId: number, draftId: string): Promise<PromoteAttachmentsResp> {
  return apiCall(PromoteAttachmentsRespSchema, `/tickets/${ticketId}/feedback-drafts/${encodeURIComponent(draftId)}/promote-attachments`, { method: 'POST', body: {} });
}
