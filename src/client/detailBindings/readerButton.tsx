/**
 * HS-8553 — extracted from `src/client/app.tsx`. HS-7957's Details
 * reader-mode book button. Click opens the reader overlay with the
 * *current* textarea value (snapshot at click time, per
 * docs/49-reader-mode.md §49.5) so a mid-edit reader shows the working
 * state. The button's `disabled` state is kept in sync by
 * `syncDetailReaderButton`, called from `bindDetailAutoSave`'s input
 * handler and `detail.tsx`'s load paths.
 */
import { byId, byIdOrNull } from '../dom.js';
import { buildCombinedReaderEntries, buildDetailsReaderTitle, openReaderOverlay, syncDetailReaderButton } from '../readerOverlay.js';
import { state } from '../state.js';

export function bindDetailReaderButton(): void {
  const btn = byIdOrNull<HTMLButtonElement>('detail-reader-btn');
  if (btn === null) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const detailsArea = byId<HTMLTextAreaElement>('detail-details');
    const ticket = state.tickets.find(t => t.id === state.activeTicketId) ?? null;
    const detailsMarkdown = detailsArea.value;
    // HS-8429 — build the unified [Details, ...non-empty notes] navigation
    // list so the user can step from Details through every note via the
    // chevron buttons + ArrowUp/Down. Lazy-import noteRenderer to dodge a
    // circular dep (noteRenderer imports `state` which app.tsx initialises).
    const { parseNotesJson } = await import('../noteRenderer.js');
    const notes = ticket !== null ? parseNotesJson(ticket.notes) : [];
    const entries = buildCombinedReaderEntries({
      ticketNumber: ticket?.ticket_number,
      ticketTitle: ticket?.title,
      detailsMarkdown,
      notes,
    });
    // Initial index = the Details entry's position in the combined list.
    // When Details is non-empty (the typical case — the button is
    // disabled when the textarea is empty) it's at index 0; when Details
    // is empty buildCombinedReaderEntries omits it entirely and we land
    // on the first note (defensive — shouldn't fire in practice).
    const detailsIdx = entries.findIndex(e => e.id === 'details');
    const initialIndex = detailsIdx === -1 ? 0 : detailsIdx;
    openReaderOverlay({
      title: buildDetailsReaderTitle(ticket?.ticket_number, ticket?.title),
      markdown: detailsMarkdown,
      navigation: entries.length > 1
        ? { entries: entries.map(({ title, markdown }) => ({ title, markdown })), initialIndex }
        : undefined,
    });
  });
  // Sync on initial bind so a fresh page load with no ticket selected leaves
  // the button correctly disabled.
  syncDetailReaderButton();
}
