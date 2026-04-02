import { getDb } from './connection.js';

// --- Notes parsing ---

export interface NoteEntry { id: string; text: string; created_at: string }

let noteCounter = 0;
export function generateNoteId(): string {
  return `n_${Date.now().toString(36)}_${(noteCounter++).toString(36)}`;
}

export function parseNotes(raw: string | null): NoteEntry[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Auto-assign IDs to legacy notes that don't have one
      return parsed.map((n: { id?: string; text: string; created_at: string }) => ({
        id: n.id !== undefined && n.id !== '' ? n.id : generateNoteId(),
        text: n.text,
        created_at: n.created_at,
      }));
    }
  } catch { /* not JSON yet */ }
  // Legacy: plain text notes — wrap as a single entry
  return [{ id: generateNoteId(), text: raw, created_at: new Date().toISOString() }];
}

export async function editNote(ticketId: number, noteId: string, text: string): Promise<NoteEntry[] | null> {
  const db = await getDb();
  const result = await db.query<{ notes: string }>(`SELECT notes FROM tickets WHERE id = $1`, [ticketId]);
  if (result.rows.length === 0) return null;
  const notes = parseNotes(result.rows[0].notes);
  const note = notes.find(n => n.id === noteId);
  if (!note) return null;
  note.text = text;
  await db.query(`UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(notes), ticketId]);
  return notes;
}

export async function deleteNote(ticketId: number, noteId: string): Promise<NoteEntry[] | null> {
  const db = await getDb();
  const result = await db.query<{ notes: string }>(`SELECT notes FROM tickets WHERE id = $1`, [ticketId]);
  if (result.rows.length === 0) return null;
  const notes = parseNotes(result.rows[0].notes);
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx === -1) return null;
  notes.splice(idx, 1);
  await db.query(`UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(notes), ticketId]);
  return notes;
}
