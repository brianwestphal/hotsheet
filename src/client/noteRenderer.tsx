import './markdownSetup.js';

import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { isChannelEnabled } from './experimentalSettings.js';
import { parseFeedbackPrefix, showFeedbackDialog } from './feedbackDialog.js';
import { ICON_TRASH } from './icons.js';
import { appendImageDownloadLinks, proxyGitHubImages } from './imageProxy.js';
import { state } from './state.js';
import { pushNotesUndo } from './undo/actions.js';

/** HS-7601 — the megaphone button only appears when the channel feature is
 *  enabled. Wraps `isChannelEnabled` so the call site reads clearly. */
function isChannelFeatureEnabled(): boolean {
  return isChannelEnabled();
}

export type NoteEntry = { id?: string; text: string; created_at: string };

/** HS-7599 — feedback draft as returned by `/api/tickets/:id/feedback-drafts`.
 *  `partitions` mirrors the feedback dialog's working state so a saved draft
 *  round-trips back to the same UI on click-to-reopen, even after future
 *  changes to `parseFeedbackBlocks` heuristics. */
export interface FeedbackDraft {
  id: string;
  ticketId: number;
  parentNoteId: string | null;
  promptText: string;
  partitions: {
    blocks: { markdown: string; html: string }[];
    inlineResponses: { blockIndex: number; text: string }[];
    catchAll: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** Drafts loaded for the active ticket. The key is the ticket id; the value
 *  is whatever the server returned on the most recent /feedback-drafts call.
 *  Populated by `setTicketDrafts(ticketId, drafts)` from `detail.tsx` when
 *  the detail panel opens / refreshes. */
const ticketDraftsCache = new Map<number, FeedbackDraft[]>();

export function setTicketDrafts(ticketId: number, drafts: FeedbackDraft[]): void {
  ticketDraftsCache.set(ticketId, drafts);
}

export function getTicketDrafts(ticketId: number): FeedbackDraft[] {
  return ticketDraftsCache.get(ticketId) ?? [];
}

/** Note ID to scroll-to and focus after the next renderNotes pass. */
let pendingFocusNoteId: string | null = null;

export function setPendingFocusNoteId(noteId: string) {
  pendingFocusNoteId = noteId;
}

let noteIdCounter = 0;
function clientNoteId(): string { return `cn_${Date.now().toString(36)}_${(noteIdCounter++).toString(36)}`; }

export function parseNotesJson(rawStr: string): NoteEntry[] {
  if (rawStr === '') return [];
  try {
    const parsed: unknown = JSON.parse(rawStr);
    if (Array.isArray(parsed)) {
      return (parsed as { id?: string; text: string; created_at: string }[]).map((n) => ({
        id: n.id ?? clientNoteId(),
        text: n.text,
        created_at: n.created_at,
      }));
    }
  } catch { /* not JSON */ }
  if (rawStr.trim()) return [{ id: clientNoteId(), text: rawStr, created_at: '' }];
  return [];
}

function syncNotesToState(ticketId: number, notes: NoteEntry[]) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (ticket) ticket.notes = JSON.stringify(notes);
}

export function renderNotes(ticketId: number, notes: NoteEntry[]) {
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
    // HS-7601 — show the megaphone button when (a) this note isn't a
    // FEEDBACK NEEDED prompt (those are Claude → user, not user → Claude),
    // (b) the channel feature is enabled, and (c) the note has actual text
    // (no point sending an empty note as feedback).
    const feedbackPrefix = parseFeedbackPrefix(note.text);
    const showMegaphone = feedbackPrefix === null && !isEmpty && isChannelFeatureEnabled();
    const entry = toElement(
      <div className={`note-entry${isEmpty ? ' note-empty' : ''}`} data-note-id={note.id ?? ''}>
        {note.created_at !== '' || showMegaphone
          ? <div className="note-timestamp-row">
              {note.created_at !== '' ? <span className="note-timestamp">{new Date(note.created_at).toLocaleString()}</span> : <span></span>}
              {showMegaphone
                ? <button className="note-megaphone-btn" title="Send this note to Claude via channel" type="button" data-note-id={note.id ?? ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
                  </button>
                : null}
            </div>
          : null}
        <div className="note-text note-markdown">
          {isEmpty ? <span className="note-placeholder">Click to add a note...</span> : raw(renderedText)}
        </div>
      </div>
    );

    // HS-7601 — megaphone button: send this note to Claude via the channel
    // as if the user proactively flagged it. Stops propagation so it doesn't
    // also trigger the note-entry click-to-edit handler. Shows a busy state
    // for ~2 s and surfaces a warning if the channel isn't connected or the
    // request fails. The framed prompt mirrors the existing notify-channel
    // wording from the Submit-feedback path so Claude reads the trigger as
    // an unsolicited comment to act on.
    {
      const megaphone = entry.querySelector<HTMLButtonElement>('.note-megaphone-btn');
      if (megaphone !== null) {
        megaphone.addEventListener('click', (e) => {
          e.stopPropagation();
          void onMegaphoneClick(megaphone, ticketId, note.text);
        });
      }
    }

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

        // HS-7835 — Lucide trash icon.
        const menu = toElement(
          <div className="note-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
            <div className="context-menu-item danger">
              <span className="dropdown-icon">{raw(ICON_TRASH)}</span>
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

    // If this is the last note and has a feedback prefix, add a "Provide Feedback" link
    if (note === notes[notes.length - 1]) {
      const feedback = parseFeedbackPrefix(note.text);
      if (feedback) {
        const ticket = state.tickets.find(t => t.id === ticketId);
        const ticketNumber = ticket?.ticket_number ?? `#${ticketId}`;
        const link = toElement(
          <button className="feedback-link">Provide Feedback</button>
        );
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          showFeedbackDialog(ticketId, ticketNumber, feedback.prompt, undefined, note.id);
        });
        entry.appendChild(link);
      }
    }

    container.appendChild(entry);

    // HS-7599: render any feedback drafts whose `parent_note_id` matches
    // this note inline, immediately below the parent note. Free-floating
    // drafts (parent_note_id missing or no longer matching any note)
    // render at the end of the list — see the post-loop block.
    const drafts = ticketDraftsCache.get(ticketId) ?? [];
    for (const draft of drafts) {
      if (draft.parentNoteId === note.id) {
        container.appendChild(buildDraftEntry(ticketId, draft, notes));
      }
    }
  }

  // HS-7599: free-floating drafts (parent note deleted or never existed)
  // render at the bottom of the notes list, in created-at order. The
  // dialog reopens with the saved partition structure (so future heuristic
  // tweaks to parseFeedbackBlocks don't reshape the saved draft) plus the
  // snapshotted prompt text so the original question text is still visible.
  {
    const noteIds = new Set(notes.map(n => n.id));
    const drafts = ticketDraftsCache.get(ticketId) ?? [];
    for (const draft of drafts) {
      if (draft.parentNoteId !== null && noteIds.has(draft.parentNoteId)) continue;
      container.appendChild(buildDraftEntry(ticketId, draft, notes));
    }
  }

  // HS-7600: a second "Add note" button at the bottom of the notes list so
  // users who scrolled down to read existing notes don't have to scroll all
  // the way back up to add a new one. Hidden when the list is empty (the
  // top button is already in view + the empty-state row reads cleanly
  // without a duplicate action). Click forwards to the existing top button
  // so the add-note logic stays in one place.
  const addBottomBtn = toElement(
    <button className="detail-add-note-bottom-btn" title="Add note">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      <span>Add note</span>
    </button>
  );
  addBottomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('detail-add-note-btn')?.click();
  });
  container.appendChild(addBottomBtn);

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

/** HS-7599 — render one feedback draft as a note-like entry. Visually it's
 *  a dashed-border card with a "Draft" badge in the corner so the user can
 *  see at a glance that this is a not-yet-sent response. Click reopens the
 *  feedback dialog with the saved partition structure restored verbatim;
 *  right-click offers Delete. The dialog's Save Draft path PATCHes this
 *  draft, and Submit deletes it after a successful note write. */
function buildDraftEntry(ticketId: number, draft: FeedbackDraft, notes: NoteEntry[]): HTMLElement {
  const previewText = draftPreviewText(draft);
  const ticket = state.tickets.find(t => t.id === ticketId);
  const ticketNumber = ticket?.ticket_number ?? `#${ticketId}`;
  const entry = toElement(
    <div className="note-entry feedback-draft-entry" data-draft-id={draft.id}>
      <div className="feedback-draft-header">
        <span className="feedback-draft-badge">Draft</span>
        <span className="note-timestamp">{draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : ''}</span>
      </div>
      <div className="note-text">
        {previewText === ''
          ? <span className="note-placeholder">Empty draft — click to continue editing</span>
          : <span className="feedback-draft-preview">{previewText}</span>}
      </div>
    </div>
  );
  entry.addEventListener('click', () => {
    showFeedbackDialog(ticketId, ticketNumber, draft.promptText, {
      id: draft.id,
      parentNoteId: draft.parentNoteId,
      promptText: draft.promptText,
      partitions: draft.partitions,
    });
  });
  // Right-click → Delete this draft. Mirrors the right-click delete on
  // regular notes (§4.6) so the affordance is consistent across the list.
  entry.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    document.querySelectorAll('.note-context-menu').forEach(m => m.remove());
    // HS-7835 — Lucide trash icon.
    const menu = toElement(
      <div className="note-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
        <div className="context-menu-item danger">
          <span className="dropdown-icon">{raw(ICON_TRASH)}</span>
          <span className="context-menu-label">Delete Draft</span>
        </div>
      </div>
    );
    menu.querySelector('.context-menu-item')!.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      menu.remove();
      try { await api(`/tickets/${ticketId}/feedback-drafts/${draft.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
      const drafts = ticketDraftsCache.get(ticketId) ?? [];
      ticketDraftsCache.set(ticketId, drafts.filter(d => d.id !== draft.id));
      renderNotes(ticketId, notes);
    });
    document.body.appendChild(menu);
    setTimeout(() => {
      const close = () => { menu.remove(); document.removeEventListener('click', close); };
      document.addEventListener('click', close);
    }, 0);
  });
  return entry;
}

/** Build a one-line preview from the draft's saved catch-all + inline
 *  responses, in render order. Truncated to ~80 chars so the draft card
 *  stays compact in the notes list. */
function draftPreviewText(draft: FeedbackDraft): string {
  const parts: string[] = [];
  for (const r of draft.partitions.inlineResponses) {
    const t = r.text.trim();
    if (t !== '') parts.push(t);
  }
  const c = draft.partitions.catchAll.trim();
  if (c !== '') parts.push(c);
  const joined = parts.join(' / ');
  if (joined.length <= 80) return joined;
  return `${joined.slice(0, 80).trimEnd()}…`;
}

/** HS-7601 — handle a megaphone click on a regular note. Mirrors the
 *  framed-message format used by the existing notifyChannel path on Submit
 *  Feedback, so Claude sees the same shape regardless of whether the user
 *  prompted it via the dialog or via the unsolicited button. Toggles the
 *  button into a busy state for ~2 s on success (per HS-7601 user answer)
 *  and surfaces a warning toast on failure with a specific reason when we
 *  know one (channel disabled / not connected / network failure). */
async function onMegaphoneClick(btn: HTMLButtonElement, ticketId: number, noteText: string): Promise<void> {
  if (btn.classList.contains('is-busy')) return;
  const ticket = state.tickets.find(t => t.id === ticketId);
  const ticketNumber = ticket?.ticket_number ?? `#${ticketId}`;
  const ticketTitle = ticket?.title ?? '';

  const { isChannelEnabled } = await import('./experimentalSettings.js');
  if (!isChannelEnabled()) {
    showMegaphoneWarning('Channel feature not enabled in Settings → Experimental.');
    return;
  }
  const { isChannelAlive } = await import('./channelUI.js');
  if (!isChannelAlive()) {
    showMegaphoneWarning('Claude is not connected. Launch Claude Code with channel support first.');
    return;
  }

  // Frame the message with the ticket context so Claude has an anchor even
  // when working in a different ticket. Mirror the post-Submit-Feedback
  // notification wording so Claude's mental model is consistent.
  const titleSuffix = ticketTitle === '' ? '' : ` (${ticketTitle})`;
  const message = `An unsolicited comment was added to ticket ${ticketNumber}${titleSuffix}. Please re-read the worklist and continue work on this ticket. The user's comment was:\n\n${noteText.trim()}`;

  btn.classList.add('is-busy');
  try {
    const { triggerChannelAndMarkBusy } = await import('./channelUI.js');
    triggerChannelAndMarkBusy(message);
  } catch (err) {
    btn.classList.remove('is-busy');
    showMegaphoneWarning(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  setTimeout(() => { btn.classList.remove('is-busy'); }, 2000);
}

/** HS-7601 — surface a warning toast at the bottom of the detail panel
 *  when the megaphone send fails. Mirrors the existing
 *  `.no-upnext-alert` styling from `channelUI.tsx`'\''s
 *  `showDisconnectedAlert`. Auto-dismisses after 6 s. */
function showMegaphoneWarning(message: string): void {
  document.querySelectorAll('.note-megaphone-warning').forEach(el => el.remove());
  const alert = toElement(
    <div className="note-megaphone-warning no-upnext-alert">
      <span>{message}</span>
      <button className="no-upnext-dismiss" type="button">{'×'}</button>
    </div>
  );
  alert.querySelector('button')?.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), 6000);
  const notesContainer = document.getElementById('detail-notes');
  if (notesContainer !== null) notesContainer.prepend(alert);
}
