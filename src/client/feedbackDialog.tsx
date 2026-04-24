import { raw } from '../jsx-runtime.js';
import { api, apiUpload } from './api.js';
import { toElement } from './dom.js';
import {
  type BlockResponse,
  combineQuotedResponse,
  type FeedbackBlock,
  parseFeedbackBlocks,
} from './feedbackParser.js';
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

/**
 * Show the feedback dialog for a ticket (HS-6998).
 *
 * The prompt is split into top-level markdown blocks (paragraphs, lists,
 * headings, ...) via `parseFeedbackBlocks`. Each block is rendered with an
 * "+ Add response" affordance beneath it so the user can insert their own
 * inline textarea at any block boundary. A catch-all textarea always sits at
 * the bottom — when the prompt is a plain single question, that's the only
 * input the user needs.
 */
export function showFeedbackDialog(ticketId: number, ticketNumber: string, prompt: string) {
  // Remove any existing feedback dialog
  document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());

  const blocks = parseFeedbackBlocks(prompt);
  const overlay = buildOverlay(ticketNumber, blocks);

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
          <button className="category-delete-btn" data-idx={String(i)}>{'×'}</button>
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

  // Insert-response buttons — adds an inline textarea after the targeted block.
  overlay.querySelectorAll<HTMLButtonElement>('.feedback-insert-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.closest('.feedback-insert-slot');
      if (slot == null) return;
      const responseEl = buildInlineResponse();
      slot.insertBefore(responseEl, btn);
      (responseEl.querySelector('textarea') as HTMLTextAreaElement).focus();
    });
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
    const text = collectResponse(overlay, blocks);
    if ((text === null || text === '') && pendingFiles.length === 0) {
      focusFirstInput(overlay);
      return;
    }

    const submitBtn = overlay.querySelector('#feedback-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      if (text !== null && text !== '') {
        await api(`/tickets/${ticketId}`, {
          method: 'PATCH', body: { notes: text },
        });
      }

      for (const file of pendingFiles) {
        await apiUpload(`/tickets/${ticketId}/attachments`, file);
      }

      close();
      void loadTickets();

      void notifyChannel(ticketNumber);
    } catch {
      submitBtn.textContent = 'Submit';
      submitBtn.disabled = false;
    }
  });

  document.body.appendChild(overlay);
  focusFirstInput(overlay);
}

function buildOverlay(ticketNumber: string, blocks: FeedbackBlock[]): HTMLElement {
  return toElement(
    <div className="feedback-dialog-overlay custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor feedback-dialog" style="width:560px">
        <div className="custom-view-editor-header">
          <span>Feedback Needed — {ticketNumber}</span>
          <button className="detail-close" id="feedback-close">{'×'}</button>
        </div>
        <div className="custom-view-editor-body">
          <div className="feedback-prompt-stack">
            {blocks.length === 0
              ? <div className="feedback-prompt-block note-markdown feedback-prompt-empty"><em>(no prompt text)</em></div>
              : blocks.map((block, idx) => (
                  <>
                    <div className="feedback-prompt-block note-markdown" data-block-index={String(idx)}>
                      {raw(block.html)}
                    </div>
                    <div className="feedback-insert-slot" data-after-block={String(idx)}>
                      <button className="feedback-insert-btn" type="button" aria-label="Add response here">
                        <span className="feedback-insert-plus">+</span>
                        <span className="feedback-insert-label">{' Add response here'}</span>
                      </button>
                    </div>
                  </>
                ))}
          </div>
          <div className="settings-field feedback-catchall">
            <label>{blocks.length === 0 ? 'Your response' : 'Or respond below (catch-all)'}</label>
            <textarea id="feedback-catchall-text" className="settings-textarea" rows={4} placeholder="Type your response..." style="width:100%;resize:vertical"></textarea>
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
}

function buildInlineResponse(): HTMLElement {
  const el = toElement(
    <div className="feedback-inline-response">
      <textarea className="settings-textarea feedback-inline-textarea" rows={3} placeholder="Your response..."></textarea>
      <button className="feedback-inline-remove" type="button" title="Remove this response">{'×'}</button>
    </div>
  );
  el.querySelector('.feedback-inline-remove')!.addEventListener('click', () => el.remove());
  return el;
}

function collectResponse(overlay: HTMLElement, blocks: FeedbackBlock[]): string | null {
  const catchAll = (overlay.querySelector('#feedback-catchall-text') as HTMLTextAreaElement).value;
  const inline: BlockResponse[] = [];
  overlay.querySelectorAll<HTMLElement>('.feedback-insert-slot').forEach(slot => {
    const blockIndex = Number(slot.getAttribute('data-after-block') ?? '-1');
    slot.querySelectorAll<HTMLTextAreaElement>('.feedback-inline-textarea').forEach(ta => {
      inline.push({ blockIndex, text: ta.value });
    });
  });

  const hasInline = inline.some(r => r.text.trim() !== '');
  const hasCatchAll = catchAll.trim() !== '';
  if (!hasInline && !hasCatchAll) return null;

  return combineQuotedResponse(blocks, inline, catchAll);
}

function focusFirstInput(overlay: HTMLElement) {
  // Prefer the first inline textarea if one exists (user already started
  // inserting responses), otherwise the catch-all.
  const firstInline = overlay.querySelector<HTMLTextAreaElement>('.feedback-inline-textarea');
  if (firstInline != null) {
    firstInline.focus();
    return;
  }
  (overlay.querySelector('#feedback-catchall-text') as HTMLTextAreaElement).focus();
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
