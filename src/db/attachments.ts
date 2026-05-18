import type { Attachment } from '../types.js';
import { getDb } from './connection.js';

// --- Attachments ---

/**
 * Insert a real (ticket-scoped) attachment row. `draft_id` is `NULL`,
 * so the row is visible to the standard `getAttachments(ticketId)` flow.
 */
export async function addAttachment(ticketId: number, originalFilename: string, storedPath: string): Promise<Attachment> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `INSERT INTO attachments (ticket_id, original_filename, stored_path) VALUES ($1, $2, $3) RETURNING *`,
    [ticketId, originalFilename, storedPath]
  );
  return result.rows[0];
}

/**
 * HS-8428 — insert a draft-scoped attachment row. Identical shape to
 * `addAttachment` but stamps a non-null `draft_id` so the row is hidden
 * from the standard list query. The `draft_id` is the client-generated
 * feedback-draft id; we do not enforce a foreign key on it (the draft
 * row may not exist yet — the feedback dialog can upload before the
 * user clicks Save Draft, and we don't want a half-saved dialog to
 * spuriously fail attachment uploads). Orphans get GC'd by the
 * cleanup sweep, see src/cleanup.ts.
 */
export async function addDraftAttachment(
  ticketId: number,
  draftId: string,
  originalFilename: string,
  storedPath: string,
): Promise<Attachment> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `INSERT INTO attachments (ticket_id, draft_id, original_filename, stored_path) VALUES ($1, $2, $3, $4) RETURNING *`,
    [ticketId, draftId, originalFilename, storedPath]
  );
  return result.rows[0];
}

/**
 * List the real (non-draft) attachments for a ticket. HS-8428 — adds
 * `WHERE draft_id IS NULL` so in-flight feedback-dialog attachments
 * don't surface in the ticket's main attachment list / count.
 */
export async function getAttachments(ticketId: number): Promise<Attachment[]> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `SELECT * FROM attachments WHERE ticket_id = $1 AND draft_id IS NULL ORDER BY created_at ASC`,
    [ticketId]
  );
  return result.rows;
}

/**
 * HS-8428 — list every attachment linked to a specific draft. Used by
 * the feedback dialog's "reopen draft" path to render previously-
 * uploaded files alongside the draft's text partitions.
 */
export async function getDraftAttachments(draftId: string): Promise<Attachment[]> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `SELECT * FROM attachments WHERE draft_id = $1 ORDER BY created_at ASC`,
    [draftId]
  );
  return result.rows;
}

export async function getAttachment(id: number): Promise<Attachment | null> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `SELECT * FROM attachments WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function deleteAttachment(id: number): Promise<Attachment | null> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `DELETE FROM attachments WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * HS-8428 — promote every attachment linked to a draft into a real
 * ticket attachment by clearing `draft_id`. Single UPDATE statement so
 * the transition is atomic — either the whole batch becomes real, or
 * nothing does (no half-promoted state on partial failure). Returns the
 * promoted rows for the caller's logging / notify path.
 */
export async function promoteDraftAttachments(draftId: string): Promise<Attachment[]> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `UPDATE attachments SET draft_id = NULL WHERE draft_id = $1 RETURNING *`,
    [draftId]
  );
  return result.rows;
}

/**
 * HS-8428 — delete every attachment linked to a draft. Returns the
 * deleted rows so the route handler can `rmSync` each `stored_path`
 * on disk after the DB transaction commits. Used by the
 * delete-feedback-draft path + the discard-without-save fallback the
 * client fires when the dialog is closed without persisting.
 */
export async function deleteDraftAttachments(draftId: string): Promise<Attachment[]> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `DELETE FROM attachments WHERE draft_id = $1 RETURNING *`,
    [draftId]
  );
  return result.rows;
}

/**
 * HS-8428 — list orphan draft attachments: rows whose `draft_id` does
 * NOT match any existing feedback_drafts row AND whose `created_at` is
 * older than the cutoff. The cleanup sweep uses this to GC attachments
 * left behind by dialogs that the user closed without saving (the
 * client tries to clean up on close, but a crashed / killed browser
 * tab will leak rows here).
 */
export async function listOrphanDraftAttachments(olderThanMs: number): Promise<Attachment[]> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await db.query<Attachment>(
    `SELECT a.* FROM attachments a
       LEFT JOIN feedback_drafts d ON d.id = a.draft_id
      WHERE a.draft_id IS NOT NULL
        AND d.id IS NULL
        AND a.created_at < $1
      ORDER BY a.created_at ASC`,
    [cutoff]
  );
  return result.rows;
}
