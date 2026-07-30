/**
 * HS-8553 — extracted from `src/client/app.tsx`. Auto-save debounce for
 * the detail-panel title + details textareas. Each keystroke records an
 * undo coalesce + reschedules a debounced PATCH; HS-8020 keeps the
 * markdown sibling in sync on every keystroke so the reader-mode button
 * never paints a stale render.
 */
import { updateTicketField } from '../../api/index.js';
import { syncBlockedReasonSize } from '../blockedReasonSize.js';
import { TIMERS } from '../constants/timers.js';
import { renderDetailsMarkdown } from '../detail.js';
import { byIdOrNull } from '../dom.js';
import { syncDetailReaderButton } from '../readerOverlay.js';
import { getDetailSaveTimeout, setDetailSaveTimeout } from '../shortcuts.js';
import { state } from '../state.js';
import { loadTickets } from '../ticketList.js';
import { recordTextChange } from '../undo/actions.js';

export function bindDetailAutoSave(): void {
  // HS-8642 — the field key is paired with its element id up front (rather than
  // string-sliced) so it carries the `'title' | 'details'` literal type the
  // typed `updateTicketField` needs — no raw `api()` / dynamic-key fallback.
  const fields: { fieldId: string; key: 'title' | 'details' | 'blocked_reason' }[] = [
    { fieldId: 'detail-title', key: 'title' },
    { fieldId: 'detail-details', key: 'details' },
    // HS-9336 (docs/116) — the free-text blocked-reason editor. Debounce-saves through
    // the same path but is deliberately EXCLUDED from the special undo coalescing below,
    // so the field's own native text undo/redo works (mirrors HS-9335's intent).
    { fieldId: 'detail-blocked-reason', key: 'blocked_reason' },
  ];
  for (const { fieldId, key } of fields) {
    // byIdOrNull: the blocked-reason textarea (HS-9336) may be absent in a minimal
    // test DOM; the long-standing title/details are always present in the real panel.
    const el = byIdOrNull<HTMLInputElement | HTMLTextAreaElement>(fieldId);
    if (el === null) continue;
    el.addEventListener('input', () => {
      // Record text change for undo (coalesces rapid edits) — title/details only.
      const ticket = state.tickets.find(t => t.id === state.activeTicketId);
      if (ticket && key !== 'blocked_reason') {
        recordTextChange(ticket, key, el.value);
      }
      // HS-7957 — keep the Details reader-mode button disabled when the
      // textarea is empty (nothing to read). Re-evaluated on every input
      // event AND on detail-panel load (see syncDetailReaderButton call in
      // detail.tsx). The button itself is wired in `bindDetailReaderButton`.
      // HS-8020 — re-render the markdown sibling on every keystroke so a
      // user who closes the details panel without blurring the textarea
      // (e.g. via Esc, sidebar nav, project switch) returns to a current
      // rendered view rather than a stale snapshot.
      if (fieldId === 'detail-details') {
        syncDetailReaderButton();
        renderDetailsMarkdown(el.value);
      }
      // HS-9516 — grow to Details' height on the first character and collapse back to
      // one row when cleared, so the field's size tracks whether it is in use.
      if (fieldId === 'detail-blocked-reason') {
        syncBlockedReasonSize(el as HTMLTextAreaElement, byIdOrNull<HTMLTextAreaElement>('detail-details'));
      }
      const currentTimeout = getDetailSaveTimeout();
      if (currentTimeout) clearTimeout(currentTimeout);
      const newTimeout = setTimeout(() => {
        if (state.activeTicketId == null) return;
        void updateTicketField(state.activeTicketId, key, el.value).then(() => void loadTickets());
      }, TIMERS.DETAIL_SAVE_MS);
      setDetailSaveTimeout(newTimeout);
    });
  }
}
