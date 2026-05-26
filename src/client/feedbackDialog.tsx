import { z } from 'zod';

import {
  createFeedbackDraft, deleteFeedbackDraft, getFeedbackDrafts,
  promoteFeedbackDraftAttachments, updateFeedbackDraft, updateTicket,
} from '../api/index.js';
import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import {
  type BlockResponse,
  combineQuotedResponse,
  type FeedbackBlock,
  parseFeedbackBlocks,
} from './feedbackParser.js';
import type { FeedbackDraft, NoteEntry } from './noteRenderer.js';
import { morph } from './reactive.js';
import { loadTickets } from './ticketList.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';
import { TOAST_AUTOHIDE_MS } from './uiTimings.js';

// HS-8567 — wire-boundary schema for the draft-attachment upload response.
const AttachmentResponseSchema = z.object({
  id: z.number().int(),
  original_filename: z.string(),
}).loose();

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

/** HS-8416 — one-shot guard set by `showTicketContextMenu` before its
 *  selection re-render. The re-render cascades into
 *  `updateBatchToolbar → syncDetailPanel`, which historically auto-opened
 *  the feedback dialog whenever the just-selected ticket had a pending
 *  FEEDBACK NEEDED note — so right-clicking a feedback ticket popped the
 *  form on top of the context menu instead of letting the user pick a
 *  menu item. The guard makes the next `shouldAutoShowFeedback` call
 *  return false WITHOUT recording the noteId in `lastAutoShownKey`, so a
 *  later legitimate navigation to the same ticket (e.g. clicking the row
 *  after dismissing the menu) still auto-shows on the first arrival. */
let suppressAutoShowOnce = false;

export function resetAutoShownFeedback() {
  lastAutoShownKey = null;
  suppressAutoShowOnce = false;
}

/** HS-8416 — set the one-shot suppress flag. The next
 *  `shouldAutoShowFeedback` call returns false without consuming the
 *  ticket+noteId pair from `lastAutoShownKey`, so the auto-show can
 *  still fire later when the user navigates to the ticket normally. */
export function suppressNextAutoShowFeedback(): void {
  suppressAutoShowOnce = true;
}

export function shouldAutoShowFeedback(ticketId: number, noteId: string): boolean {
  if (suppressAutoShowOnce) {
    suppressAutoShowOnce = false;
    return false;
  }
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
  /** HS-8428 — draft-scoped attachments already uploaded on a prior
   *  session of the same draft. Pre-populates the dialog's file list so
   *  the user sees their previous uploads on reopen. May be missing on
   *  payloads from older servers — caller treats `undefined` as `[]`. */
  attachments?: { id: number; original_filename: string }[];
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
 * Map a saved `FeedbackDraft` (wire / cache shape) to the `FeedbackDraftSeed`
 * the dialog opens from. Canonical mapping — the inline draft-card click
 * (`noteRenderer.tsx`) and the detail-panel auto-show (`detail.tsx`) both use
 * it so there's one place the seed is built. HS-8428 — `attachments` defaults
 * to `[]` for older-server payloads.
 */
export function toDraftSeed(draft: FeedbackDraft): FeedbackDraftSeed {
  return {
    id: draft.id,
    parentNoteId: draft.parentNoteId,
    promptText: draft.promptText,
    partitions: draft.partitions,
    attachments: draft.attachments ?? [],
  };
}

/**
 * HS-8603 — open the feedback dialog for a specific FEEDBACK NEEDED note,
 * auto-loading the user's saved draft for that note when one exists. Every
 * "Provide Feedback" CLICK affordance (the ticket context-menu item, the
 * note's inline link) routes through here so clicking it ALWAYS resumes an
 * existing draft instead of opening a blank form — which would otherwise
 * spawn a second, competing draft for the same note.
 *
 * Fetches the ticket's drafts fresh (a context-menu click can fire from the
 * ticket list before the detail panel has loaded them), picks the matching
 * draft via `pickDraftForFeedbackNote`, and falls back to the bare prompt
 * when there's no draft, no note id, or the fetch fails. The fetch mirrors
 * the unvalidated `api<FeedbackDraft[]>` shape used by `detail.tsx`'s
 * draft-load path against the same endpoint.
 */
export async function openFeedbackDialogForNote(
  ticketId: number,
  ticketNumber: string,
  prompt: string,
  noteId: string | undefined,
): Promise<void> {
  let seed: FeedbackDraftSeed | undefined;
  if (noteId !== undefined && noteId !== '') {
    try {
      const drafts = await getFeedbackDrafts(ticketId);
      const list = Array.isArray(drafts) ? drafts : [];
      const picked = pickDraftForFeedbackNote(list, noteId);
      if (picked !== null) seed = toDraftSeed(picked);
    } catch { /* fall back to the bare prompt below */ }
  }
  showFeedbackDialog(ticketId, ticketNumber, prompt, seed, noteId);
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

  // HS-8428 — generate a stable `sessionDraftId` for the dialog session.
  // When reopening an existing draft, reuse its id so newly-attached
  // files are linked to the same draft. When opening fresh, generate
  // upfront so the user can attach files BEFORE clicking Save Draft —
  // the file goes directly to the new draft-attachment endpoint and
  // gets linked by `draft_id`. The draft ROW itself doesn't have to
  // exist yet; the server's POST attachment route doesn't FK-check it.
  // If the user closes the dialog without ever clicking Save Draft, the
  // server-side cleanup sweep GC's the orphan rows (HS-8428 §cleanup).
  const sessionDraftId = draftSeed?.id ?? `fd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  // Whether the draft ROW exists server-side. Used by the close-without-
  // save path to decide whether to fire an orphan-cleanup DELETE.
  let draftPersistedToServer = draftSeed !== undefined;
  // Whether attachments are in their "final" state — promoted to real
  // (Submit) OR linked to a persisted draft row (Save Draft). Drives the
  // close-without-save cleanup decision.
  let attachmentsCommitted = draftSeed !== undefined;

  // HS-8428 — pending draft attachments. Replaces the pre-fix
  // `pendingFiles: File[]` array. Each entry has a server-assigned `id`
  // because the file is uploaded on attach (not on Submit), so a Save
  // Draft + close path no longer silently drops the user's files.
  const pendingAttachments: { id: number; original_filename: string }[] =
    (draftSeed?.attachments ?? []).map(a => ({ id: a.id, original_filename: a.original_filename }));
  const fileListEl = overlay.querySelector('#feedback-files')!;
  const fileInput = overlay.querySelector('#feedback-file-input') as HTMLInputElement;

  // HS-8365 — `morph()` reconciles in place, so any user focus / selection
  // on a sibling textarea (the catch-all or per-block response inputs)
  // survives a file add / remove. Listener attachment uses delegation on
  // `fileListEl` rather than per-button so a morphed-in row from the
  // template doesn't need a follow-up wiring pass — the delegated click
  // walks up via `closest('.category-delete-btn')` and reads the row's
  // `data-idx`.
  fileListEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.category-delete-btn');
    if (btn === null || btn === undefined || !fileListEl.contains(btn)) return;
    const idx = parseInt(btn.dataset.idx ?? '-1', 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= pendingAttachments.length) return;
    // HS-8428 — DELETE the server-side attachment row + file on disk.
    // Best-effort: if the DELETE fails (network, server restart), the
    // attachment will eventually be cleaned up via the orphan sweep
    // (the draft row doesn't exist yet for an in-flight unsaved draft;
    // for a persisted draft the attachment would survive until the next
    // promote / discard cycle). Splice locally either way so the UI
    // reflects the user's intent immediately.
    const attachment = pendingAttachments[idx];
    pendingAttachments.splice(idx, 1);
    renderFileList();
    void api(`/attachments/${String(attachment.id)}`, { method: 'DELETE' });
  });

  function renderFileList() {
    const template = toElement(
      <div>
        {pendingAttachments.map((att, i) => (
          <div className="not-working-file-row" data-key={`${String(att.id)}:${att.original_filename}`}>
            <span>{att.original_filename}</span>
            <button className="category-delete-btn" data-idx={String(i)}>{'×'}</button>
          </div>
        ))}
      </div>,
    );
    morph(fileListEl, template);
  }

  // HS-8428 — upload a file to the draft-attachment endpoint and append
  // to the pendingAttachments list. Fire-and-forget from the caller's
  // perspective; the file row appears as soon as the POST resolves. On
  // failure the file is silently dropped — same surface as the pre-fix
  // upload-on-submit path (which also had no UI for upload errors).
  async function uploadDraftAttachment(file: File): Promise<void> {
    // Direct `fetch` with FormData + the secret header — `apiUpload`
    // hits `/api/tickets/:id/attachments` directly; we need a different
    // path that includes the draft id.
    const url = `/api/tickets/${String(ticketId)}/feedback-drafts/${sessionDraftId}/attachments`;
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const { getActiveProject } = await import('./state.js');
    const proj = getActiveProject();
    if (proj !== null) headers['X-Hotsheet-Secret'] = proj.secret;
    try {
      const res = await fetch(url, { method: 'POST', body: form, headers });
      if (!res.ok) return;
      // HS-8567 — validate at the wire boundary.
      const raw: unknown = await res.json();
      const parsed = AttachmentResponseSchema.safeParse(raw);
      if (!parsed.success) return;
      pendingAttachments.push({ id: parsed.data.id, original_filename: parsed.data.original_filename });
      // Uploading a new file resets the "committed" flag — until the
      // next Save Draft / Submit, this attachment is unsaved.
      attachmentsCommitted = false;
      renderFileList();
    } catch { /* swallow — best-effort upload */ }
  }

  requireChild<HTMLButtonElement>(overlay, '#feedback-add-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) void uploadDraftAttachment(f);
    }
    fileInput.value = '';
  });

  // Drag-and-drop file support on the entire overlay
  overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      for (const f of Array.from(e.dataTransfer.files)) void uploadDraftAttachment(f);
    }
  });

  // Initial render so a reopen with prior-session attachments shows them
  // before the first user interaction.
  renderFileList();

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
      requireChild<HTMLTextAreaElement>(responseEl, 'textarea').focus();
    });
  });

  // HS-8428 — close cleans up orphaned attachments. Save Draft / Submit
  // set `attachmentsCommitted = true` before calling `close()` so the
  // cleanup only fires on the "user dismissed without saving" paths
  // (× button, Later button, outside-click-when-no-text). Cleanup
  // strategy:
  //   - If `draftPersistedToServer` is true (Save Draft was clicked at
  //     least once during this session), the attachments are linked to
  //     a real draft row — leaving them in place is the right behavior;
  //     they'll resurface on the next reopen of that draft.
  //   - Otherwise, the user uploaded files in a fresh dialog and never
  //     hit Save Draft, so there's no draft row to anchor them to.
  //     Fire DELETE on the (non-existent-but-tolerant) draft id; the
  //     server's DELETE handler drops the orphan attachments + their
  //     files on disk and returns ok.
  const close = () => {
    if (!attachmentsCommitted && !draftPersistedToServer && pendingAttachments.length > 0) {
      // Fire-and-forget — overlay removal can race the response.
      void deleteFeedbackDraft(ticketId, sessionDraftId).catch(() => { /* swallow */ });
    }
    overlay.remove();
  };
  requireChild<HTMLButtonElement>(overlay, '#feedback-close').addEventListener('click', close);
  requireChild<HTMLButtonElement>(overlay, '#feedback-later').addEventListener('click', close);
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
  const noResponseBtn = requireChild<HTMLButtonElement>(overlay, '#feedback-no-response');
  noResponseBtn.addEventListener('click', async () => {
    noResponseBtn.disabled = true;
    try {
      await updateTicket(ticketId, { notes: 'NO RESPONSE NEEDED' });
      close();
      void loadTickets();
    } catch {
      noResponseBtn.disabled = false;
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
    // HS-8428 — allow Save Draft when the user has only attached files
    // (no text yet) since the attachments are themselves draft state worth
    // preserving. Pre-fix the button required text and silently dropped
    // any attached files; with Option 1 the files are already uploaded
    // and just need a draft row to anchor them across reopens.
    if (!partitionsHaveText(partitions) && pendingAttachments.length === 0) {
      focusFirstInput(overlay);
      return;
    }

    const btn = overlay.querySelector('#feedback-save-draft') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      if (draftPersistedToServer) {
        await updateFeedbackDraft(ticketId, sessionDraftId, partitions);
      } else {
        // HS-8428 — use the pre-generated `sessionDraftId` (same id the
        // file-attach path already used for any uploads). The draft row
        // now anchors all the attachments that were uploaded earlier in
        // this session.
        await createFeedbackDraft(ticketId, {
          id: sessionDraftId,
          parent_note_id: effectiveParentNoteId,
          prompt_text: effectivePrompt,
          partitions,
        });
        draftPersistedToServer = true;
      }
      // HS-8428 — flip both flags so the close handler doesn't fire the
      // orphan-cleanup DELETE. Attachments are now linked to a real
      // draft row.
      attachmentsCommitted = true;
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
    if ((text === null || text === '') && pendingAttachments.length === 0) {
      focusFirstInput(overlay);
      return;
    }

    const submitBtn = overlay.querySelector('#feedback-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      // HS-8428 — promote draft-scoped attachments to real before the
      // note PATCH so the attachment list reflects the new attachments
      // by the time `loadTickets()` re-renders. Single UPDATE on the
      // server side so the transition is atomic. The promote endpoint
      // is a no-op when the draft has no attachments (the common case
      // for text-only submissions), so we can fire it unconditionally.
      if (pendingAttachments.length > 0) {
        await promoteFeedbackDraftAttachments(ticketId, sessionDraftId);
      }

      if (text !== null && text !== '') {
        await updateTicket(ticketId, { notes: text });
      }

      // HS-7599 / HS-8428: clear the draft on successful submit so the
      // user doesn't see a now-stale draft alongside the just-sent note.
      // The DELETE handler also cleans up any non-promoted draft
      // attachments — but since we just promoted them all (draft_id
      // cleared), the DELETE is a no-op on the attachment side and
      // only drops the draft row itself.
      if (draftPersistedToServer) {
        try {
          await deleteFeedbackDraft(ticketId, sessionDraftId);
        } catch { /* draft already gone — fine */ }
      }

      // HS-8428 — set both flags so the `close()` handler doesn't fire
      // the orphan-cleanup DELETE. Submit is the cleanest "we're done
      // with this dialog" exit; everything is committed.
      attachmentsCommitted = true;
      draftPersistedToServer = false; // draft row is gone, but no orphans

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

/** HS-8338 — exported as a test seam so the ticket-ref linkification in
 *  the header + the prompt blocks can be DOM-asserted without spinning up
 *  the full `showFeedbackDialog` flow. */
export function buildOverlay(ticketNumber: string, blocks: FeedbackBlock[]): HTMLElement {
  return toElement(
    <div className="feedback-dialog-overlay custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor feedback-dialog" style="width:560px">
        <div className="custom-view-editor-header">
          {/* HS-8338 — wrap the ticket number in a `.ticket-ref` anchor so the
              global capture-phase click handler in `ticketRefDialog.tsx`
              dispatches to `openTicketRefDialog(ticketNumber)`. Stacks on top
              of this dialog (z-index 2600 + N) so the user can see the
              referenced ticket without dismissing the feedback dialog.
              Self-reference is INTENTIONAL here — the whole point of the
              affordance is "let me re-open the originating ticket for
              reference while I'm composing a response". */}
          <span>{'Feedback Needed — '}<a className="ticket-ref" data-ticket-number={ticketNumber} href="javascript:void(0)">{ticketNumber}</a></span>
          <button className="detail-close" id="feedback-close">{'×'}</button>
        </div>
        <div className="custom-view-editor-body">
          <div className="feedback-prompt-stack">
            {blocks.length === 0
              ? <div className="feedback-prompt-block note-markdown feedback-prompt-empty"><em>(no prompt text)</em></div>
              : blocks.map((block, idx) => (
                  <>
                    {/* HS-8338 — linkify HS-NNNN refs in the prompt body so
                        clicks open a stacked reference dialog (`ticketRefDialog
                        .tsx`'s global handler reads the `.ticket-ref`
                        anchor's `data-ticket-number`). Self-refs are NOT
                        skipped — passing `undefined` for the current-ticket
                        argument intentionally; if the prompt references its
                        own ticket, the user usually does want to see it. */}
                    <div className="feedback-prompt-block note-markdown" data-block-index={String(idx)}>{
                      // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- `block.html` is sanitized markdown HTML; `linkifyWithCachedPrefixes` is HTML-in / HTML-out and only adds <a> tags around known ticket-prefix tokens.
                      raw(linkifyWithCachedPrefixes(block.html))
                    }</div>
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
            <textarea id="feedback-catchall-text" className="settings-textarea" rows={4} placeholder="Type your response..." style="width:100%;resize:vertical" spellCheck="true"></textarea>
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
      <textarea className="settings-textarea feedback-inline-textarea" rows={3} placeholder="Your response..." spellCheck="true"></textarea>
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
    // HS-8381 — backlog + archive tickets shouldn't drive the project-tab
    // dot. Matches the server-side `projectHasPendingFeedback` filter so
    // the inline (active project) and bulk (cross-project) writes agree
    // when the user is on the Backlog or Archive view.
    if (ticket.status === 'backlog' || ticket.status === 'archive' || ticket.status === 'deleted') continue;
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
  setTimeout(() => alert.remove(), TOAST_AUTOHIDE_MS);
  const notesContainer = byIdOrNull('detail-notes');
  if (notesContainer !== null) notesContainer.prepend(alert);
}
