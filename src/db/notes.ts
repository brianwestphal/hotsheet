import { z } from 'zod';

import { getDb } from './connection.js';

// --- Notes parsing ---

export interface NoteEntry { id: string; text: string; created_at: string }

// HS-8567 — zod-validated note row. `id` is optional because legacy rows
// (pre-id-generation) lack it; `parseNotes` falls back to generating one.
const NoteRowSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
}).loose();

let noteCounter = 0;
export function generateNoteId(): string {
  return `n_${Date.now().toString(36)}_${(noteCounter++).toString(36)}`;
}

export function parseNotes(raw: string | null): NoteEntry[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // HS-8567 — zod-validate each row instead of unchecked param typing.
      // Auto-assign IDs to legacy notes that don't have one.
      const out: NoteEntry[] = [];
      for (const entry of parsed) {
        const row = NoteRowSchema.safeParse(entry);
        if (!row.success) continue;
        out.push({
          id: row.data.id !== undefined && row.data.id !== '' ? row.data.id : generateNoteId(),
          text: row.data.text,
          created_at: row.data.created_at,
        });
      }
      return out;
    }
  } catch { /* not JSON yet */ }
  // Legacy: plain text notes — wrap as a single entry
  return [{ id: generateNoteId(), text: raw, created_at: new Date().toISOString() }];
}

/**
 * HS-8427 — defensive unwrap for `updateTicket`'s notes-append path.
 *
 * The append surface (`PATCH /api/tickets/:id` with `notes: <body>`)
 * treats the value as the **plain markdown body** of a new note and
 * server-wraps it in a `{id, text, created_at}` entry that gets pushed
 * onto the ticket's notes array. But AI agents (the `hotsheet_*` MCP
 * tools, curl callers reading older skill docs, ad-hoc API consumers)
 * routinely mis-encode this as a JSON-stringified note array — e.g.
 * `'[{"text":"**TL;DR:** ..."}]'` — because the old MCP tool docstring
 * said "Pass the full notes array as a JSON string". Pre-fix that
 * payload was stored verbatim as the `text` of a single new note, so
 * the rendered note looked like a literal JSON blob containing escaped
 * markdown — the surface of HS-8427.
 *
 * This helper parses the agent's input, detects the misencoded shape,
 * and returns the unwrapped text bodies in order. The caller appends
 * each as its own note entry. Heuristic is intentionally narrow:
 *
 *   - Must JSON-parse cleanly to an array
 *   - Every element must be an object with a string `text` field
 *   - Any element with extra fields beyond `text` / `id` / `created_at`
 *     bails out (treat as plain text) — protects against legitimate
 *     markdown bodies that happen to start with `[{` and contain
 *     enough JSON shape to fool a looser check
 *
 * Anything that doesn't pass the gate is returned as-is in a single-
 * element array — same effect as the pre-fix codepath, no behavior
 * change for plain-markdown callers.
 *
 * Pure: takes the raw input, returns an array of text bodies. No FS /
 * DB / network. Exported for unit tests.
 */
export function normalizeNotesAppend(raw: string): string[] {
  if (raw === '') return [];
  // Quick exit when the input clearly isn't a JSON array — avoid the
  // parse cost on every plain-text note (the overwhelmingly common case).
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('[')) return [raw];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (!Array.isArray(parsed)) return [raw];
  if (parsed.length === 0) return [raw]; // empty array → treat as plain text body (probably user-meant)
  const ALLOWED_KEYS = new Set(['text', 'id', 'created_at']);
  const texts: string[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') return [raw];
    const obj = entry as Record<string, unknown>;
    if (typeof obj.text !== 'string') return [raw];
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_KEYS.has(key)) return [raw];
    }
    texts.push(obj.text);
  }
  return texts;
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
