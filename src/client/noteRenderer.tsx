import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { appendImageDownloadLinks, proxyGitHubImages } from './imageProxy.js';
import { state } from './state.js';
import { pushNotesUndo } from './undo/actions.js';

export type NoteEntry = { id?: string; text: string; created_at: string };

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
