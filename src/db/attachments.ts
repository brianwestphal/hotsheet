import type { Attachment } from '../types.js';
import { getDb } from './connection.js';

// --- Attachments ---

export async function addAttachment(ticketId: number, originalFilename: string, storedPath: string): Promise<Attachment> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `INSERT INTO attachments (ticket_id, original_filename, stored_path) VALUES ($1, $2, $3) RETURNING *`,
    [ticketId, originalFilename, storedPath]
  );
  return result.rows[0];
}

export async function getAttachments(ticketId: number): Promise<Attachment[]> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `SELECT * FROM attachments WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketId]
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
