import { parseNotesJson } from './noteRenderer.js';
import { buildCombinedReaderEntries, openReaderOverlay } from './readerOverlay.js';
import type { Ticket } from './state.js';

/**
 * HS-8401 / HS-8841 — open the §49 reader overlay anchored on a ticket's LATEST
 * non-empty note, falling back to its Details (description) when there is no
 * note. Shared by the "Read Latest Note" context-menu item (HS-8401) and the
 * HS-8830 spacebar shortcut so both behave identically.
 *
 * Returns the resolved `target` (`'note'` | `'details'`) when the reader was
 * opened, or `null` when there is NEITHER a non-empty note NOR a description
 * (nothing to read) — callers use the null result to decide whether to consume
 * the keystroke.
 */
export function openLatestNoteReader(ticket: Ticket): 'note' | 'details' | null {
  const parsedNotes = parseNotesJson(ticket.notes);
  const nonEmptyNotes = parsedNotes.filter((n) => n.text.trim() !== '');
  const latestNote = nonEmptyNotes.length > 0 ? nonEmptyNotes[nonEmptyNotes.length - 1] : null;
  const hasDescription = ticket.details.trim() !== '';
  const target: 'note' | 'details' | null =
    latestNote !== null ? 'note' : (hasDescription ? 'details' : null);
  if (target === null) return null;

  const combined = buildCombinedReaderEntries({
    ticketNumber: ticket.ticket_number,
    ticketTitle: ticket.title,
    detailsMarkdown: ticket.details,
    notes: parsedNotes,
  });
  // Anchor on the latest note, or the Details entry in the fallback case.
  // `target !== null` guarantees the anchor exists in `combined`.
  const anchorId = latestNote !== null ? (latestNote.id ?? '') : 'details';
  const initialIndex = Math.max(0, combined.findIndex((e) => e.id === anchorId));
  const anchor = combined[initialIndex];
  openReaderOverlay({
    title: anchor.title,
    markdown: anchor.markdown,
    navigation: combined.length > 1
      ? { entries: combined.map((e) => ({ title: e.title, markdown: e.markdown })), initialIndex }
      : undefined,
  });
  return target;
}
