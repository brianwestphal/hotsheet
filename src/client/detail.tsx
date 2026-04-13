import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import type { Ticket } from './state.js';
import { getActiveProject, getCategoryColor, getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_LABELS, state, STATUS_LABELS } from './state.js';
import { renderPluginDetailElements } from './pluginUI.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { pushNotesUndo } from './undo/actions.js';

// Configure marked for safe rendering
marked.setOptions({ breaks: true });

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
 *  e.g. " [admin ] this is a ticket [dashboard] " returns \{ title: "this is a ticket", tags: ["admin", "dashboard"] \} */
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
  if (raw === '' || raw === '[]') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return (parsed as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '');
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

export function updateDetailCategory(value: string) {
  const btn = document.getElementById('detail-category') as HTMLButtonElement;
  btn.dataset.value = value;
  const cat = state.categories.find(c => c.id === value);
  const color = getCategoryColor(value);
  const dot = toElement(<span className="cat-dot" style={`background:${color}`}></span>);
  btn.textContent = '';
  btn.appendChild(dot);
  btn.append(` ${cat?.label ?? value}`);
}

export function updateDetailPriority(value: string) {
  const btn = document.getElementById('detail-priority') as HTMLButtonElement;
  btn.dataset.value = value;
  const icon = toElement(<span className="dropdown-icon" style={`color:${getPriorityColor(value)}`}>{raw(getPriorityIcon(value))}</span>);
  btn.textContent = '';
  btn.appendChild(icon);
  btn.append(` ${PRIORITY_LABELS[value] || value}`);
}

export function updateDetailStatus(value: string) {
  const btn = document.getElementById('detail-status') as HTMLButtonElement;
  btn.dataset.value = value;
  const icon = toElement(<span className="dropdown-icon">{raw(getStatusIcon(value))}</span>);
  btn.textContent = '';
  btn.appendChild(icon);
  btn.append(` ${STATUS_LABELS[value] || value}`);
}

// --- Detail panel ---

/** Note ID to scroll-to and focus after the next renderNotes pass. */
let pendingFocusNoteId: string | null = null;

export function openDetail(id: number) {
  state.activeTicketId = id;
  void loadDetail(id);
}

/** Open detail and, after notes render, scroll to and focus a specific note. */
export function openDetailAndFocusNote(id: number, noteId: string) {
  pendingFocusNoteId = noteId;
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
  const isPreview = state.backupPreview?.active === true;
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
  const uploadBtn = document.querySelector<HTMLElement>('.upload-btn');

  titleInput.readOnly = readOnly;
  detailsArea.readOnly = readOnly;
  catBtn.disabled = readOnly;
  priBtn.disabled = readOnly;
  statusBtn.disabled = readOnly;
  upnextBtn.disabled = readOnly;
  if (uploadBtn !== null) uploadBtn.style.display = readOnly ? 'none' : '';
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
          <div className="note-text note-markdown">{raw(marked.parse(note.text, { async: false }))}</div>
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
    {ticket.completed_at !== null && ticket.completed_at !== '' ? <div>Completed: {new Date(ticket.completed_at).toLocaleString()}</div> : null}
    {ticket.verified_at !== null && ticket.verified_at !== '' ? <div>Verified: {new Date(ticket.verified_at).toLocaleString()}</div> : null}
  </>).toString();
}

/** Force-reload the detail panel for the currently active ticket.
 *  Skips updating text fields that currently have focus to avoid cursor disruption. */
export function refreshDetail() {
  if (state.activeTicketId != null) {
    void loadDetail(state.activeTicketId);
  }
}

interface SyncInfoResponse {
  pluginId: string;
  pluginName: string;
  pluginIcon: string | null;
  remoteId: string;
  remoteUrl: string | null;
  syncStatus: string;
}

async function loadDetail(id: number) {
  const ticket = await api<Ticket & { attachments: { id: number; original_filename: string; stored_path: string }[]; syncInfo?: SyncInfoResponse[] }>(
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
    {ticket.completed_at !== null && ticket.completed_at !== '' ? <div>Completed: {new Date(ticket.completed_at).toLocaleString()}</div> : null}
    {ticket.verified_at !== null && ticket.verified_at !== '' ? <div>Verified: {new Date(ticket.verified_at).toLocaleString()}</div> : null}
    {ticket.syncInfo && ticket.syncInfo.length > 0 ? <>
      {ticket.syncInfo.map(s =>
        <div className="detail-sync-info">
          {s.pluginIcon != null && s.pluginIcon !== '' ? raw(s.pluginIcon) : raw('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>')}
          {s.remoteUrl != null && s.remoteUrl !== ''
            ? <a href={s.remoteUrl} target="_blank" rel="noopener">{s.pluginName} #{s.remoteId}</a>
            : <span>{s.pluginName} #{s.remoteId}</span>}
        </div>
      )}
    </> : null}
  </>).toString();

  // Render plugin UI extensions for the detail panel
  const detailTop = document.getElementById('plugin-detail-top');
  const detailBottom = document.getElementById('plugin-detail-bottom');
  if (detailTop) { detailTop.innerHTML = ''; renderPluginDetailElements(detailTop, 'detail_top', [ticket.id]); }
  if (detailBottom) { detailBottom.innerHTML = ''; renderPluginDetailElements(detailBottom, 'detail_bottom', [ticket.id]); }
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
    container.replaceChildren(toElement(<div className="notes-empty">No notes added</div>));
    return;
  }

  for (const note of notes) {
    const isEmpty = note.text.trim() === '';
    const renderedText = isEmpty ? '' : marked.parse(note.text, { async: false });
    const entry = toElement(
      <div className={`note-entry${isEmpty ? ' note-empty' : ''}`} data-note-id={note.id ?? ''}>
        {note.created_at ? <div className="note-timestamp">{new Date(note.created_at).toLocaleString()}</div> : null}
        <div className="note-text note-markdown">
          {isEmpty ? <span className="note-placeholder">Click to add a note...</span> : raw(renderedText)}
        </div>
      </div>
    );

    // Click to edit
    {
      entry.addEventListener('click', () => {
        const textEl = entry.querySelector('.note-text') as HTMLElement;
        if (entry.querySelector('.note-edit-area')) return;
        const textarea = toElement(<textarea className="note-edit-area" rows={3}></textarea>) as HTMLTextAreaElement;
        textarea.value = note.text;
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

    // Rewrite GitHub image URLs to go through the server-side proxy so private
    // repo images render (the browser can't fetch them without the PAT).
    proxyGitHubImages(entry);

    // Add clickable download links for any images in the note.
    appendImageDownloadLinks(entry);

    container.appendChild(entry);
  }

  // If a note was just created, scroll to it and open edit mode.
  if (pendingFocusNoteId != null && pendingFocusNoteId !== '') {
    const targetId = pendingFocusNoteId;
    pendingFocusNoteId = null;
    requestAnimationFrame(() => {
      const noteEl = container.querySelector<HTMLElement>(`[data-note-id="${targetId}"]`);
      if (!noteEl) return;
      noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      noteEl.click();
    });
  }
}

/** Rewrite <img> src attributes that point to GitHub domains to go through
 *  the /api/plugins/github-issues/image-proxy endpoint. Includes the project
 *  secret as a query param so the server resolves the correct project context
 *  (img tags can't send custom headers). */
function proxyGitHubImages(container: HTMLElement) {
  const GITHUB_HOSTS = new Set([
    'github.com',
    'raw.githubusercontent.com',
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com',
    'objects.githubusercontent.com',
  ]);
  const projectParam = getActiveProject()?.secret;
  for (const img of container.querySelectorAll('img')) {
    try {
      const url = new URL(img.src);
      if (!GITHUB_HOSTS.has(url.hostname)) continue;
      let proxyUrl = `/api/plugins/github-issues/image-proxy?url=${encodeURIComponent(img.src)}`;
      if (projectParam != null && projectParam !== '') proxyUrl += `&project=${encodeURIComponent(projectParam)}`;
      img.src = proxyUrl;
    } catch { /* ignore invalid URLs */ }
  }
}

/** For notes containing images, append a list of clickable download links
 *  below the note content. Extracts filenames from alt text or URL path. */
function appendImageDownloadLinks(entry: HTMLElement) {
  const imgs = entry.querySelectorAll('.note-text img');
  if (imgs.length === 0) return;

  const links = toElement(<div className="note-image-links"></div>);
  for (const img of imgs) {
    const src = (img as HTMLImageElement).src;
    const alt = (img as HTMLImageElement).alt;
    // Derive a display name: prefer alt text, fall back to filename from URL path.
    let name = alt && alt !== 'Image' ? alt : '';
    if (!name) {
      try {
        const path = new URL(src).pathname;
        const lastSegment = path.split('/').pop() ?? '';
        // Strip timestamp prefix (e.g. "mnwdok95-") from Hot Sheet uploads.
        name = lastSegment.replace(/^[a-z0-9]+-/i, '') || lastSegment || 'image';
      } catch { name = 'image'; }
    }
    const link = toElement(
      <button className="note-image-link" title={`Download ${name}`}>
        {raw('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>')}
        <span>{name}</span>
      </button>
    );
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void downloadImage(src, name);
    });
    links.appendChild(link);
  }
  entry.appendChild(links);
}

/** Download an image — works in both web browsers and Tauri's webview. */
async function downloadImage(src: string, name: string) {
  const invoke = getTauriInvoke();
  if (invoke) {
    // Tauri: WKWebView doesn't support <a download>. Open the image in the
    // system browser where the user can save-as.
    const fullUrl = src.startsWith('/') ? window.location.origin + src : src;
    try { await invoke('open_url', { url: fullUrl }); } catch { /* ignore */ }
    return;
  }
  // Web: fetch the image as a blob and trigger a download via a temporary <a>.
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 100);
  } catch {
    // Last resort: navigate directly
    window.open(src, '_blank');
  }
}

let noteIdCounter = 0;
function clientNoteId(): string { return `cn_${Date.now().toString(36)}_${(noteIdCounter++).toString(36)}`; }

function parseNotesJson(raw: string): NoteEntry[] {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return (parsed as { id?: string; text: string; created_at: string }[]).map((n) => ({
        id: n.id ?? clientNoteId(),
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
