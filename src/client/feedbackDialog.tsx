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

/** HS-7599: a previously-saved draft to seed the dialog with. When provided,
 *  the dialog ignores `prompt` and uses the draft's saved blocks verbatim
 *  (so heuristic changes to `parseFeedbackBlocks` don't reshape the saved
 *  draft), restores inline responses and the catch-all textarea, and clicks
 *  on Save Draft / Submit operate against this draft id (PATCH on save,
 *  DELETE on submit). */
export interface FeedbackDraftSeed {
  id: string;
  parentNoteId: string | null;
  promptText: string;
  partitions: {
    blocks: { markdown: string; html: string }[];
    inlineResponses: { blockIndex: number; text: string }[];
    catchAll: string;
  };
}

/**
 * HS-7822 — given the active feedback note id and the list of saved drafts
 * for the ticket, pick the draft (if any) that should pre-populate the
 * auto-shown dialog.
 *
 * Selection order:
 * 1. The most recently updated draft whose `parentNoteId === activeFeedbackNoteId`.
 * 2. Otherwise the most recently updated free-floating draft (`parentNoteId === null`)
 *    — these survive when the parent note was deleted (§21.2.3) and still
 *    represent the user's in-progress response.
 * 3. Otherwise null — caller falls back to the bare-prompt auto-show.
 *
 * Generic in the draft shape — only the `parentNoteId` + `updatedAt` fields
 * are inspected, so the caller can pass the full `FeedbackDraft` and use the
 * returned reference verbatim. Pure: no DOM, no network. Unit-testable.
 */
export function pickDraftForFeedbackNote<T extends { parentNoteId: string | null; updatedAt?: string }>(
  drafts: T[],
  activeFeedbackNoteId: string,
): T | null {
  if (drafts.length === 0) return null;
  const byUpdatedDesc = (a: { updatedAt?: string }, b: { updatedAt?: string }): number => {
    const av = a.updatedAt ?? '';
    const bv = b.updatedAt ?? '';
    if (av === bv) return 0;
    return av > bv ? -1 : 1;
  };
  const matching = drafts
    .filter(d => d.parentNoteId === activeFeedbackNoteId)
    .sort(byUpdatedDesc);
  if (matching.length > 0) return matching[0];
  const floating = drafts
    .filter(d => d.parentNoteId === null)
    .sort(byUpdatedDesc);
  if (floating.length > 0) return floating[0];
  return null;
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
 *
 * HS-7599: when `draftSeed` is provided, the dialog opens in "edit existing
 * draft" mode — blocks come from the saved partitions (NOT a fresh
 * `parseFeedbackBlocks(prompt)` call) so heuristic changes don't reshape the
 * saved draft, inline responses are pre-inserted, and the catch-all is
 * pre-filled. Save Draft writes back via PATCH; Submit deletes the draft.
 */
export function showFeedbackDialog(
  ticketId: number,
  ticketNumber: string,
  prompt: string,
  draftSeed?: FeedbackDraftSeed,
  parentNoteId?: string,
) {
  // Remove any existing feedback dialog
  document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());

  // HS-7599: re-opening an existing draft uses the saved block layout
  // verbatim so future changes to parseFeedbackBlocks don't reshape it.
  const blocks = draftSeed !== undefined ? draftSeed.partitions.blocks : parseFeedbackBlocks(prompt);
  const effectivePrompt = draftSeed !== undefined ? draftSeed.promptText : prompt;
  const effectiveParentNoteId = draftSeed?.parentNoteId ?? parentNoteId ?? null;
  const overlay = buildOverlay(ticketNumber, blocks);

  // Restore inline responses from the draft seed BEFORE the insert-response
  // wiring runs so each saved response lands in its original slot.
  if (draftSeed !== undefined) {
    for (const r of draftSeed.partitions.inlineResponses) {
      if (r.text === '') continue;
      const slot = overlay.querySelector<HTMLElement>(`.feedback-insert-slot[data-after-block="${r.blockIndex}"]`);
      if (slot === null) continue;
      const insertBtn = slot.querySelector('.feedback-insert-btn');
      const responseEl = buildInlineResponse();
      (responseEl.querySelector('textarea') as HTMLTextAreaElement).value = r.text;
      slot.insertBefore(responseEl, insertBtn);
    }
    const catchAll = overlay.querySelector('#feedback-catchall-text') as HTMLTextAreaElement;
    catchAll.value = draftSeed.partitions.catchAll;
  }

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

  // HS-7930 — the slot itself is the click target so the user can drop a
  // response anywhere in the gap between two blocks. The hover-only
  // `.feedback-insert-btn` inside is purely decorative (it surfaces the
  // "+ Add response here" label as the visible affordance once the slot is
  // hovered). One response per slot — clicking a slot that already has a
  // response is a no-op so the user can interact with their own textarea /
  // × button without spawning duplicates. Removing the response (× button
  // on the inline-response card) restores the click-to-add affordance,
  // matching the user's "deleting a text field would undo this" semantics.
  overlay.querySelectorAll<HTMLElement>('.feedback-insert-slot').forEach(slot => {
    slot.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.feedback-inline-response') !== null) return;
      if (slot.querySelector('.feedback-inline-response') !== null) return;
      const responseEl = buildInlineResponse();
      const insertBtn = slot.querySelector('.feedback-insert-btn');
      if (insertBtn !== null) slot.insertBefore(responseEl, insertBtn);
      else slot.appendChild(responseEl);
      (responseEl.querySelector('textarea') as HTMLTextAreaElement).focus();
    });
  });

  const close = () => overlay.remove();
  overlay.querySelector('#feedback-close')!.addEventListener('click', close);
  overlay.querySelector('#feedback-later')!.addEventListener('click', close);
  // HS-7599: click outside the dialog dismisses ONLY when no text has been
  // entered. Any text in any input (catch-all or any inline textarea) keeps
  // the dialog open so the user doesn't lose work to a stray click. The
  // user can still close explicitly via the × / Later / Esc / Save Draft
  // paths. Threshold per spec is "any text entered at all" — even
  // whitespace/quoted-prompt-text doesn't count since those aren't pre-
  // populated in this dialog.
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    if (overlayHasAnyText(overlay)) return;
    close();
  });

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

  // HS-7599: Save Draft. Persists the current dialog state to
  // `feedback_drafts` so the user can come back later without sending. The
  // saved partition structure is restored verbatim on click-to-reopen so
  // future heuristic tweaks don't reshape an in-flight draft. POST creates
  // a new draft (id generated client-side); PATCH updates the seed draft.
  // After success the dialog closes and the notes list re-renders so the
  // new draft entry appears inline after its FEEDBACK NEEDED parent (or
  // free-floating at the end if `parentNoteId` is null).
  overlay.querySelector('#feedback-save-draft')!.addEventListener('click', async () => {
    const partitions = collectPartitions(overlay, blocks);
    if (!partitionsHaveText(partitions)) {
      focusFirstInput(overlay);
      return;
    }

    const btn = overlay.querySelector('#feedback-save-draft') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      if (draftSeed !== undefined) {
        await api(`/tickets/${ticketId}/feedback-drafts/${draftSeed.id}`, {
          method: 'PATCH', body: { partitions },
        });
      } else {
        const draftId = `fd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        await api(`/tickets/${ticketId}/feedback-drafts`, {
          method: 'POST',
          body: {
            id: draftId,
            parent_note_id: effectiveParentNoteId,
            prompt_text: effectivePrompt,
            partitions,
          },
        });
      }
      close();
      void loadTickets();
    } catch {
      btn.textContent = 'Save Draft';
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

      // HS-7599: clear the seed draft on successful submit so the user
      // doesn't see a now-stale draft alongside the just-sent note.
      if (draftSeed !== undefined) {
        try {
          await api(`/tickets/${ticketId}/feedback-drafts/${draftSeed.id}`, { method: 'DELETE' });
        } catch { /* draft already gone — fine */ }
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

/** HS-7599 — true when ANY input in the overlay has non-empty text. Drives
 *  the don't-close-on-clickaway gate: per the spec the threshold is "any
 *  text entered at all". Catch-all OR any inline-response textarea counts. */
function overlayHasAnyText(overlay: HTMLElement): boolean {
  const catchAll = overlay.querySelector<HTMLTextAreaElement>('#feedback-catchall-text');
  if (catchAll !== null && catchAll.value !== '') return true;
  const inlines = overlay.querySelectorAll<HTMLTextAreaElement>('.feedback-inline-textarea');
  for (const ta of inlines) {
    if (ta.value !== '') return true;
  }
  return false;
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
          <div style="display:flex;gap:8px;margin-top:16px;align-items:center;flex-wrap:wrap">
            <button className="feedback-later-link" id="feedback-later">Later</button>
            <div style="flex:1"></div>
            <button className="btn btn-sm" id="feedback-save-draft" title="Save the response as a draft to come back to later (HS-7599)">Save Draft</button>
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

/** HS-7599 — collect the dialog's working state in the shape that
 *  `feedback_drafts.partitions_json` stores. Captures EMPTY inline responses
 *  too so the user's "I clicked + Add response but didn't fill it in yet"
 *  state survives a save/reopen round-trip. The blocks are passed through
 *  verbatim — they were already either parsed at draft-creation time or
 *  loaded from the saved seed. */
function collectPartitions(overlay: HTMLElement, blocks: FeedbackBlock[]): {
  blocks: { markdown: string; html: string }[];
  inlineResponses: { blockIndex: number; text: string }[];
  catchAll: string;
} {
  const catchAll = (overlay.querySelector('#feedback-catchall-text') as HTMLTextAreaElement).value;
  const inlineResponses: { blockIndex: number; text: string }[] = [];
  overlay.querySelectorAll<HTMLElement>('.feedback-insert-slot').forEach(slot => {
    const blockIndex = Number(slot.getAttribute('data-after-block') ?? '-1');
    slot.querySelectorAll<HTMLTextAreaElement>('.feedback-inline-textarea').forEach(ta => {
      inlineResponses.push({ blockIndex, text: ta.value });
    });
  });
  return {
    blocks: blocks.map(b => ({ markdown: b.markdown, html: b.html })),
    inlineResponses,
    catchAll,
  };
}

/** HS-7599 — true when the partitions snapshot has any non-empty text in
 *  the catch-all or any inline response. Used to gate Save Draft so we
 *  don't persist empty drafts. */
function partitionsHaveText(partitions: ReturnType<typeof collectPartitions>): boolean {
  if (partitions.catchAll.trim() !== '') return true;
  return partitions.inlineResponses.some(r => r.text.trim() !== '');
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

/** Notify the Claude channel that feedback was submitted.
 *
 *  HS-7601 follow-up: surface a warning toast when channel comm fails — the
 *  same warning shape the megaphone uses (`note-megaphone-warning`), so the
 *  user knows their feedback note WAS saved but the trigger to Claude
 *  didn't reach because (most commonly) Claude isn't connected. Without
 *  this, a user submits feedback against an offline channel, sees nothing,
 *  and waits indefinitely for Claude to pick up — the warning at least
 *  flags the disconnect immediately. The warning auto-dismisses after 6 s
 *  and is non-blocking — the feedback note itself was saved.
 */
async function notifyChannel(ticketNumber: string) {
  try {
    const { isChannelEnabled } = await import('./experimentalSettings.js');
    if (!isChannelEnabled()) {
      showFeedbackChannelWarning('Channel feature not enabled in Settings → Experimental — Claude was not notified.');
      return;
    }
    const { isChannelAlive, triggerChannelAndMarkBusy } = await import('./channelUI.js');
    if (!isChannelAlive()) {
      showFeedbackChannelWarning('Claude is not connected — feedback was saved but Claude was not notified. Launch Claude Code with channel support to re-trigger.');
      return;
    }
    triggerChannelAndMarkBusy(`Feedback was provided on ticket ${ticketNumber}. Please re-read the worklist and continue work on this ticket.`);
  } catch (err) {
    showFeedbackChannelWarning(`Failed to notify Claude: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** HS-7601 follow-up — surface a warning when post-submit channel comm
 *  fails. Mirrors `showMegaphoneWarning` in `noteRenderer.tsx` so the two
 *  notification paths read consistently. Prepended to `#detail-notes` so the
 *  user sees it immediately above the just-saved feedback note. */
function showFeedbackChannelWarning(message: string): void {
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
