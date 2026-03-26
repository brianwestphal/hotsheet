import { api } from './api.js';
import { toElement } from './dom.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, getPriorityColor, getPriorityIcon, getStatusIcon, state } from './state.js';
import { pushNotesUndo } from './undo/actions.js';

// --- Tags helpers ---

/** Normalize a tag: collapse non-alphanumeric runs to single space, lowercase, trim. */
export function normalizeTag(input: string): string {
  return input.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}

/** Display a tag in Title Case. */
export function displayTag(tag: string): string {
  return tag.replace(/\b\w/g, c => c.toUpperCase());
}

/** Check if a tag already exists in a list (case-insensitive, normalized). */
export function hasTag(tags: string[], tag: string): boolean {
  const norm = normalizeTag(tag);
  return tags.some(t => normalizeTag(t) === norm);
}

/** Extract bracket tags from a title, returning cleaned title and tag list.
 *  e.g. " [admin ] this is a ticket [dashboard] " → { title: "this is a ticket", tags: ["admin", "dashboard"] } */
export function extractBracketTags(input: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  // Extract all [tag] patterns
  const cleaned = input.replace(/\[([^\]]*)\]/g, (_match, content: string) => {
    const tag = normalizeTag(content);
    if (tag && !tags.some(t => t === tag)) tags.push(tag);
    return ' '; // replace bracket with space
  });
  // Clean up extra whitespace
  const title = cleaned.replace(/\s+/g, ' ').trim();
  return { title, tags };
}

export function parseTags(raw: string): string[] {
  if (!raw || raw === '[]') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t: unknown) => typeof t === 'string' && t.trim());
  } catch { /* ignore */ }
  return [];
}

export function renderDetailTags(tags: string[], readOnly: boolean) {
  const container = document.getElementById('detail-tags');
  if (!container) return;
  container.innerHTML = '';
  for (const tag of tags) {
    const chip = toElement(
      <span className="tag-chip">
        {displayTag(tag)}
        {readOnly ? null : <button className="tag-chip-remove" data-tag={tag} title="Remove tag">{'\u00d7'}</button>}
      </span>
    );
    if (!readOnly) {
      chip.querySelector('.tag-chip-remove')!.addEventListener('click', async () => {
        if (state.activeTicketId == null) return;
        const ticket = state.tickets.find(t => t.id === state.activeTicketId);
        if (!ticket) return;
        const currentTags = parseTags(ticket.tags);
        const updated = currentTags.filter(t => t !== tag);
        await api(`/tickets/${state.activeTicketId}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
        ticket.tags = JSON.stringify(updated);
        renderDetailTags(updated, false);
      });
    }
    container.appendChild(chip);
  }
}

// --- Detail field button helpers ---

const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not Started', started: 'Started', completed: 'Completed',
  verified: 'Verified', backlog: 'Backlog', archive: 'Archive',
};

const PRIORITY_LABELS: Record<string, string> = {
  highest: 'Highest', high: 'High', default: 'Default', low: 'Low', lowest: 'Lowest',
};

export function updateDetailCategory(value: string) {
  const btn = document.getElementById('detail-category') as HTMLButtonElement;
  btn.dataset.value = value;
  const cat = state.categories.find(c => c.id === value);
  const color = getCategoryColor(value);
  btn.innerHTML = `<span class="cat-dot" style="background:${color}"></span> ${cat?.label || value}`;
}

export function updateDetailPriority(value: string) {
  const btn = document.getElementById('detail-priority') as HTMLButtonElement;
  btn.dataset.value = value;
  btn.innerHTML = `<span class="dropdown-icon" style="color:${getPriorityColor(value)}">${getPriorityIcon(value)}</span> ${PRIORITY_LABELS[value] || value}`;
}

export function updateDetailStatus(value: string) {
  const btn = document.getElementById('detail-status') as HTMLButtonElement;
  btn.dataset.value = value;
  btn.innerHTML = `<span class="dropdown-icon">${getStatusIcon(value)}</span> ${STATUS_LABELS[value] || value}`;
}

// --- Detail panel ---

export function openDetail(id: number) {
  state.activeTicketId = id;
  void loadDetail(id);
}

export function closeDetail() {
  state.selectedIds.clear();
  state.activeTicketId = null;
  syncDetailPanel();
  // Trigger re-render for selection classes
  const event = new CustomEvent('hotsheet:render');
  document.dispatchEvent(event);
}

export function syncDetailPanel() {
  const isTrash = state.view === 'trash';
  const isPreview = !!state.backupPreview?.active;
  const panel = document.getElementById('detail-panel')!;
  const handle = document.getElementById('detail-resize-handle');
  const header = document.getElementById('detail-header')!;
  const body = document.getElementById('detail-body')!;
  const placeholder = document.getElementById('detail-placeholder')!;
  const placeholderText = document.getElementById('detail-placeholder-text')!;

  if (isTrash) {
    panel.style.display = 'none';
    if (handle) handle.style.display = 'none';
    state.activeTicketId = null;
    return;
  }

  // Always show the panel
  panel.style.display = 'flex';
  if (handle) handle.style.display = '';

  if (state.selectedIds.size === 1) {
    const id = Array.from(state.selectedIds)[0];
    // Show ticket detail
    panel.classList.remove('detail-disabled');
    header.style.display = '';
    body.style.display = '';
    placeholder.style.display = 'none';
    if (state.activeTicketId !== id) {
      state.activeTicketId = id;
      if (isPreview) {
        loadPreviewDetail(id);
      } else {
        void loadDetail(id);
      }
    }
  } else {
    // Disabled placeholder state
    state.activeTicketId = null;
    panel.classList.add('detail-disabled');
    header.style.display = 'none';
    body.style.display = 'none';
    placeholder.style.display = '';
    if (state.selectedIds.size === 0) {
      placeholderText.textContent = 'Nothing selected';
    } else {
      placeholderText.textContent = `${state.selectedIds.size} items selected`;
    }
  }
}

function setDetailReadOnly(readOnly: boolean) {
  const titleInput = document.getElementById('detail-title') as HTMLInputElement;
  const detailsArea = document.getElementById('detail-details') as HTMLTextAreaElement;
  const catBtn = document.getElementById('detail-category') as HTMLButtonElement;
  const priBtn = document.getElementById('detail-priority') as HTMLButtonElement;
  const statusBtn = document.getElementById('detail-status') as HTMLButtonElement;
  const upnextBtn = document.getElementById('detail-upnext') as HTMLButtonElement;
  const uploadBtn = document.querySelector('.upload-btn') as HTMLElement | null;

  titleInput.readOnly = readOnly;
  detailsArea.readOnly = readOnly;
  catBtn.disabled = readOnly;
  priBtn.disabled = readOnly;
  statusBtn.disabled = readOnly;
  upnextBtn.disabled = readOnly;
  if (uploadBtn) uploadBtn.style.display = readOnly ? 'none' : '';
}

function loadPreviewDetail(id: number) {
  const ticket = state.backupPreview?.tickets.find(t => t.id === id);
  if (!ticket || state.activeTicketId !== id) return;

  (document.getElementById('detail-ticket-number') as HTMLElement).textContent = ticket.ticket_number;
  (document.getElementById('detail-title') as HTMLInputElement).value = ticket.title;
  updateDetailCategory(ticket.category);
  updateDetailPriority(ticket.priority);
  updateDetailStatus(ticket.status);
  const upnextBtn = document.getElementById('detail-upnext') as HTMLButtonElement;
  upnextBtn.textContent = ticket.up_next ? '\u2605' : '\u2606';
  upnextBtn.classList.toggle('active', ticket.up_next);
  (document.getElementById('detail-details') as HTMLTextAreaElement).value = ticket.details;

  setDetailReadOnly(true);

  // No attachments in backup preview
  document.getElementById('detail-attachments')!.innerHTML = '';

  // Tags (read-only in preview)
  renderDetailTags(parseTags(ticket.tags), true);

  // Render notes (read-only in preview)
  const notesContainer = document.getElementById('detail-notes')!;
  const notes = parseNotesJson(ticket.notes);
  if (notes.length > 0) {
    notesContainer.innerHTML = (<>
      {notes.map(note =>
        <div className="note-entry">
          {note.created_at ? <div className="note-timestamp">{new Date(note.created_at).toLocaleString()}</div> : null}
          <div className="note-text">{note.text}</div>
        </div>
      )}
    </>).toString();
  } else {
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

/** Force-reload the detail panel for the currently active ticket.
 *  Skips updating text fields that currently have focus to avoid cursor disruption. */
export function refreshDetail() {
  if (state.activeTicketId != null) {
    void loadDetail(state.activeTicketId);
  }
}

async function loadDetail(id: number) {
  const ticket = await api<Ticket & { attachments: { id: number; original_filename: string; stored_path: string }[] }>(
    `/tickets/${id}`
  );
  if (state.activeTicketId !== id) return;

  // Restore inputs to editable (in case we were in preview mode before)
  setDetailReadOnly(false);

  (document.getElementById('detail-ticket-number') as HTMLElement).textContent = ticket.ticket_number;

  // Skip updating text fields that are currently focused to avoid cursor disruption (HS-1454)
  const titleInput = document.getElementById('detail-title') as HTMLInputElement;
  if (document.activeElement !== titleInput) {
    titleInput.value = ticket.title;
  }
  updateDetailCategory(ticket.category);
  updateDetailPriority(ticket.priority);
  updateDetailStatus(ticket.status);
  const upnextBtn = document.getElementById('detail-upnext') as HTMLButtonElement;
  upnextBtn.textContent = ticket.up_next ? '\u2605' : '\u2606';
  upnextBtn.classList.toggle('active', ticket.up_next);
  const detailsArea = document.getElementById('detail-details') as HTMLTextAreaElement;
  if (document.activeElement !== detailsArea) {
    detailsArea.value = ticket.details;
  }

  // Render attachments via JSX
  const attContainer = document.getElementById('detail-attachments')!;
  if (ticket.attachments.length > 0) {
    attContainer.innerHTML = (<>
      {ticket.attachments.map(att =>
        <div className="attachment-item">
          <span className="attachment-name">{att.original_filename}</span>
          <button className="attachment-reveal" data-att-id={String(att.id)} title="Show in file manager"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
          <button className="attachment-delete" data-att-id={String(att.id)} title="Remove">{'\u00d7'}</button>
        </div>
      )}
    </>).toString();
  } else {
    attContainer.innerHTML = '';
  }

  // Render tags
  renderDetailTags(parseTags(ticket.tags), false);

  // Skip re-rendering notes if a note is currently being edited (HS-1454)
  const notesContainer = document.getElementById('detail-notes');
  const noteBeingEdited = notesContainer?.querySelector('.note-edit-area') as HTMLElement | null;
  if (!noteBeingEdited || document.activeElement !== noteBeingEdited) {
    renderNotes(ticket.id, parseNotesJson(ticket.notes));
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

type NoteEntry = { id?: string; text: string; created_at: string };

function syncNotesToState(ticketId: number, notes: NoteEntry[]) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (ticket) ticket.notes = JSON.stringify(notes);
}

function renderNotes(ticketId: number, notes: NoteEntry[]) {
  const container = document.getElementById('detail-notes');
  if (!container) return;
  container.innerHTML = '';

  if (notes.length === 0) {
    container.innerHTML = '<div class="notes-empty">No notes added</div>';
    return;
  }

  for (const note of notes) {
    const entry = toElement(
      <div className="note-entry">
        {note.created_at ? <div className="note-timestamp">{new Date(note.created_at).toLocaleString()}</div> : null}
        <div className="note-text">{note.text}</div>
      </div>
    );

    // Click to edit
    {
      entry.addEventListener('click', () => {
        const textEl = entry.querySelector('.note-text') as HTMLElement;
        if (entry.querySelector('.note-edit-area')) return;
        const textarea = document.createElement('textarea');
        textarea.className = 'note-edit-area';
        textarea.value = note.text;
        textarea.rows = 3;
        textEl.style.display = 'none';
        entry.appendChild(textarea);
        textarea.focus();

        const save = async () => {
          const newText = textarea.value.trim();
          if (newText && newText !== note.text) {
            const ticket = state.tickets.find(t => t.id === ticketId);
            const afterNotes = notes.map(n => n.id === note.id ? { ...n, text: newText } : n);
            if (ticket) pushNotesUndo(ticket, 'Edit note', JSON.stringify(afterNotes));
            await api(`/tickets/${ticketId}/notes/${note.id}`, { method: 'PATCH', body: { text: newText } });
            note.text = newText;
            syncNotesToState(ticketId, notes);
          }
          renderNotes(ticketId, notes);
        };

        textarea.addEventListener('blur', () => { void save(); });
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.stopPropagation(); textarea.blur(); }
        });
      });

      // Right-click to delete
      entry.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        document.querySelectorAll('.note-context-menu').forEach(m => m.remove());

        const menu = toElement(
          <div className="note-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
            <div className="context-menu-item danger">
              <span className="context-menu-label">Delete Note</span>
            </div>
          </div>
        );
        menu.querySelector('.context-menu-item')!.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          menu.remove();
          const ticket = state.tickets.find(t => t.id === ticketId);
          const afterNotes = notes.filter(n => n.id !== note.id);
          if (ticket) pushNotesUndo(ticket, 'Delete note', JSON.stringify(afterNotes));
          await api(`/tickets/${ticketId}/notes/${note.id}`, { method: 'DELETE' });
          const idx = notes.indexOf(note);
          if (idx >= 0) notes.splice(idx, 1);
          syncNotesToState(ticketId, notes);
          renderNotes(ticketId, notes);
        });
        document.body.appendChild(menu);
        setTimeout(() => {
          const close = () => { menu.remove(); document.removeEventListener('click', close); };
          document.addEventListener('click', close);
        }, 0);
      });
    }

    container.appendChild(entry);
  }
}

let noteIdCounter = 0;
function clientNoteId(): string { return `cn_${Date.now().toString(36)}_${(noteIdCounter++).toString(36)}`; }

function parseNotesJson(raw: string): NoteEntry[] {
  if (!raw || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((n: { id?: string; text: string; created_at: string }) => ({
        id: n.id || clientNoteId(),
        text: n.text,
        created_at: n.created_at,
      }));
    }
  } catch { /* not JSON */ }
  if (raw.trim()) return [{ id: clientNoteId(), text: raw, created_at: '' }];
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
