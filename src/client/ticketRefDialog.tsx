import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { openDetail } from './detail.js';
import { toElement } from './dom.js';
import { state, type Ticket } from './state.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';
import { showToast } from './toast.js';

/**
 * HS-8036 — stacking ticket-reference dialog. Clicking a `HS-1234`-style
 * link inside a rendered note / details / reader-overlay body opens a
 * read-only modal showing the referenced ticket's content. Clicking
 * another reference inside an open dialog pushes a new dialog onto the
 * stack (each one offset by 30px so the user can see depth).
 *
 * **Read-only for v1** per the implementation note in HS-8036's
 * completion: full editable behaviour requires refactoring `detail.tsx`
 * (~30 `getElementById` callsites, scattered globals) into a reusable
 * component. Read-only ships the navigation value (drill into chains
 * of references) plus an "Open in detail panel" button that one-clicks
 * the user into the editable main panel for the active dialog's
 * ticket. Editable-inline is filed as a follow-up.
 *
 * Dismissal:
 * - Backdrop click → dismisses the TOP dialog (one level).
 * - Escape → dismisses the TOP dialog (one level).
 * - "Open in detail panel" button → dismisses the entire stack and
 *   `openDetail(ticketId)` switches the main panel.
 */

interface DialogEntry {
  overlay: HTMLElement;
  ticket: Ticket;
}

const stack: DialogEntry[] = [];

const X_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const OPEN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

/**
 * Open a ticket-reference dialog for the supplied `ticketNumber` (e.g.
 * `HS-1234`). Fetches the ticket via `GET /api/tickets/by-number/...`
 * fallback path, opens a stacked overlay on success, shows a toast on
 * 404. Idempotent — calling twice in a row with the same number pushes
 * a duplicate dialog (intentional — the user may want to read multiple
 * branches of a chain).
 */
export async function openTicketRefDialog(ticketNumber: string): Promise<void> {
  // Lookup by number — first checks the in-memory `state.tickets` cache
  // for the active project (covers the common case: cross-references
  // within the same project the user is currently viewing). Falls back
  // to a server fetch for stale / cross-project references.
  const cached = state.tickets.find(t => t.ticket_number === ticketNumber);
  let ticket: Ticket;
  if (cached !== undefined) {
    ticket = cached;
  } else {
    try {
      ticket = await api<Ticket>(`/tickets/by-number/${encodeURIComponent(ticketNumber)}`);
    } catch {
      showToast(`Ticket ${ticketNumber} not found`, { variant: 'warning' });
      return;
    }
  }
  pushDialog(ticket);
}

function pushDialog(ticket: Ticket): void {
  // Stack offset: each new dialog shifts down + right by 30px so the
  // edges of underlying dialogs peek out and the user can see depth.
  // The backdrop sits on top of any prior dialog so its click-to-
  // dismiss only affects the topmost dialog (per the HS-8036 spec).
  const stackIndex = stack.length;
  const offset = stackIndex * 30;
  const detailsHtml = ticket.details.trim() === ''
    ? '<em class="ticket-ref-dialog-empty">(no details)</em>'
    : linkifyWithCachedPrefixes(marked.parse(ticket.details, { async: false }), ticket.ticket_number);

  // Notes — same shape as the detail panel: list of timestamp + body.
  const notes = parseNotesForDisplay(ticket.notes);
  const notesHtml = notes.length === 0
    ? '<em class="ticket-ref-dialog-empty">(no notes)</em>'
    : notes.map(n => {
        const body = n.text.trim() === ''
          ? '<em class="ticket-ref-dialog-empty">(empty note)</em>'
          : linkifyWithCachedPrefixes(marked.parse(n.text, { async: false }), ticket.ticket_number);
        const ts = n.created_at !== '' ? formatNoteTimestamp(n.created_at) : '';
        return `<div class="ticket-ref-dialog-note">${ts !== '' ? `<div class="ticket-ref-dialog-note-ts">${escape(ts)}</div>` : ''}<div class="note-markdown">${body}</div></div>`;
      }).join('');

  const overlay = toElement(
    <div className="ticket-ref-dialog-overlay" role="dialog" aria-modal="true" aria-label={`${ticket.ticket_number}: ${ticket.title}`} style={`z-index: ${2600 + stackIndex * 2};`}>
      <div className="ticket-ref-dialog-backdrop" style={`z-index: ${2600 + stackIndex * 2};`}></div>
      <div className="ticket-ref-dialog" style={`z-index: ${2601 + stackIndex * 2}; transform: translate(${offset}px, ${offset}px);`}>
        <div className="ticket-ref-dialog-header">
          <span className="ticket-ref-dialog-number">{ticket.ticket_number}</span>
          <span className="ticket-ref-dialog-title">{ticket.title}</span>
          <button className="ticket-ref-dialog-open" type="button" title="Open in detail panel" aria-label="Open in detail panel">
            {raw(OPEN_ICON)}
          </button>
          <button className="ticket-ref-dialog-close" type="button" title="Close (Esc)" aria-label="Close">
            {raw(X_ICON)}
          </button>
        </div>
        <div className="ticket-ref-dialog-meta">
          <span className={`ticket-ref-dialog-chip ticket-ref-dialog-chip-status status-${ticket.status}`}>{ticket.status}</span>
          <span className={`ticket-ref-dialog-chip ticket-ref-dialog-chip-priority priority-${ticket.priority}`}>{ticket.priority}</span>
          <span className={`ticket-ref-dialog-chip ticket-ref-dialog-chip-category category-${ticket.category}`}>{ticket.category}</span>
        </div>
        <div className="ticket-ref-dialog-body">
          <div className="ticket-ref-dialog-section">
            <div className="ticket-ref-dialog-section-label">Details</div>
            <div className="ticket-ref-dialog-section-body note-markdown">{raw(detailsHtml)}</div>
          </div>
          <div className="ticket-ref-dialog-section">
            <div className="ticket-ref-dialog-section-label">Notes</div>
            <div className="ticket-ref-dialog-section-body">{raw(notesHtml)}</div>
          </div>
        </div>
      </div>
    </div>
  );

  const entry: DialogEntry = { overlay, ticket };
  stack.push(entry);

  overlay.querySelector('.ticket-ref-dialog-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    popTopDialog();
  });
  overlay.querySelector('.ticket-ref-dialog-backdrop')?.addEventListener('click', (e) => {
    e.stopPropagation();
    popTopDialog();
  });
  overlay.querySelector('.ticket-ref-dialog-open')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllDialogs();
    openDetail(ticket.id);
  });

  document.body.appendChild(overlay);
  if (stack.length === 1) document.addEventListener('keydown', onKeydown, true);
}

function popTopDialog(): void {
  const top = stack.pop();
  if (top === undefined) return;
  top.overlay.remove();
  if (stack.length === 0) document.removeEventListener('keydown', onKeydown, true);
}

function closeAllDialogs(): void {
  while (stack.length > 0) popTopDialog();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (stack.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  popTopDialog();
}

/**
 * HS-8036 — global click handler that intercepts `.ticket-ref` anchor
 * clicks anywhere in the document. Mounted once at app init. Reads the
 * `data-ticket-number` attribute and dispatches to `openTicketRefDialog`.
 */
export function bindTicketRefGlobalClickHandler(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    const ref = target.closest<HTMLElement>('.ticket-ref');
    if (ref === null) return;
    const number = ref.dataset.ticketNumber ?? '';
    if (number === '') return;
    e.preventDefault();
    e.stopPropagation();
    void openTicketRefDialog(number);
  });
}

// --- helpers ---

function parseNotesForDisplay(rawStr: string | null | undefined): { text: string; created_at: string }[] {
  if (rawStr === null || rawStr === undefined || rawStr.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(rawStr);
    if (Array.isArray(parsed)) {
      return (parsed as { text?: unknown; created_at?: unknown }[]).map(n => ({
        text: typeof n.text === 'string' ? n.text : '',
        created_at: typeof n.created_at === 'string' ? n.created_at : '',
      }));
    }
  } catch { /* not JSON */ }
  return [{ text: rawStr, created_at: '' }];
}

function formatNoteTimestamp(iso: string): string {
  if (iso === '') return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch { return iso; }
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

