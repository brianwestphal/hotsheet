import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import type { Ticket } from './state.js';
import { state } from './state.js';

// --- Detail panel ---

export function openDetail(id: number) {
  state.activeTicketId = id;
  void loadDetail(id);
}

export function closeDetail() {
  state.selectedIds.clear();
  state.activeTicketId = null;
  // Trigger re-render via import
  const event = new CustomEvent('hotsheet:render');
  document.dispatchEvent(event);
}

export function syncDetailPanel() {
  const isTrash = state.view === 'trash';
  const panel = document.getElementById('detail-panel')!;
  const handle = document.getElementById('detail-resize-handle');

  if (state.selectedIds.size === 1 && !isTrash) {
    const id = Array.from(state.selectedIds)[0];
    panel.style.display = 'flex';
    if (handle) handle.style.display = '';
    if (state.activeTicketId !== id) {
      state.activeTicketId = id;
      void loadDetail(id);
    }
  } else {
    if (state.activeTicketId != null) {
      state.activeTicketId = null;
    }
    panel.style.display = 'none';
    if (handle) handle.style.display = 'none';
  }
}

async function loadDetail(id: number) {
  const ticket = await api<Ticket & { attachments: { id: number; original_filename: string; stored_path: string }[] }>(
    `/tickets/${id}`
  );
  if (state.activeTicketId !== id) return;

  (document.getElementById('detail-ticket-number') as HTMLElement).textContent = ticket.ticket_number;
  (document.getElementById('detail-title') as HTMLInputElement).value = ticket.title;
  (document.getElementById('detail-category') as HTMLSelectElement).value = ticket.category;
  (document.getElementById('detail-priority') as HTMLSelectElement).value = ticket.priority;
  (document.getElementById('detail-status') as HTMLSelectElement).value = ticket.status;
  (document.getElementById('detail-upnext') as HTMLInputElement).checked = ticket.up_next;
  (document.getElementById('detail-details') as HTMLTextAreaElement).value = ticket.details;

  // Render attachments via JSX
  const attContainer = document.getElementById('detail-attachments')!;
  if (ticket.attachments.length > 0) {
    attContainer.innerHTML = (<>
      {ticket.attachments.map(att =>
        <div className="attachment-item">
          <span className="attachment-name">{att.original_filename}</span>
          <button className="attachment-delete" data-att-id={String(att.id)} title="Remove">{raw('&times;')}</button>
        </div>
      )}
    </>).toString();
  } else {
    attContainer.innerHTML = '';
  }

  // Render notes (read-only, timestamped entries)
  const notesSection = document.getElementById('detail-notes-section')!;
  const notesContainer = document.getElementById('detail-notes')!;
  const notes = parseNotesJson(ticket.notes);
  if (notes.length > 0) {
    notesSection.style.display = '';
    notesContainer.innerHTML = (<>
      {notes.map(note =>
        <div className="note-entry">
          {note.created_at ? <div className="note-timestamp">{new Date(note.created_at).toLocaleString()}</div> : null}
          <div className="note-text">{note.text}</div>
        </div>
      )}
    </>).toString();
  } else {
    notesSection.style.display = 'none';
    notesContainer.innerHTML = '';
  }

  // Meta info
  const meta = document.getElementById('detail-meta')!;
  meta.innerHTML = (<>
    <div>Created: {new Date(ticket.created_at).toLocaleString()}</div>
    <div>Updated: {new Date(ticket.updated_at).toLocaleString()}</div>
    {ticket.completed_at ? <div>Completed: {new Date(ticket.completed_at).toLocaleString()}</div> : null}
    {ticket.verified_at ? <div>Verified: {new Date(ticket.verified_at).toLocaleString()}</div> : null}
  </>).toString();
}

function parseNotesJson(raw: string): { text: string; created_at: string }[] {
  if (!raw || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  if (raw.trim()) return [{ text: raw, created_at: '' }];
  return [];
}

// --- Stats ---

export async function updateStats() {
  try {
    const stats = await api<{
      total: number;
      open: number;
      up_next: number;
    }>('/stats');
    const bar = document.getElementById('status-bar');
    if (bar) {
      bar.textContent = `${stats.total} tickets \u00B7 ${stats.open} open \u00B7 ${stats.up_next} up next`;
    }
  } catch { /* ignore */ }
}

// --- Detail panel orientation ---

export function applyDetailPosition(position: 'side' | 'bottom') {
  const contentArea = document.getElementById('content-area')!;
  contentArea.classList.remove('detail-side', 'detail-bottom');
  contentArea.classList.add(position === 'bottom' ? 'detail-bottom' : 'detail-side');
}

export function applyDetailSize() {
  const panel = document.getElementById('detail-panel')!;
  if (state.settings.detail_position === 'bottom') {
    panel.style.width = '';
    panel.style.height = `${state.settings.detail_height}px`;
  } else {
    panel.style.height = '';
    panel.style.width = `${state.settings.detail_width}px`;
  }
}

// --- Resize handle ---

export function initResize() {
  const handle = document.getElementById('detail-resize-handle')!;
  const panel = document.getElementById('detail-panel')!;
  const contentArea = document.getElementById('content-area')!;

  let isResizing = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    document.body.style.cursor = state.settings.detail_position === 'bottom' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const rect = contentArea.getBoundingClientRect();

    if (state.settings.detail_position === 'bottom') {
      const newHeight = Math.max(150, Math.min(500, rect.bottom - e.clientY));
      state.settings.detail_height = newHeight;
      panel.style.height = `${newHeight}px`;
    } else {
      const newWidth = Math.max(250, Math.min(600, rect.right - e.clientX));
      state.settings.detail_width = newWidth;
      panel.style.width = `${newWidth}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (state.settings.detail_position === 'bottom') {
      void api('/settings', { method: 'PATCH', body: { detail_height: String(state.settings.detail_height) } });
    } else {
      void api('/settings', { method: 'PATCH', body: { detail_width: String(state.settings.detail_width) } });
    }
  });
}
