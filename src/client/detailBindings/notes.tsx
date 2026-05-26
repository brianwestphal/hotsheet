/**
 * HS-8553 — extracted from `src/client/app.tsx`. "Add note" button for
 * the detail panel. Builds the new notes array client-side so we can
 * (1) control the new note's id (so we can find its element after
 * re-render) and (2) start it empty (no default text).
 */
import { putTicketNotesBulk } from '../../api/index.js';
import { openDetailAndFocusNote } from '../detail.js';
import { byIdOrNull } from '../dom.js';
import { parseJsonArrayOr } from '../json.js';
import { state, type Ticket } from '../state.js';
import { pushNotesUndo } from '../undo/actions.js';

interface NoteEntry { id: string; text: string; created_at: string }

export function bindDetailNotes(): void {
  byIdOrNull('detail-add-note-btn')?.addEventListener('click', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (!ticket) return;

    // Build the new notes array client-side and PUT in bulk so we can:
    //   1. control the new note's id (so we can find its element after re-render)
    //   2. start it empty (no default text)
    const beforeNotes = ticket.notes;
    // HS-8090 — `parseJsonArrayOr` collapses the try/catch + Array.isArray
    // dance. Per-element shape stays this caller's responsibility, but
    // the surrounding code only ever pushes new entries onto the array
    // (never reads existing entries here) so element validation isn't
    // needed at this point.
    const parsed = parseJsonArrayOr(beforeNotes, []) as NoteEntry[];
    const newNoteId = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newNotes: NoteEntry[] = [...parsed, { id: newNoteId, text: '', created_at: new Date().toISOString() }];
    const newNotesJson = JSON.stringify(newNotes);
    await putTicketNotesBulk(state.activeTicketId, newNotesJson);
    pushNotesUndo({ ...ticket, notes: beforeNotes } as Ticket, 'Add note', newNotesJson);
    ticket.notes = newNotesJson;
    openDetailAndFocusNote(state.activeTicketId, newNoteId);
  });
}
