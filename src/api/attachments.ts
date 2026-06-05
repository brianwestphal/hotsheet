/**
 * HS-8633 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * attachments domain (`src/routes/attachments.ts`): ticket-attachment upload,
 * feedback-draft-attachment upload, delete, and reveal-in-file-manager.
 *
 * The two uploads are **multipart** (`FormData`), so they route through the
 * dedicated `apiUploadCall` / `setApiUploadTransport` injection in `_runner.ts`
 * rather than the JSON `apiCall` path. The binary serve route
 * (`GET /attachments/file/*`) stays a bespoke `<img>` / `<iframe>` `src` and is
 * not part of this typed contract. The draft-attachment **promote** endpoint
 * is owned by the feedback-drafts domain (`promoteFeedbackDraftAttachments`).
 */
import { z } from 'zod';

import { apiCall, type ApiCallOpts, apiUploadCall, type OkResponse, OkResponseSchema } from './_runner.js';

/** A persisted attachment row (the upload endpoints' 201 body). Matches the
 *  `Attachment` shape in `src/types.ts`; `.loose()` tolerates any future
 *  column without breaking the upload flow (the callers consume only `id` +
 *  `original_filename`). */
export const AttachmentSchema = z.object({
  id: z.number(),
  ticket_id: z.number(),
  original_filename: z.string(),
  stored_path: z.string(),
  created_at: z.string(),
  draft_id: z.string().nullable(),
}).loose();
export type AttachmentRecord = z.infer<typeof AttachmentSchema>;

// --- Typed callers ---

/** POST `/tickets/:id/attachments` (multipart) → upload a file to a ticket. */
export async function uploadAttachment(ticketId: number, file: File): Promise<AttachmentRecord> {
  return apiUploadCall(AttachmentSchema, `/tickets/${ticketId}/attachments`, file);
}

/** POST `/tickets/:id/feedback-drafts/:draftId/attachments` (multipart) →
 *  upload a file to an in-flight feedback draft (HS-8428). The row is hidden
 *  from the ticket's main attachment list until the draft is promoted. */
export async function uploadDraftAttachment(ticketId: number, draftId: string, file: File): Promise<AttachmentRecord> {
  return apiUploadCall(AttachmentSchema, `/tickets/${ticketId}/feedback-drafts/${encodeURIComponent(draftId)}/attachments`, file);
}

/** Request body for the cross-project attachment copy (HS-8739). */
export const CopyAttachmentsReqSchema = z.object({
  /** Secret of the project the source ticket lives in. */
  sourceSecret: z.string().min(1),
  /** The source ticket whose (non-draft) attachments are copied. */
  sourceTicketId: z.number().int(),
});
export type CopyAttachmentsReq = z.infer<typeof CopyAttachmentsReqSchema>;

export const CopyAttachmentsResSchema = z.object({
  copied: z.number(),
  attachments: z.array(AttachmentSchema),
});
export type CopyAttachmentsRes = z.infer<typeof CopyAttachmentsResSchema>;

/**
 * POST `/tickets/:id/attachments/copy-from` (HS-8739) — server-side copy of all
 * of a source ticket's non-draft attachments into target ticket `:id`. `:id` is
 * in the TARGET project (authed via `opts.secret` — the active project when
 * omitted); the source project is named by `req.sourceSecret` in the body. The
 * server reads the source rows from the source project's DB and copies the
 * files into the target project's attachments dir, so the bytes never round-trip
 * through the browser. Used by cross-project ticket copy/move (drag + clipboard).
 */
export async function copyTicketAttachments(
  targetTicketId: number,
  req: CopyAttachmentsReq,
  opts: Pick<ApiCallOpts, 'secret'> = {},
): Promise<CopyAttachmentsRes> {
  return apiCall(CopyAttachmentsResSchema, `/tickets/${targetTicketId}/attachments/copy-from`, { method: 'POST', body: req, secret: opts.secret });
}

/** DELETE `/attachments/:id` → delete an attachment + its file on disk. */
export async function deleteAttachment(id: number): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/attachments/${id}`, { method: 'DELETE' });
}

/** POST `/attachments/:id/reveal` → open the attachment's file in the OS file manager. */
export async function revealAttachment(id: number): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/attachments/${id}/reveal`, { method: 'POST' });
}
