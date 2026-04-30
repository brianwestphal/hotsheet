import './markdownSetup.js';

import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { getTicketFeedbackState, pickDraftForFeedbackNote, shouldAutoShowFeedback, showFeedbackDialog } from './feedbackDialog.js';
import { type FeedbackDraft, parseNotesJson, renderNotes, setPendingFocusNoteId, setTicketDrafts } from './noteRenderer.js';
import { renderPluginDetailElements } from './pluginUI.js';
import { syncDetailReaderButton } from './readerOverlay.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_LABELS, state, STATUS_LABELS } from './state.js';
import { parseTags, renderDetailTags } from './tags.js';
import { callRenderTicketList } from './ticketListState.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';

// Re-export extracted modules for consumers that import from detail.js
export type { NoteEntry } from './noteRenderer.js';
export { displayTag, extractBracketTags, hasTag, normalizeTag, parseTags, renderDetailTags } from './tags.js';

/** Suppress auto-read for the current ticket (set when user explicitly marks as unread). */
let suppressAutoRead = false;
export function setSuppressAutoRead(suppress: boolean) { suppressAutoRead = suppress; }

/**
 * HS-8020 — paint the rendered-markdown view of a ticket's Details
 * field. Mirrors how notes already render — same `marked.parse` call,
 * same `.note-markdown` class so the inline-markdown CSS (paragraph
 * spacing, code blocks, lists, GFM tables, etc.) applies.
 *
 * Called every time the textarea value is (re-)set: after `loadDetail`,
 * after `loadPreviewDetail`, after the click-to-edit blur path, and
 * after the auto-save reload. Synchronous so the rendered view is in
 * place by the time CSS shows it.
 */
export function renderDetailsMarkdown(text: string): void {
  const rendered = document.getElementById('detail-details-rendered');
  if (rendered === null) return;
  const html = marked.parse(text, { async: false });
  // HS-8036 — wrap ticket-number references in clickable anchors after
  // markdown renders. Self-references (the current ticket's own number
  // appearing in its own details) are skipped via the cached
  // `state.activeTicketId` lookup.
  const currentTicketNumber = state.activeTicketId === null
    ? undefined
    : state.tickets.find(t => t.id === state.activeTicketId)?.ticket_number;
  rendered.innerHTML = linkifyWithCachedPrefixes(html, currentTicketNumber);
}

/**
 * HS-8020 — toggle whether the Details field is in edit mode. Adds the
 * `is-editing` class to the wrap so CSS swaps which sibling is visible
 * (rendered markdown ↔ raw textarea). When entering edit mode, focus
 * the textarea and place the caret at the end so the user can keep
 * typing. When leaving, re-render the markdown.
 *
 * Read-only mode (`setDetailReadOnly(true)` — backup preview) skips the
 * swap entirely; the rendered view stays visible and the textarea
 * stays hidden.
 */
function setDetailsEditing(editing: boolean): void {
  const wrap = document.querySelector<HTMLElement>('.detail-details-wrap');
  if (wrap === null) return;
  // Read-only check: textarea.readOnly is the source of truth (set by
  // setDetailReadOnly). Don't flip into edit mode in preview state.
  const textarea = document.getElementById('detail-details') as HTMLTextAreaElement | null;
  if (editing && textarea?.readOnly === true) return;
  wrap.classList.toggle('is-editing', editing);
  if (editing && textarea !== null) {
    textarea.focus();
    // Caret-at-end so a click-to-edit doesn't drop the caret at position 0.
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  } else if (!editing && textarea !== null) {
    renderDetailsMarkdown(textarea.value);
  }
}

export function bindDetailDetailsRenderToggle(): void {
  const rendered = document.getElementById('detail-details-rendered');
  const textarea = document.getElementById('detail-details') as HTMLTextAreaElement | null;
  if (rendered === null || textarea === null) return;
  // Click anywhere in the rendered view → enter edit mode + focus the
  // textarea. Anchor (links inside rendered markdown) clicks are still
  // intercepted here, so we don't accidentally swallow target=_blank
  // navigation — we only swap modes.
  rendered.addEventListener('click', (e) => {
    // Let internal links navigate normally.
    const a = (e.target as HTMLElement).closest('a');
    if (a !== null && a.getAttribute('href') !== null) return;
    setDetailsEditing(true);
  });
  // Tab-focus also enters edit mode so keyboard users can edit.
  rendered.addEventListener('focus', () => {
    setDetailsEditing(true);
  });
  // Leaving the textarea drops back to rendered view. Suppressed when
  // focus is moving to another element inside the same wrap (e.g. the
  // reader-mode book button) so the user isn't bounced out unnecessarily.
  textarea.addEventListener('blur', (e) => {
    const next = (e).relatedTarget as HTMLElement | null;
    const wrap = textarea.closest('.detail-details-wrap');
    if (next !== null && wrap !== null && wrap.contains(next)) return;
    setDetailsEditing(false);
  });
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

export function openDetail(id: number) {
  suppressAutoRead = false; // Reset when switching tickets
  state.activeTicketId = id;
  void loadDetail(id);
}

/** Open detail and, after notes render, scroll to and focus a specific note. */
export function openDetailAndFocusNote(id: number, noteId: string) {
  setPendingFocusNoteId(noteId);
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

  // Respect the user's detail-panel visibility preference — if they've hidden
  // the panel via the position toggle, don't re-show it just because a row was
  // selected/deselected. The panel is only re-shown by explicit user action
  // (clicking a position toggle).
  if (!state.settings.detail_visible) {
    panel.style.display = 'none';
    if (handle) handle.style.display = 'none';
    return;
  }

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
  // HS-8020 — paint the markdown-rendered view alongside the textarea
  // so the read-only preview shows formatted details (matches the live
  // detail panel post-fix).
  renderDetailsMarkdown(ticket.details);
  // HS-7957 — sync the Details reader-mode button after populating the
  // textarea so it disables itself for empty-Details tickets.
  syncDetailReaderButton();

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

  // Mark ticket as read — only if it's currently unread (prevents unnecessary PATCHes on poll refresh)
  if (!suppressAutoRead) {
    const inMemory = state.tickets.find(t => t.id === id);
    const isUnread = inMemory != null && inMemory.last_read_at != null && inMemory.updated_at > inMemory.last_read_at;
    if (isUnread) {
      const readAt = new Date().toISOString();
      inMemory.last_read_at = readAt;
      callRenderTicketList(); // Immediately hide the blue dot in the list/column view
      void api(`/tickets/${id}`, { method: 'PATCH', body: { last_read_at: readAt } }).catch(() => {});
    }
  }

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
  // HS-8020 — paint the markdown-rendered view on every detail-load so
  // the rendered view stays current with the source. Skip the swap to
  // edit mode if the textarea is currently focused (HS-1454 cursor-
  // disruption rule); but always re-render the rendered sibling because
  // CSS keeps it hidden when `is-editing` is set.
  renderDetailsMarkdown(detailsArea.value);
  // HS-7957 — keep the Details reader-mode book button's `disabled` state in
  // sync with the textarea's current emptiness on every detail-load. Without
  // this, opening a ticket with empty Details would show the button enabled
  // (initial bind state was for a fresh empty textarea, but subsequent loads
  // could leave the previous ticket's enabled state stale).
  syncDetailReaderButton();

  // Render attachments with selection support
  const attContainer = document.getElementById('detail-attachments')!;
  if (ticket.attachments.length > 0) {
    attContainer.innerHTML = (<>
      {ticket.attachments.map(att =>
        <div className="attachment-item" tabIndex={0} data-att-id={String(att.id)} data-stored-path={att.stored_path} data-filename={att.original_filename}>
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
  const parsedNotes = parseNotesJson(ticket.notes);
  // HS-7822 — auto-show the feedback dialog if the last note is a FEEDBACK
  // NEEDED request, but ONLY after we know whether a saved draft for that
  // note exists. Pre-fix, the auto-show fired synchronously with `prompt`
  // alone while the drafts fetch was fire-and-forget — so on relaunch the
  // user always saw the original feedback form, never their draft. Now the
  // gate is held until drafts arrive (or fail) and we pass the matching
  // draft as `draftSeed` when one is found.
  const feedbackState = getTicketFeedbackState(parsedNotes);
  if (!noteBeingEdited || document.activeElement !== noteBeingEdited) {
    renderNotes(ticket.id, parsedNotes);
    // HS-7599: load any feedback drafts for this ticket and re-render once
    // they arrive so saved drafts appear inline below their parent FEEDBACK
    // NEEDED note (or free-floating at the end if the parent's gone).
    void api<FeedbackDraft[]>(`/tickets/${ticket.id}/feedback-drafts`).then((drafts) => {
      const list = Array.isArray(drafts) ? drafts : [];
      setTicketDrafts(ticket.id, list);
      // Only re-render if the panel is still showing this ticket and no
      // note is being edited (avoid clobbering an in-progress edit).
      if (state.activeTicketId === ticket.id) {
        const editingNow = document.getElementById('detail-notes')?.querySelector('.note-edit-area') as HTMLElement | null;
        if (editingNow === null || document.activeElement !== editingNow) {
          renderNotes(ticket.id, parsedNotes);
        }
      }
      // HS-7822 auto-show with optional draft seed.
      if (feedbackState !== null && state.activeTicketId === ticket.id
          && shouldAutoShowFeedback(ticket.id, feedbackState.noteId)) {
        const seed = pickDraftForFeedbackNote(list, feedbackState.noteId);
        requestAnimationFrame(() => {
          if (seed !== null) {
            showFeedbackDialog(ticket.id, ticket.ticket_number, seed.promptText, {
              id: seed.id,
              parentNoteId: seed.parentNoteId,
              promptText: seed.promptText,
              partitions: seed.partitions,
            });
          } else {
            showFeedbackDialog(ticket.id, ticket.ticket_number, feedbackState.prompt);
          }
        });
      }
    }).catch(() => {
      // Drafts fetch failed (older server / transient network) — fall back
      // to the original auto-show flow without a seed so the user still
      // gets prompted.
      if (feedbackState !== null && state.activeTicketId === ticket.id
          && shouldAutoShowFeedback(ticket.id, feedbackState.noteId)) {
        requestAnimationFrame(() => showFeedbackDialog(ticket.id, ticket.ticket_number, feedbackState.prompt));
      }
    });
  } else if (feedbackState !== null && shouldAutoShowFeedback(id, feedbackState.noteId)) {
    // The user is editing a note in this panel and we're skipping the
    // drafts re-render. Auto-show without a seed — losing the edit by
    // clobbering with renderNotes is worse than showing a stale form;
    // the user can dismiss the dialog and pick the draft from the list.
    requestAnimationFrame(() => showFeedbackDialog(id, ticket.ticket_number, feedbackState.prompt));
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
