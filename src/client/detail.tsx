import './markdownSetup.js';

import { marked } from 'marked';

import { getFeedbackDrafts, getStats, getTicketDetail, updateSettings, updateTicket } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { raw } from '../jsx-runtime.js';
import { renderClaimedByChip } from './claimedByChip.js';
import { claimsByTicketId, nowTick } from './claimsStore.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { buildFeedbackNav, getTicketFeedbackState, pickDraftForFeedbackNote, shouldAutoShowFeedback, showFeedbackDialog, toDraftSeed } from './feedbackDialog.js';
import { recordInteraction } from './longTaskObserver.js';
import { parseNotesJson, renderNotes, setPendingFocusNoteId, setTicketDrafts } from './noteRenderer.js';
import { renderPluginDetailElements } from './pluginUI.js';
import { effect, morph, signal } from './reactive.js';
import { syncDetailReaderButton } from './readerOverlay.js';
import { refreshSidebarCounts } from './sidebarCounts.js';
import { getCategoryColor, getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_LABELS, state, STATUS_LABELS } from './state.js';
import { parseTags, renderDetailTags } from './tags.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';
import { ticketsStore } from './ticketsStore.js';

// Re-export extracted modules for consumers that import from detail.js
export type { NoteEntry } from './noteRenderer.js';
export { displayTag, extractBracketTags, hasTag, normalizeTag, parseTags, renderDetailTags } from './tags.js';

/** Suppress auto-read for the current ticket (set when user explicitly marks as unread). */
let suppressAutoRead = false;

/** HS-8864 — the ticket whose claimed-by chip the detail header shows. Set by
 *  `syncDetailPanel`; the effect in `initDetailClaimedChip` renders/clears the
 *  chip reactively as the claim set + lease countdown change. */
const detailChipTicketId = signal<number | null>(null);
let detailChipInited = false;

/** Wire the detail-header claimed-by chip (idempotent; called once at app boot).
 *  Reads `detailChipTicketId` + `claimsByTicketId`, and `nowTick` only while the
 *  open ticket is actually claimed (so an unclaimed detail view doesn't re-render
 *  every second). */
export function initDetailClaimedChip(): void {
  if (detailChipInited) return;
  detailChipInited = true;
  effect(() => {
    const slot = byIdOrNull('detail-claimed-slot');
    if (slot === null) return;
    const id = detailChipTicketId.value;
    const claim = id === null ? undefined : claimsByTicketId.value.get(id);
    if (claim === undefined) {
      if (slot.firstChild !== null) slot.replaceChildren();
      return;
    }
    slot.replaceChildren(renderClaimedByChip(claim, nowTick.value));
  });
}
export function setSuppressAutoRead(suppress: boolean) { suppressAutoRead = suppress; }

const FOLDER_REVEAL_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>;
const SYNC_FALLBACK_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>;

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
  const rendered = byIdOrNull('detail-details-rendered');
  if (rendered === null) return;
  const html = marked.parse(text, { async: false });
  // HS-8036 — wrap ticket-number references in clickable anchors after
  // markdown renders. Self-references (the current ticket's own number
  // appearing in its own details) are skipped via the cached
  // `state.activeTicketId` lookup.
  const currentTicketNumber = state.activeTicketId === null
    ? undefined
    : state.tickets.find(t => t.id === state.activeTicketId)?.ticket_number;
  // HS-8677 / §62 — `morph(el, htmlString)` accepts the raw linkified-markdown
  // output and reconciles in place (same DOM shape as the prior `innerHTML =`).
  morph(rendered, linkifyWithCachedPrefixes(html, currentTicketNumber));
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
  const textarea = byIdOrNull<HTMLTextAreaElement>('detail-details');
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
  const rendered = byIdOrNull('detail-details-rendered');
  const textarea = byIdOrNull<HTMLTextAreaElement>('detail-details');
  if (rendered === null || textarea === null) return;
  // Click anywhere in the rendered view → enter edit mode + focus the
  // textarea. Anchor (links inside rendered markdown) clicks are still
  // intercepted here, so we don't accidentally swallow target=_blank
  // navigation — we only swap modes.
  rendered.addEventListener('click', (e) => {
    // HS-8062 — defense-in-depth: skip edit-mode entry when the click
    // landed on a `.ticket-ref` (or any descendant). Previously this
    // relied on the rendered anchor's `href` being non-null, which only
    // worked once `loadTicketPrefixes()` resolved AND `renderDetailsMarkdown`
    // ran again afterward. The explicit `.ticket-ref` ancestor check
    // catches the case before linkify wraps the text in an anchor — the
    // capture-phase global handler in `ticketRefDialog.tsx` is the
    // primary defense; this is the safety net.
    const targetEl = e.target as HTMLElement | null;
    if (targetEl !== null && targetEl.closest('.ticket-ref') !== null) return;
    // Let internal links navigate normally.
    const a = targetEl?.closest('a');
    if (a !== null && a !== undefined && a.getAttribute('href') !== null) return;
    setDetailsEditing(true);
  });
  // Tab-focus also enters edit mode so keyboard users can edit.
  //
  // HS-8062 — when the user clicks a `.ticket-ref` anchor inside the
  // rendered details, WKWebView (Tauri's webview) sometimes routes focus
  // to the closest tabbable ancestor (this rendered div, via `tabIndex=0`)
  // instead of to the anchor — the anchor uses `href="javascript:void(0)"`
  // and WKWebView is conservative about focusing those. The focus then
  // fires before the document's capture-phase click handler intercepts
  // the click, pushing the wrap into edit mode underneath the dialog.
  // To avoid this, we suppress the focus-driven edit-mode entry when a
  // mousedown landed inside `rendered` within the last few hundred
  // milliseconds — that path is owned by the click handler (or the
  // global `.ticket-ref` capture-phase intercept), not the focus path.
  // Keyboard tab focus still works because there's no preceding mousedown.
  let recentMouseDownAt = 0;
  rendered.addEventListener('mousedown', () => { recentMouseDownAt = Date.now(); });
  rendered.addEventListener('focus', () => {
    if (Date.now() - recentMouseDownAt < 250) return;
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
  const btn = byId<HTMLButtonElement>('detail-category');
  btn.dataset.value = value;
  const cat = state.categories.find(c => c.id === value);
  const color = getCategoryColor(value);
  const dot = toElement(<span className="cat-dot" style={`background:${color}`}></span>);
  btn.textContent = '';
  btn.appendChild(dot);
  btn.append(` ${cat?.label ?? value}`);
}

export function updateDetailPriority(value: string) {
  const btn = byId<HTMLButtonElement>('detail-priority');
  btn.dataset.value = value;
  const icon = toElement(<span className="dropdown-icon" style={`color:${getPriorityColor(value)}`}>{getPriorityIcon(value)}</span>);
  btn.textContent = '';
  btn.appendChild(icon);
  btn.append(` ${PRIORITY_LABELS[value] || value}`);
}

export function updateDetailStatus(value: string) {
  const btn = byId<HTMLButtonElement>('detail-status');
  btn.dataset.value = value;
  const icon = toElement(<span className="dropdown-icon">{getStatusIcon(value)}</span>);
  btn.textContent = '';
  btn.appendChild(icon);
  btn.append(` ${STATUS_LABELS[value] || value}`);
}

// --- Detail panel ---

export function openDetail(id: number) {
  // HS-8054 — context for the longtask observer.
  recordInteraction(`open-detail:${id}`);
  suppressAutoRead = false; // Reset when switching tickets
  state.activeTicketId = id;
  void loadDetail(id);
}

/** HS-8742 — make `id` the sole selection AND open its detail panel. Used after
 *  a paste/drop creates a brand-new "Attachment(s)" ticket so the user lands on
 *  it ready to retitle and see the freshly-attached files. Callers reload the
 *  ticket list afterward so the row renders selected. */
export function selectAndOpenDetail(id: number) {
  state.selectedIds.clear();
  state.selectedIds.add(id);
  openDetail(id);
}

/** Open detail and, after notes render, scroll to and focus a specific note. */
export function openDetailAndFocusNote(id: number, noteId: string) {
  // HS-8054 — context for the longtask observer.
  recordInteraction(`open-detail:${id}:focus-note`);
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
  const panel = byId('detail-panel');
  const handle = byIdOrNull('detail-resize-handle');
  const header = byId('detail-header');
  const body = byId('detail-body');
  const placeholder = byId('detail-placeholder');
  const placeholderText = byId('detail-placeholder-text');

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
    // HS-8864 — drive the header claimed-by chip (cleared in preview mode, which
    // has no live claims).
    detailChipTicketId.value = isPreview ? null : id;
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
    detailChipTicketId.value = null;
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
  const titleInput = byId<HTMLInputElement>('detail-title');
  const detailsArea = byId<HTMLTextAreaElement>('detail-details');
  const catBtn = byId<HTMLButtonElement>('detail-category');
  const priBtn = byId<HTMLButtonElement>('detail-priority');
  const statusBtn = byId<HTMLButtonElement>('detail-status');
  const upnextBtn = byId<HTMLButtonElement>('detail-upnext');
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

  byId('detail-ticket-number').textContent = ticket.ticket_number;
  byId<HTMLInputElement>('detail-title').value = ticket.title;
  updateDetailCategory(ticket.category);
  updateDetailPriority(ticket.priority);
  updateDetailStatus(ticket.status);
  const upnextBtn = byId<HTMLButtonElement>('detail-upnext');
  upnextBtn.textContent = ticket.up_next ? '\u2605' : '\u2606';
  upnextBtn.classList.toggle('active', ticket.up_next);
  byId<HTMLTextAreaElement>('detail-details').value = ticket.details;
  // HS-8020 — paint the markdown-rendered view alongside the textarea
  // so the read-only preview shows formatted details (matches the live
  // detail panel post-fix).
  renderDetailsMarkdown(ticket.details);
  // HS-7957 — sync the Details reader-mode button after populating the
  // textarea so it disables itself for empty-Details tickets.
  syncDetailReaderButton();

  setDetailReadOnly(true);

  // No attachments in backup preview
  byId('detail-attachments').replaceChildren();

  // Tags (read-only in preview)
  renderDetailTags(parseTags(ticket.tags), true);

  // Render notes (read-only in preview)
  const notesContainer = byId('detail-notes');
  const notes = parseNotesJson(ticket.notes);
  if (notes.length > 0) {
    // HS-8677 / §62 — `morph()` accepts a string and reconciles `notesContainer`
    // in place, preserving focus / selection on any open note edit inputs.
    morph(notesContainer, (<>
      {notes.map(note =>
        <div className="note-entry">
          {note.created_at ? <div className="note-timestamp">{new Date(note.created_at).toLocaleString()}</div> : null}
          <div className="note-text note-markdown">{
            // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- sanitized markdown HTML from `marked.parse(...)`.
            raw(marked.parse(note.text, { async: false }))
          }</div>
        </div>
      )}
    </>).toString());
  } else {
    notesContainer.replaceChildren();
  }

  // Meta info
  const meta = byId('detail-meta');
  morph(meta, (<>
    <div>Created: {new Date(ticket.created_at).toLocaleString()}</div>
    <div>Updated: {new Date(ticket.updated_at).toLocaleString()}</div>
    {ticket.completed_at !== null && ticket.completed_at !== '' ? <div>Completed: {new Date(ticket.completed_at).toLocaleString()}</div> : null}
    {ticket.verified_at !== null && ticket.verified_at !== '' ? <div>Verified: {new Date(ticket.verified_at).toLocaleString()}</div> : null}
  </>).toString());
}

/** Force-reload the detail panel for the currently active ticket.
 *  Skips updating text fields that currently have focus to avoid cursor disruption.
 *
 *  HS-9117 — pass `forceTextFields` when the reload is a *deliberate* value
 *  change the user just asked for (undo / redo). The HS-1454 focus guard that
 *  protects in-progress typing from a background poll is wrong for undo/redo:
 *  if the user reverts while still focused in the title/details field, the new
 *  value must show immediately, not only after the panel redraws for some other
 *  reason. Background callers (poll, wsSync) keep the default `false`. */
export function refreshDetail(forceTextFields = false) {
  if (state.activeTicketId != null) {
    void loadDetail(state.activeTicketId, forceTextFields);
  }
}

/**
 * HS-9008 — re-fetch ONLY this ticket's feedback drafts and re-render its notes,
 * without the full `loadDetail` (no ticket re-fetch, no auto-show re-entry).
 * Called after "Save Draft" so the new draft card appears inline immediately
 * instead of only after navigating away + back (the draft is separate state
 * from the ticket's `notes`, so `loadTickets`'s list re-render alone left the
 * cached drafts map stale). No-op if the panel has moved to another ticket or a
 * note is being edited (don't clobber an in-progress edit).
 */
export function refreshFeedbackDrafts(ticketId: number): void {
  if (state.activeTicketId !== ticketId) return;
  void getFeedbackDrafts(ticketId).then((drafts) => {
    if (state.activeTicketId !== ticketId) return;
    setTicketDrafts(ticketId, Array.isArray(drafts) ? drafts : []);
    const editingNow = byIdOrNull('detail-notes')?.querySelector('.note-edit-area') as HTMLElement | null;
    if (editingNow !== null && document.activeElement === editingNow) return;
    const ticket = state.tickets.find(t => t.id === ticketId);
    if (ticket !== undefined) renderNotes(ticketId, parseNotesJson(ticket.notes));
  }).catch(() => { /* best-effort — drafts reappear on next detail open */ });
}

async function loadDetail(id: number, forceTextFields = false) {
  // HS-8642 — typed detail payload (ticket + attachments + syncInfo) via the
  // shared `TicketDetailSchema`; the wire shape is validated by `apiCall`.
  const ticket = await getTicketDetail(id);
  if (state.activeTicketId !== id) return;

  // Mark ticket as read — only if it's currently unread (prevents unnecessary PATCHes on poll refresh).
  // HS-8419 — route through `ticketsStore.actions.applyServerUpdate` so the
  // per-ticket signal fires (HS-8335). Direct mutation of `inMemory.last_read_at`
  // bypassed the store and the bindList-preserved row never re-ran its
  // `syncUnreadDot` effect, so the blue dot stayed in the DOM until the next
  // full poll cycle even though `state.tickets` had the new `last_read_at`.
  if (!suppressAutoRead) {
    const inMemory = state.tickets.find(t => t.id === id);
    const isUnread = inMemory != null && inMemory.last_read_at != null && inMemory.updated_at > inMemory.last_read_at;
    if (isUnread) {
      const readAt = new Date().toISOString();
      ticketsStore.actions.applyServerUpdate({ ...inMemory, last_read_at: readAt });
      void updateTicket(id, { last_read_at: readAt }).catch(() => {});
    }
  }

  // Restore inputs to editable (in case we were in preview mode before)
  setDetailReadOnly(false);

  byId('detail-ticket-number').textContent = ticket.ticket_number;

  // Skip updating text fields that are currently focused to avoid cursor disruption (HS-1454).
  // HS-9117 — `forceTextFields` (undo/redo) overrides the guard so a deliberate
  // revert shows immediately even while the field is focused; place the caret at
  // the end since the whole value just changed underneath the user.
  const titleInput = byId<HTMLInputElement>('detail-title');
  if (forceTextFields || document.activeElement !== titleInput) {
    titleInput.value = ticket.title;
    if (forceTextFields && document.activeElement === titleInput) {
      const len = titleInput.value.length;
      titleInput.setSelectionRange(len, len);
    }
  }
  updateDetailCategory(ticket.category);
  updateDetailPriority(ticket.priority);
  updateDetailStatus(ticket.status);
  const upnextBtn = byId<HTMLButtonElement>('detail-upnext');
  upnextBtn.textContent = ticket.up_next ? '\u2605' : '\u2606';
  upnextBtn.classList.toggle('active', ticket.up_next);
  const detailsArea = byId<HTMLTextAreaElement>('detail-details');
  if (forceTextFields || document.activeElement !== detailsArea) {
    detailsArea.value = ticket.details;
    if (forceTextFields && document.activeElement === detailsArea) {
      const len = detailsArea.value.length;
      detailsArea.setSelectionRange(len, len);
    }
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
  const attContainer = byId('detail-attachments');
  if (ticket.attachments.length > 0) {
    morph(attContainer, (<>
      {ticket.attachments.map(att =>
        <div className="attachment-item" tabIndex={0} data-att-id={String(att.id)} data-stored-path={att.stored_path} data-filename={att.original_filename}>
          <span className="attachment-name">{att.original_filename}</span>
          <button className="attachment-reveal" data-att-id={String(att.id)} title="Show in file manager">{FOLDER_REVEAL_ICON}</button>
          <button className="attachment-delete" data-att-id={String(att.id)} title="Remove">{'\u00d7'}</button>
        </div>
      )}
    </>).toString());
  } else {
    attContainer.replaceChildren();
  }

  // Render tags
  renderDetailTags(parseTags(ticket.tags), false);

  // Skip re-rendering notes if a note is currently being edited (HS-1454)
  const notesContainer = byIdOrNull('detail-notes');
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
  // HS-8836 — context nav for the auto-shown feedback dialog: the same
  // [Details + notes] list the reader pages, anchored on the feedback note.
  const feedbackNav = feedbackState !== null
    ? buildFeedbackNav(
        { ticketNumber: ticket.ticket_number, ticketTitle: ticket.title, detailsMarkdown: ticket.details, notes: parsedNotes },
        feedbackState.noteId,
      )
    : undefined;
  if (!noteBeingEdited || document.activeElement !== noteBeingEdited) {
    renderNotes(ticket.id, parsedNotes);
    // HS-7599: load any feedback drafts for this ticket and re-render once
    // they arrive so saved drafts appear inline below their parent FEEDBACK
    // NEEDED note (or free-floating at the end if the parent's gone).
    void getFeedbackDrafts(ticket.id).then((drafts) => {
      const list = Array.isArray(drafts) ? drafts : [];
      setTicketDrafts(ticket.id, list);
      // Only re-render if the panel is still showing this ticket and no
      // note is being edited (avoid clobbering an in-progress edit).
      if (state.activeTicketId === ticket.id) {
        const editingNow = byIdOrNull('detail-notes')?.querySelector('.note-edit-area') as HTMLElement | null;
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
            // HS-8603 — canonical seed mapping (shared with the click paths).
            showFeedbackDialog(ticket.id, ticket.ticket_number, seed.promptText, toDraftSeed(seed), undefined, feedbackNav);
          } else {
            showFeedbackDialog(ticket.id, ticket.ticket_number, feedbackState.prompt, undefined, undefined, feedbackNav);
          }
        });
      }
    }).catch(() => {
      // Drafts fetch failed (older server / transient network) — fall back
      // to the original auto-show flow without a seed so the user still
      // gets prompted.
      if (feedbackState !== null && state.activeTicketId === ticket.id
          && shouldAutoShowFeedback(ticket.id, feedbackState.noteId)) {
        requestAnimationFrame(() => showFeedbackDialog(ticket.id, ticket.ticket_number, feedbackState.prompt, undefined, undefined, feedbackNav));
      }
    });
  } else if (feedbackState !== null && shouldAutoShowFeedback(id, feedbackState.noteId)) {
    // The user is editing a note in this panel and we're skipping the
    // drafts re-render. Auto-show without a seed — losing the edit by
    // clobbering with renderNotes is worse than showing a stale form;
    // the user can dismiss the dialog and pick the draft from the list.
    requestAnimationFrame(() => showFeedbackDialog(id, ticket.ticket_number, feedbackState.prompt, undefined, undefined, feedbackNav));
  }

  // Meta info
  const meta = byId('detail-meta');
  morph(meta, (<>
    <div>Created: {new Date(ticket.created_at).toLocaleString()}</div>
    <div>Updated: {new Date(ticket.updated_at).toLocaleString()}</div>
    {ticket.completed_at !== null && ticket.completed_at !== '' ? <div>Completed: {new Date(ticket.completed_at).toLocaleString()}</div> : null}
    {ticket.verified_at !== null && ticket.verified_at !== '' ? <div>Verified: {new Date(ticket.verified_at).toLocaleString()}</div> : null}
    {ticket.syncInfo.length > 0 ? <>
      {ticket.syncInfo.map(s =>
        <div className="detail-sync-info">
          {s.pluginIcon != null && s.pluginIcon !== ''
            // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- plugin-supplied SVG string (trusted plugin manifest data).
            ? raw(s.pluginIcon)
            : SYNC_FALLBACK_ICON}
          {s.remoteUrl != null && s.remoteUrl !== ''
            ? <a href={s.remoteUrl} target="_blank" rel="noopener">{s.pluginName} #{s.remoteId}</a>
            : <span>{s.pluginName} #{s.remoteId}</span>}
        </div>
      )}
    </> : null}
  </>).toString());

  // HS-8152 — per-ticket Claude usage stats block (§67.10.7). Clear
  // the previous ticket's stats immediately + fetch the new ticket's
  // rollup. The fetch is async; the block renders empty during the
  // loading window so stale data never shows.
  void import('./ticketTelemetryStats.js').then(({ clearTicketTelemetryStats, loadAndRenderTicketTelemetry }) => {
    clearTicketTelemetryStats();
    void loadAndRenderTicketTelemetry(ticket.ticket_number);
  });

  // Render plugin UI extensions for the detail panel
  const detailTop = byIdOrNull('plugin-detail-top');
  const detailBottom = byIdOrNull('plugin-detail-bottom');
  if (detailTop) { detailTop.replaceChildren(); renderPluginDetailElements(detailTop, 'detail_top', [ticket.id]); }
  if (detailBottom) { detailBottom.replaceChildren(); renderPluginDetailElements(detailBottom, 'detail_bottom', [ticket.id]); }
}

// --- Stats ---

export async function updateStats() {
  try {
    const stats = await getStats();
    const bar = byIdOrNull('status-bar');
    if (bar) {
      bar.textContent = `${stats.total} tickets \u00B7 ${stats.open} open \u00B7 ${stats.up_next} up next`;
    }
  } catch { /* ignore */ }
  // HS-8511 \u2014 keep the sidebar per-view count badges in sync with the same
  // refresh cadence as the status bar. Best-effort + independent of the bar.
  refreshSidebarCounts();
}

// --- Detail panel orientation ---

export function applyDetailPosition(position: 'side' | 'bottom') {
  const contentArea = byId('content-area');
  contentArea.classList.remove('detail-side', 'detail-bottom');
  contentArea.classList.add(position === 'bottom' ? 'detail-bottom' : 'detail-side');
}

export function applyDetailSize() {
  const panel = byId('detail-panel');
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
  const handle = byId('detail-resize-handle');
  const panel = byId('detail-panel');
  const contentArea = byId('content-area');

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
      void updateSettings({ detail_height: String(state.settings.detail_height) });
    } else {
      void updateSettings({ detail_width: String(state.settings.detail_width) });
    }
  });
}
