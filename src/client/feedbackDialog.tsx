import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { api, apiUpload } from './api.js';
import { toElement } from './dom.js';
import type { NoteEntry } from './noteRenderer.js';
import { loadTickets } from './ticketList.js';

const FEEDBACK_PREFIX = 'FEEDBACK NEEDED:';
const IMMEDIATE_PREFIX = 'IMMEDIATE FEEDBACK NEEDED:';

/** Parse a note's text for a feedback prefix. Returns null if not a feedback note. */
export function parseFeedbackPrefix(text: string): { type: 'standard' | 'immediate'; prompt: string } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith(IMMEDIATE_PREFIX)) {
    return { type: 'immediate', prompt: trimmed.slice(IMMEDIATE_PREFIX.length).trim() };
  }
  if (trimmed.startsWith(FEEDBACK_PREFIX)) {
    return { type: 'standard', prompt: trimmed.slice(FEEDBACK_PREFIX.length).trim() };
  }
  return null;
}

/** Check if the ticket's most recent note is a feedback request. */
export function getTicketFeedbackState(notes: NoteEntry[]): { type: 'standard' | 'immediate'; prompt: string; noteId: string } | null {
  if (notes.length === 0) return null;
  const last = notes[notes.length - 1];
  const parsed = parseFeedbackPrefix(last.text);
  if (!parsed) return null;
  return { ...parsed, noteId: last.id ?? '' };
}

/** Track which feedback note we've already auto-shown the dialog for,
 *  to avoid re-opening on every refreshDetail() poll cycle. */
let lastAutoShownKey: string | null = null;

export function resetAutoShownFeedback() {
  lastAutoShownKey = null;
}

export function shouldAutoShowFeedback(ticketId: number, noteId: string): boolean {
  const key = `${ticketId}:${noteId}`;
  if (lastAutoShownKey === key) return false;
  lastAutoShownKey = key;
  return true;
}

/** Show the feedback dialog for a ticket. */
export function showFeedbackDialog(ticketId: number, ticketNumber: string, prompt: string) {
  // Remove any existing feedback dialog
  document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());

  const renderedPrompt = marked.parse(prompt, { async: false });

  const overlay = toElement(
    <div className="feedback-dialog-overlay custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor" style="width:520px">
        <div className="custom-view-editor-header">
          <span>Feedback Needed — {ticketNumber}</span>
          <button className="detail-close" id="feedback-close">{'\u00d7'}</button>
        </div>
        <div className="custom-view-editor-body">
          <div className="feedback-prompt note-markdown">{raw(renderedPrompt)}</div>
          <div className="settings-field" style="margin-top:12px">
            <label>Your response</label>
            <textarea id="feedback-text" className="settings-textarea" rows={4} placeholder="Enter your feedback..." style="width:100%;resize:vertical"></textarea>
          </div>
          <div className="settings-field" style="margin-top:12px">
            <label>Attachments</label>
            <div id="feedback-files" className="not-working-file-list"></div>
            <button className="btn btn-sm" id="feedback-add-file" style="margin-top:6px">Add File...</button>
            <input type="file" id="feedback-file-input" multiple={true} style="display:none" />
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;align-items:center">
            <button className="feedback-later-link" id="feedback-later">Later</button>
            <div style="flex:1"></div>
            <button className="btn btn-sm" id="feedback-no-response">No Response Needed</button>
            <button className="btn btn-sm btn-primary" id="feedback-submit">Submit</button>
          </div>
        </div>
      </div>
    </div>
  );

  const pendingFiles: File[] = [];
  const fileListEl = overlay.querySelector('#feedback-files')!;
  const fileInput = overlay.querySelector('#feedback-file-input') as HTMLInputElement;

  function renderFileList() {
    fileListEl.innerHTML = '';
    for (let i = 0; i < pendingFiles.length; i++) {
      const file = pendingFiles[i];
      const row = toElement(
        <div className="not-working-file-row">
          <span>{file.name}</span>
          <button className="category-delete-btn" data-idx={String(i)}>{'\u00d7'}</button>
        </div>
      );
      row.querySelector('button')!.addEventListener('click', () => {
        pendingFiles.splice(i, 1);
        renderFileList();
      });
      fileListEl.appendChild(row);
    }
  }

  overlay.querySelector('#feedback-add-file')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) pendingFiles.push(f);
      renderFileList();
    }
    fileInput.value = '';
  });

  // Drag-and-drop file support on the entire overlay
  overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      for (const f of Array.from(e.dataTransfer.files)) pendingFiles.push(f);
      renderFileList();
    }
  });

  const close = () => overlay.remove();
  overlay.querySelector('#feedback-close')!.addEventListener('click', close);
  overlay.querySelector('#feedback-later')!.addEventListener('click', close);
  // Click outside dialog to dismiss (unlike Not Working which preserves form state)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // No Response Needed
  overlay.querySelector('#feedback-no-response')!.addEventListener('click', async () => {
    const btn = overlay.querySelector('#feedback-no-response') as HTMLButtonElement;
    btn.disabled = true;
    try {
      await api(`/tickets/${ticketId}`, {
        method: 'PATCH', body: { notes: 'NO RESPONSE NEEDED' },
      });
      close();
      void loadTickets();
    } catch {
      btn.disabled = false;
    }
  });

  // Submit
  overlay.querySelector('#feedback-submit')!.addEventListener('click', async () => {
    const text = (overlay.querySelector('#feedback-text') as HTMLTextAreaElement).value.trim();
    if (!text && pendingFiles.length === 0) {
      (overlay.querySelector('#feedback-text') as HTMLTextAreaElement).focus();
      return;
    }

    const submitBtn = overlay.querySelector('#feedback-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      // Add response note
      if (text) {
        await api(`/tickets/${ticketId}`, {
          method: 'PATCH', body: { notes: text },
        });
      }

      // Upload attachments
      for (const file of pendingFiles) {
        await apiUpload(`/tickets/${ticketId}/attachments`, file);
      }

      close();
      void loadTickets();

      // Notify Claude if channel is alive
      void notifyChannel(ticketNumber);
    } catch {
      submitBtn.textContent = 'Submit';
      submitBtn.disabled = false;
    }
  });

  document.body.appendChild(overlay);
  (overlay.querySelector('#feedback-text') as HTMLTextAreaElement).focus();
}

/** Check all loaded tickets for pending feedback. Updates tab dot and
 *  auto-selects IMMEDIATE feedback tickets. Called after loadTickets().
 *  Imports state/noteRenderer lazily to avoid circular dependencies. */
export async function checkFeedbackState() {
  const { state: appState, getActiveProject } = await import('./state.js');
  const { parseNotesJson } = await import('./noteRenderer.js');
  const secret = getActiveProject()?.secret;
  if (secret == null || secret === '') return;

  let hasFeedback = false;
  for (const ticket of appState.tickets) {
    const notes = parseNotesJson(ticket.notes);
    const feedback = getTicketFeedbackState(notes);
    if (!feedback) continue;
    hasFeedback = true;

    // IMMEDIATE: auto-select if nothing is currently selected
    if (feedback.type === 'immediate' && appState.selectedIds.size === 0) {
      appState.selectedIds.add(ticket.id);
      appState.lastClickedId = ticket.id;
      const { syncDetailPanel } = await import('./detail.js');
      syncDetailPanel();
      break;
    }
  }

  // Update the project tab dot
  const { setProjectFeedback } = await import('./projectTabs.js');
  setProjectFeedback(secret, hasFeedback);
}

/** Notify the Claude channel that feedback was submitted. */
async function notifyChannel(ticketNumber: string) {
  try {
    const { isChannelAlive, triggerChannelAndMarkBusy } = await import('./channelUI.js');
    if (isChannelAlive()) {
      triggerChannelAndMarkBusy(`Feedback was provided on ticket ${ticketNumber}. Please re-read the worklist and continue work on this ticket.`);
    }
  } catch { /* channel not available */ }
}
