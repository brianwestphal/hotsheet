import {
  createFeedbackDraft, deleteAttachment, deleteFeedbackDraft, getFeedbackDrafts,
  promoteFeedbackDraftAttachments, updateFeedbackDraft, updateTicket,
  uploadDraftAttachment as uploadDraftAttachmentToServer,
} from '../api/index.js';
import { raw } from '../jsx-runtime.js';
import { choiceDialog } from './confirm.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import {
  type BlockResponse,
  combineQuotedResponse,
  type FeedbackBlock,
  parseFeedbackBlocks,
} from './feedbackParser.js';
import type { FeedbackDraft, NoteEntry } from './noteRenderer.js';
import { delegate, morph } from './reactive.js';
import { buildCombinedReaderEntries, renderReaderBodyHtml } from './readerOverlay.js';
import { loadTickets } from './ticketList.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';
import { TOAST_AUTOHIDE_MS } from './uiTimings.js';

// HS-8836 — Lucide chevron glyphs for the feedback dialog's prev/next nav,
// matching the reader overlay's `CHEVRON_UP_SVG` / `CHEVRON_DOWN_SVG`.
const NAV_ICON_ATTRS = {
  xmlns: 'http://www.w3.org/2000/svg', width: '16', height: '16', viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
} as const;
const CHEVRON_UP = <svg {...NAV_ICON_ATTRS}><path d="m18 15-6-6-6 6"/></svg>;
const CHEVRON_DOWN = <svg {...NAV_ICON_ATTRS}><path d="m6 9 6 6 6-6"/></svg>;

/**
 * HS-8836 — navigation context for the feedback dialog. The chevrons page a
 * read-only view through the ticket's combined [Details + notes] entries (the
 * same list the reader overlay builds), so the user can review previous notes
 * and the description WITHOUT leaving their in-progress response — Option 1:
 * the response box + action buttons stay pinned, only the upper area pages.
 * `entries` is the combined list (newest note last); `activeNoteId` is the
 * feedback note whose entry shows the interactive prompt-stack instead of a
 * read-only render.
 */
export interface FeedbackNav {
  entries: { id: string; title: string; markdown: string }[];
  activeNoteId: string;
}

/**
 * HS-8836 — build the feedback dialog's nav from a ticket's details + notes,
 * reusing the reader overlay's `buildCombinedReaderEntries` so the dialog and
 * the reader page the exact same list. Returns `undefined` when there's nothing
 * to page to (only the feedback note, no prior notes or Details) so the caller
 * opens the dialog without chevrons.
 */
export function buildFeedbackNav(
  input: { ticketNumber: string | null | undefined; ticketTitle: string | null | undefined; detailsMarkdown: string; notes: readonly NoteEntry[] },
  activeNoteId: string,
): FeedbackNav | undefined {
  const entries = buildCombinedReaderEntries(input);
  if (entries.length <= 1) return undefined;
  return { entries: entries.map(e => ({ id: e.id, title: e.title, markdown: e.markdown })), activeNoteId };
}

const STANDARD_PHRASE = 'FEEDBACK NEEDED';
const IMMEDIATE_PHRASE = 'IMMEDIATE FEEDBACK NEEDED';

/** Parse a note's text for a feedback request. Returns null if not a feedback note.
 *
 *  HS-8702 — the all-caps phrase is matched ANYWHERE in the note, not just as a
 *  strict leading prefix, and the trailing colon is optional. AIs don't always
 *  place "FEEDBACK NEEDED" at the very start of the note or include the colon
 *  (the worklist still instructs them to — we just stopped requiring it on the
 *  read side). Matching is case-sensitive so ordinary lowercase prose like
 *  "feedback needed from you" never false-positives. The prompt is the text
 *  after the phrase (leading colon + whitespace stripped); any context before
 *  the phrase stays visible in the full note body in the detail panel. */
export function parseFeedbackPrefix(text: string): { type: 'standard' | 'immediate'; prompt: string } | null {
  const immediateIdx = text.indexOf(IMMEDIATE_PHRASE);
  if (immediateIdx !== -1) {
    return { type: 'immediate', prompt: extractFeedbackPrompt(text, immediateIdx + IMMEDIATE_PHRASE.length) };
  }
  const standardIdx = text.indexOf(STANDARD_PHRASE);
  if (standardIdx !== -1) {
    return { type: 'standard', prompt: extractFeedbackPrompt(text, standardIdx + STANDARD_PHRASE.length) };
  }
  return null;
}

/** The prompt is whatever follows the matched phrase, with a single leading
 *  colon + surrounding whitespace stripped. Empty string when the phrase is
 *  the last thing in the note. */
function extractFeedbackPrompt(text: string, from: number): string {
  return text.slice(from).replace(/^:?\s*/, '').trim();
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
  // HS-8644 — NEVER auto-show over an already-open feedback dialog. The
  // auto-show is driven by `loadDetail` / the selection re-render, both of
  // which re-fire on every `/poll` tick; `showFeedbackDialog` removes +
  // recreates the `.feedback-dialog-overlay`, so re-firing while the user is
  // mid-typing destroys their input (the reported data-loss bug). HS-8645
  // since made the `parseNotesJson` fallback id deterministic, so the
  // `lastAutoShownKey` key no longer drifts for an id-less note — but this
  // overlay guard stays as the robust catch-all against ANY re-render path
  // that might re-enter the auto-show. Manual re-open (a user click) is a
  // separate, intentional path that doesn't run through here.
  if (typeof document !== 'undefined' && document.querySelector('.feedback-dialog-overlay') !== null) {
    return false;
  }
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
  nav?: FeedbackNav,
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
  showFeedbackDialog(ticketId, ticketNumber, prompt, seed, noteId, nav);
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

/**
 * HS-8680 — shared state carried across the dialog's button handlers.
 * `state` is mutable: `buildSaveDraftHandler` flips `draftPersistedToServer`
 * after a successful POST; both Save Draft and Submit flip `attachmentsCommitted`
 * so the `close()` cleanup branch knows not to fire the orphan-delete DELETE.
 * `pendingAttachments` is shared by reference so the attachment-section
 * uploads + the Submit/Save handlers see the same list.
 */
interface FeedbackDialogCtx {
  ticketId: number;
  ticketNumber: string;
  blocks: FeedbackBlock[];
  overlay: HTMLElement;
  pendingAttachments: { id: number; original_filename: string }[];
  sessionDraftId: string;
  effectiveParentNoteId: string | null;
  effectivePrompt: string;
  state: { draftPersistedToServer: boolean; attachmentsCommitted: boolean };
  close: () => void;
}

/** HS-8680 / HS-7599 — restore inline responses + catch-all text from a saved
 *  draft into the overlay BEFORE insert-response wiring so each saved response
 *  lands in its original slot. */
function restoreDraftSeedToOverlay(overlay: HTMLElement, draftSeed: FeedbackDraftSeed): void {
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

/**
 * HS-8680 / HS-8428 — wire the dialog's attachment section: file-list render +
 * delete-delegate, the upload helper (uploads to the draft-scoped endpoint so
 * a Save-Draft + close path no longer drops files), the add-file button, the
 * file-input change handler, and overlay-wide drag/drop. Returns the upload
 * helper (so Submit/Save can re-render after promote/clear) and the
 * `disposeFileDeleteDelegate` so `close()` can release the delegate.
 */
function setupAttachmentSection(opts: {
  overlay: HTMLElement;
  ticketId: number;
  sessionDraftId: string;
  pendingAttachments: { id: number; original_filename: string }[];
  state: { attachmentsCommitted: boolean };
}): { disposeFileDeleteDelegate: () => void } {
  const { overlay, ticketId, sessionDraftId, pendingAttachments, state } = opts;
  const fileListEl = overlay.querySelector<HTMLElement>('#feedback-files')!;
  const fileInput = overlay.querySelector('#feedback-file-input') as HTMLInputElement;

  function renderFileList(): void {
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

  // HS-8615 — kerf `delegate()` (containment + closest() walk built in). The
  // delegate is per-overlay; its disposer fires in `close()`.
  const disposeFileDeleteDelegate = delegate<HTMLButtonElement>(fileListEl, 'click', '.category-delete-btn', (_e, btn) => {
    const idx = parseInt(btn.dataset.idx ?? '-1', 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= pendingAttachments.length) return;
    // HS-8428 — best-effort DELETE; if it fails the orphan sweep cleans up.
    const attachment = pendingAttachments[idx];
    pendingAttachments.splice(idx, 1);
    renderFileList();
    void deleteAttachment(attachment.id);
  });

  async function uploadDraftAttachment(file: File): Promise<void> {
    try {
      const att = await uploadDraftAttachmentToServer(ticketId, sessionDraftId, file);
      pendingAttachments.push({ id: att.id, original_filename: att.original_filename });
      state.attachmentsCommitted = false;
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

  overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      for (const f of Array.from(e.dataTransfer.files)) void uploadDraftAttachment(f);
    }
  });

  renderFileList();

  return { disposeFileDeleteDelegate };
}

/**
 * HS-8680 / HS-7930 — wire the per-slot click-to-add-response handler. The
 * slot itself is the click target so a click anywhere in the gap between two
 * blocks drops a response. One response per slot; clicking a populated slot
 * is a no-op so the user can interact with their textarea / × button without
 * spawning duplicates.
 */
function wireInsertSlots(overlay: HTMLElement): void {
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
}

/** HS-8680 — No Response Needed: persist the placeholder note, close, reload. */
function buildNoResponseHandler(ctx: FeedbackDialogCtx, btn: HTMLButtonElement): () => Promise<void> {
  return async () => {
    btn.disabled = true;
    try {
      await updateTicket(ctx.ticketId, { notes: 'NO RESPONSE NEEDED' });
      ctx.close();
      void loadTickets();
    } catch {
      btn.disabled = false;
    }
  };
}

/**
 * HS-8680 / HS-7599 — Save Draft: persist the dialog state to `feedback_drafts`
 * so the user can come back later without sending. POST creates a new draft
 * (id pre-generated client-side as `sessionDraftId`); PATCH updates the seed
 * draft. After success the dialog closes and the notes list re-renders so the
 * new draft entry appears inline after its FEEDBACK NEEDED parent. HS-8428 —
 * allow Save Draft when only attachments exist (no text yet) since the
 * attachments are themselves draft state worth preserving.
 */
function buildSaveDraftHandler(ctx: FeedbackDialogCtx): () => Promise<void> {
  return async () => {
    const partitions = collectPartitions(ctx.overlay, ctx.blocks);
    if (!partitionsHaveText(partitions) && ctx.pendingAttachments.length === 0) {
      focusFirstInput(ctx.overlay);
      return;
    }
    const btn = ctx.overlay.querySelector('#feedback-save-draft') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      if (ctx.state.draftPersistedToServer) {
        await updateFeedbackDraft(ctx.ticketId, ctx.sessionDraftId, partitions);
      } else {
        await createFeedbackDraft(ctx.ticketId, {
          id: ctx.sessionDraftId,
          parent_note_id: ctx.effectiveParentNoteId,
          prompt_text: ctx.effectivePrompt,
          partitions,
        });
        ctx.state.draftPersistedToServer = true;
      }
      // Both flags flip so close() skips the orphan-cleanup DELETE — attachments
      // are now linked to a real draft row.
      ctx.state.attachmentsCommitted = true;
      ctx.close();
      // HS-9008 — the saved draft renders inline in the notes list ONLY after
      // the detail panel re-fetches the ticket's drafts (drafts come from a
      // separate `getFeedbackDrafts` fetch, NOT from the ticket's `notes`).
      // `loadTickets()` re-renders the LIST + `syncDetailPanel` but reuses the
      // STALE cached drafts map, so the new draft didn't appear until the user
      // navigated away and back (which re-ran `loadDetail`'s drafts fetch). Now
      // we refresh just this ticket's drafts + re-render its notes — surgical,
      // so it doesn't re-run the full `loadDetail` (no ticket re-fetch, no
      // auto-show re-entry that would reopen the just-closed dialog). Dynamic
      // import breaks the detail↔feedbackDialog cycle.
      void import('./detail.js').then(m => { m.refreshFeedbackDrafts(ctx.ticketId); });
      void loadTickets();
    } catch {
      btn.textContent = 'Save Draft';
      btn.disabled = false;
    }
  };
}

/**
 * HS-8680 / HS-7599 — Submit: promote draft-scoped attachments to real, write
 * the note, delete the draft row if persisted, close, reload, ping the channel.
 * HS-8428 — promote runs BEFORE the note PATCH so the attachment list reflects
 * the new attachments by the time `loadTickets()` re-renders. The promote
 * endpoint is a no-op when there are no draft attachments.
 */
function buildSubmitHandler(ctx: FeedbackDialogCtx): () => Promise<void> {
  return async () => {
    const text = collectResponse(ctx.overlay, ctx.blocks);
    if ((text === null || text === '') && ctx.pendingAttachments.length === 0) {
      focusFirstInput(ctx.overlay);
      return;
    }
    const submitBtn = ctx.overlay.querySelector('#feedback-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    try {
      if (ctx.pendingAttachments.length > 0) {
        await promoteFeedbackDraftAttachments(ctx.ticketId, ctx.sessionDraftId);
      }
      if (text !== null && text !== '') {
        await updateTicket(ctx.ticketId, { notes: text });
      }
      // HS-7599 / HS-8428 — clear the draft on successful submit so the user
      // doesn't see a now-stale draft alongside the just-sent note. The promote
      // step above cleared `draft_id` on every attachment, so the DELETE only
      // drops the draft row itself.
      if (ctx.state.draftPersistedToServer) {
        try { await deleteFeedbackDraft(ctx.ticketId, ctx.sessionDraftId); } catch { /* gone */ }
      }
      // Both flags flip so close() skips the orphan-cleanup DELETE.
      ctx.state.attachmentsCommitted = true;
      ctx.state.draftPersistedToServer = false;
      ctx.close();
      void loadTickets();
      // HS-9207 — refresh the open detail panel immediately so the just-submitted
      // response note appears right away. Previously the submit only re-rendered
      // the LIST (`loadTickets`); the detail panel's notes were re-rendered only
      // when a `/ws/sync` `detail` push (or the next poll) happened to arrive — so
      // the user "sometimes" had to switch tickets and back to see their response.
      // `refreshDetail` re-fetches the active ticket and re-renders its notes; the
      // last note is now the response (not a FEEDBACK note), so it does NOT
      // re-trigger the auto-show dialog.
      void import('./detail.js').then(m => { m.refreshDetail(); });
      void notifyChannel(ctx.ticketNumber);
    } catch {
      submitBtn.textContent = 'Submit';
      submitBtn.disabled = false;
    }
  };
}

export function showFeedbackDialog(
  ticketId: number,
  ticketNumber: string,
  prompt: string,
  draftSeed?: FeedbackDraftSeed,
  parentNoteId?: string,
  nav?: FeedbackNav,
) {
  // Clear any prior feedback dialog.
  document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());

  // HS-7599 — re-opening an existing draft uses the saved block layout verbatim
  // so future changes to `parseFeedbackBlocks` don't reshape it.
  const blocks = draftSeed !== undefined ? draftSeed.partitions.blocks : parseFeedbackBlocks(prompt);
  const effectivePrompt = draftSeed !== undefined ? draftSeed.promptText : prompt;
  const effectiveParentNoteId = draftSeed?.parentNoteId ?? parentNoteId ?? null;
  // HS-8836 — only show the nav chevrons when there's something to page to.
  const showNav = nav !== undefined && nav.entries.length > 1;
  const overlay = buildOverlay(ticketNumber, blocks, showNav);

  if (draftSeed !== undefined) restoreDraftSeedToOverlay(overlay, draftSeed);

  // HS-8428 — stable `sessionDraftId` for the session. Reuse the seed's id on
  // reopen so new file uploads link to the same draft; generate upfront on a
  // fresh dialog so the user can attach files BEFORE Save Draft (the draft row
  // doesn't have to exist yet — POST /attachments doesn't FK-check it; the
  // orphan sweep GCs unsaved rows). `draftPersistedToServer` tracks whether the
  // draft row exists server-side (Save Draft was clicked at least once);
  // `attachmentsCommitted` tracks whether attachments are in their "final"
  // state (promoted via Submit OR anchored via Save Draft). Both drive the
  // close-without-save cleanup decision.
  const sessionDraftId = draftSeed?.id ?? `fd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const state = {
    draftPersistedToServer: draftSeed !== undefined,
    attachmentsCommitted: draftSeed !== undefined,
  };
  const pendingAttachments: { id: number; original_filename: string }[] =
    (draftSeed?.attachments ?? []).map(a => ({ id: a.id, original_filename: a.original_filename }));

  const { disposeFileDeleteDelegate } = setupAttachmentSection({
    overlay, ticketId, sessionDraftId, pendingAttachments, state,
  });

  wireInsertSlots(overlay);

  // HS-8428 — close cleans up orphaned attachments. Save Draft / Submit flip
  // `state.attachmentsCommitted` BEFORE calling `close()` so the cleanup only
  // fires on the "dismissed without saving" paths (× button, Later button,
  // outside-click-when-no-text). When the draft row exists, attachments stay
  // anchored and resurface on next reopen; otherwise the DELETE drops the
  // orphan rows + their files on disk (the server's DELETE handler tolerates a
  // missing draft id).
  const close = () => {
    if (!state.attachmentsCommitted && !state.draftPersistedToServer && pendingAttachments.length > 0) {
      void deleteFeedbackDraft(ticketId, sessionDraftId).catch(() => { /* swallow */ });
    }
    disposeFileDeleteDelegate();
    overlay.remove();
  };
  requireChild<HTMLButtonElement>(overlay, '#feedback-later').addEventListener('click', close);
  // HS-7599 — click outside dismisses ONLY when no text has been entered.
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    if (overlayHasAnyText(overlay)) return;
    close();
  });

  const ctx: FeedbackDialogCtx = {
    ticketId, ticketNumber, blocks, overlay, pendingAttachments,
    sessionDraftId, effectiveParentNoteId, effectivePrompt, state, close,
  };

  // One shared Save Draft handler — used by both the explicit button and the
  // HS-9180 close-guard below (it saves the draft + calls `close()`).
  const saveDraftHandler = buildSaveDraftHandler(ctx);

  // HS-9180 — closing via the × with unsaved text must NOT silently lose it.
  // Offer Save Draft / Discard / Keep Editing (the outside-click path above
  // already refuses to close when there's text; the × was the lone data-loss
  // gap). No text → close immediately. Esc/backdrop on the prompt = Keep Editing.
  const closeWithUnsavedGuard = async () => {
    if (!overlayHasAnyText(overlay)) { close(); return; }
    const choice = await choiceDialog({
      title: 'Unsaved feedback',
      message: `You have unsaved changes for ${ticketNumber}. Save them as a draft to come back to later?`,
      primaryLabel: 'Save Draft',
      secondaryLabel: 'Discard',
      cancelLabel: 'Keep Editing',
      secondaryDanger: true,
    });
    if (choice === 'primary') await saveDraftHandler();
    else if (choice === 'secondary') close();
    // 'cancel' → keep editing (leave the dialog open)
  };
  requireChild<HTMLButtonElement>(overlay, '#feedback-close').addEventListener('click', () => { void closeWithUnsavedGuard(); });

  const noResponseBtn = requireChild<HTMLButtonElement>(overlay, '#feedback-no-response');
  noResponseBtn.addEventListener('click', buildNoResponseHandler(ctx, noResponseBtn));
  overlay.querySelector('#feedback-save-draft')!.addEventListener('click', saveDraftHandler);
  overlay.querySelector('#feedback-submit')!.addEventListener('click', buildSubmitHandler(ctx));

  // HS-8836 — wire the prev/next context navigation when there's a list to page.
  if (showNav) wireFeedbackNav(overlay, nav);

  document.body.appendChild(overlay);
  focusFirstInput(overlay);
}

/**
 * HS-8836 — wire the feedback dialog's prev/next context navigation (Option 1).
 * The arrows page a read-only view through the ticket's [Details + notes] while
 * the response box + action buttons stay pinned below — so reviewing earlier
 * context never disturbs the in-progress response (including any inline
 * responses already added to the prompt-stack, which are simply hidden and
 * restored, never rebuilt). Keyboard ↑/↓ also navigate, but only when focus
 * isn't in an editable field, so typing a response keeps normal cursor motion.
 */
function wireFeedbackNav(overlay: HTMLElement, nav: FeedbackNav): void {
  const prevBtn = overlay.querySelector<HTMLButtonElement>('.feedback-nav-prev');
  const nextBtn = overlay.querySelector<HTMLButtonElement>('.feedback-nav-next');
  if (prevBtn === null || nextBtn === null) return;
  const promptStack = requireChild(overlay, '.feedback-prompt-stack');
  const contextView = requireChild(overlay, '.feedback-context-view');
  const caption = requireChild(overlay, '.feedback-nav-caption');

  // Start on the feedback note's entry (the interactive prompt). If its id isn't
  // in the list (id-less note), fall back to the last entry — the newest note.
  const foundIdx = nav.entries.findIndex(e => e.id === nav.activeNoteId);
  const activeIndex = foundIdx === -1 ? nav.entries.length - 1 : foundIdx;
  let currentIndex = activeIndex;

  const paint = (): void => {
    const onFeedback = currentIndex === activeIndex;
    promptStack.hidden = !onFeedback;
    contextView.hidden = onFeedback;
    caption.hidden = onFeedback;
    if (!onFeedback) {
      const entry = nav.entries[currentIndex];
      caption.textContent = `Viewing: ${entry.title}`;
      morph(contextView, renderReaderBodyHtml(entry.markdown));
      contextView.scrollTop = 0;
    }
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === nav.entries.length - 1;
  };

  const go = (delta: number): void => {
    const next = currentIndex + delta;
    if (next < 0 || next > nav.entries.length - 1) return;
    currentIndex = next;
    paint();
  };

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const ae = document.activeElement;
    if (ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement
      || (ae instanceof HTMLElement && ae.isContentEditable)) return;
    e.preventDefault();
    go(e.key === 'ArrowUp' ? -1 : 1);
  });

  paint();
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
export function buildOverlay(ticketNumber: string, blocks: FeedbackBlock[], showNav = false): HTMLElement {
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
          {/* HS-8836 — prev/next chevrons page a read-only view through the
              ticket's [Details + previous notes] while the response box stays
              pinned below. Rendered only when there's prior context to page to. */}
          {showNav
            ? <div className="feedback-nav-controls">
                <button className="feedback-nav-prev" type="button" title="Previous — older note / Details" aria-label="Previous note">{CHEVRON_UP}</button>
                <button className="feedback-nav-next" type="button" title="Next — toward your response" aria-label="Next note">{CHEVRON_DOWN}</button>
              </div>
            : null}
          <button className="detail-close" id="feedback-close">{'×'}</button>
        </div>
        <div className="custom-view-editor-body">
          {/* HS-8836 — read-only context view + caption, shown when the user
              pages back to a previous note / Details; hidden while on the
              feedback note (where the interactive prompt-stack shows instead). */}
          {showNav
            ? <>
                <div className="feedback-nav-caption" hidden={true}></div>
                <div className="feedback-context-view note-markdown" hidden={true}></div>
              </>
            : null}
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
