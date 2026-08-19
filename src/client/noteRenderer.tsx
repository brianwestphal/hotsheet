import './markdownSetup.js';

import { trustedRaw } from 'kerfjs';

// HS-8642 — `FeedbackDraft` + `FeedbackDraftAttachmentSummary` are now defined
// once as the wire SSOT in `src/api/feedbackDrafts.ts` (inferred from
// `FeedbackDraftSchema`). Imported for local use + re-exported (below) so the
// many existing `import { FeedbackDraft } from './noteRenderer.js'` consumers
// keep working without a churny path rewrite. See docs/21-feedback.md §21.2.3.
import type { FeedbackDraft, FeedbackDraftAttachmentSummary } from '../api/feedbackDrafts.js';
import { deleteFeedbackDraft, deleteTicketNote, editTicketNote } from '../api/index.js';
import { isSystemStatusNote, lastMeaningfulNoteIndex } from '../systemNotes.js';
import { byIdOrNull, toElement } from './dom.js';
import { isChannelEnabled } from './experimentalSettings.js';
import { buildFeedbackNav, getTicketFeedbackState, openFeedbackDialogForNote, parseFeedbackPrefix, showFeedbackDialog, toDraftSeed } from './feedbackDialog.js';
import { ICON_TRASH } from './icons.js';
import { appendImageDownloadLinks, proxyGitHubImages } from './imageProxy.js';
import { parseMarkdownCached } from './markdownCache.js';
import { delegate, morph } from './reactive.js';
import { buildCombinedReaderEntries, buildNoteReaderTitle, openReaderOverlay } from './readerOverlay.js';
import { state } from './state.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';
import { BUTTON_BUSY_MS, TOAST_AUTOHIDE_MS } from './uiTimings.js';
import { pushNotesUndo } from './undo/actions.js';

/** HS-7957 — Lucide `book-open-text` glyph. Inline SVG (not a sprite ref)
 *  for CSP friendliness in Tauri's WKWebView. Inherits `currentColor` so the
 *  hover state lights up alongside the megaphone. See docs/49-reader-mode.md
 *  §49.3 for the path data origin. */
const BOOK_READER_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 8h2"/><path d="M6 12h2"/></svg>;
const MEGAPHONE_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>;
const ADD_NOTE_PLUS_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>;

/** HS-7601 — the megaphone button only appears when the channel feature is
 *  enabled. Wraps `isChannelEnabled` so the call site reads clearly. */
function isChannelFeatureEnabled(): boolean {
  return isChannelEnabled();
}

export type NoteEntry = { id?: string; text: string; created_at: string };

// Re-exported (imported at the top of the module) so existing
// `import { FeedbackDraft } from './noteRenderer.js'` consumers keep working.
export type { FeedbackDraft, FeedbackDraftAttachmentSummary };

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

/**
 * HS-8645 — DETERMINISTIC fallback id for a note that has no server-side `id`.
 * `parseNotesJson` runs on every `/poll` tick (`loadDetail` re-parses the notes
 * column each time); the old random `clientNoteId()` produced a fresh id per
 * parse, so an id-less note's id drifted poll-to-poll. That drift broke
 * anything keyed on note id across re-parses — the HS-8644 feedback auto-show
 * key (`${ticketId}:${noteId}`), focus preservation, and `data-note-id`
 * stability. The same `(index, text, created_at)` now always maps to the same
 * id. The `index` keeps distinct notes unique even if two share text +
 * created_at; the djb2 content hash keeps the id stable + recognizable. id-less
 * notes can't be server-edited/deleted anyway (the server never knew the id),
 * so an index shift on a future structural change is harmless.
 */
function deterministicNoteId(index: number, text: string, createdAt: string): string {
  // The NUL separator is written as the ESCAPE `\0`, not as a literal NUL byte. It used
  // to be literal, which made this file binary to `grep` and `rg` — both stop at the
  // first NUL and report "binary file matches" instead of the matching lines, so every
  // code search over this 674-line module silently returned nothing. Identical string
  // either way; only the source bytes differ.
  const s = `${text}\0${createdAt}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // djb2 (unsigned)
  return `cn_${String(index)}_${h.toString(36)}`;
}

export function parseNotesJson(rawStr: string): NoteEntry[] {
  if (rawStr === '') return [];
  try {
    const parsed: unknown = JSON.parse(rawStr);
    if (Array.isArray(parsed)) {
      return (parsed as { id?: string; text: string; created_at: string }[]).map((n, index) => ({
        id: n.id ?? deterministicNoteId(index, n.text, n.created_at),
        text: n.text,
        created_at: n.created_at,
      }));
    }
  } catch { /* not JSON */ }
  if (rawStr.trim()) return [{ id: deterministicNoteId(0, rawStr, ''), text: rawStr, created_at: '' }];
  return [];
}

function syncNotesToState(ticketId: number, notes: NoteEntry[]) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (ticket) ticket.notes = JSON.stringify(notes);
}

// HS-8613 — the per-note / per-draft listeners are delegated ONCE at the
// stable `#detail-notes` container (`ensureNotesDelegationBound`) instead of
// being re-attached per element on every `renderNotes` call (which fires on
// every note add / edit / delete AND on every detail-panel load). The handlers
// recover their target from this render context + the clicked element's
// `data-note-id` / `data-draft-id`, so the rebuilt rows carry NO closure-
// captured listeners. (`#detail-notes` is reused across tickets, so the
// ticketId/notes can't be captured in the delegate closures — they live here.)
let currentNotesContext: { ticketId: number; notes: NoteEntry[] } | null = null;

let notesDelegationContainer: HTMLElement | null = null;
let notesDelegationDisposers: (() => void)[] = [];

/** Test-only — drop the delegated note listeners + binding marker so the next
 *  render re-binds against a fresh `#detail-notes`. */
export function _resetNotesDelegationForTests(): void {
  for (const dispose of notesDelegationDisposers) dispose();
  notesDelegationDisposers = [];
  notesDelegationContainer = null;
  currentNotesContext = null;
}

/** Find the note the clicked element belongs to, via its row's `data-note-id`. */
function noteFor(el: Element): { ctx: { ticketId: number; notes: NoteEntry[] }; note: NoteEntry } | null {
  if (currentNotesContext === null) return null;
  const id = el.closest('.note-entry')?.getAttribute('data-note-id') ?? '';
  const note = currentNotesContext.notes.find(n => (n.id ?? '') === id);
  return note === undefined ? null : { ctx: currentNotesContext, note };
}

/** Commit an inline note edit (shared by the delegated blur + Cmd/Ctrl+Enter
 *  handlers). The `data-committed` guard is the HS-8437 re-entrancy guard,
 *  stored on the textarea so it survives the blur that `replaceChildren` fires
 *  synchronously while detaching the focused textarea during the first save. */
async function saveNoteEdit(ta: HTMLTextAreaElement): Promise<void> {
  if (ta.dataset.committed === '1') return;
  ta.dataset.committed = '1';
  const found = noteFor(ta);
  if (found === null) {
    if (currentNotesContext !== null) renderNotes(currentNotesContext.ticketId, currentNotesContext.notes);
    return;
  }
  const { ctx, note } = found;
  const newText = ta.value.trim();
  if (newText !== '' && newText !== note.text) {
    const ticket = state.tickets.find(t => t.id === ctx.ticketId);
    const afterNotes = ctx.notes.map(n => n.id === note.id ? { ...n, text: newText } : n);
    if (ticket) pushNotesUndo(ticket, 'Edit note', JSON.stringify(afterNotes));
    if (note.id !== undefined) await editTicketNote(ctx.ticketId, note.id, newText);
    note.text = newText;
    syncNotesToState(ctx.ticketId, ctx.notes);
  }
  renderNotes(ctx.ticketId, ctx.notes);
}

/** Right-click a regular note → confirm-less delete menu (mirrors the pre-fix
 *  per-note contextmenu handler). The menu + its document-click closer are
 *  one-shot self-removing nodes appended to `document.body` — out of scope for
 *  delegation per the HS-8613 note. */
function openNoteDeleteMenu(e: MouseEvent, entry: HTMLElement): void {
  e.preventDefault();
  const found = noteFor(entry);
  if (found === null) return;
  const { ctx, note } = found;
  document.querySelectorAll('.note-context-menu').forEach(m => m.remove());
  const menu = toElement(
    <div className="note-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
      <div className="context-menu-item danger">
        <span className="dropdown-icon">{ICON_TRASH}</span>
        <span className="context-menu-label">Delete Note</span>
      </div>
    </div>
  );
  menu.querySelector('.context-menu-item')!.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    menu.remove();
    const ticket = state.tickets.find(t => t.id === ctx.ticketId);
    const afterNotes = ctx.notes.filter(n => n.id !== note.id);
    if (ticket) pushNotesUndo(ticket, 'Delete note', JSON.stringify(afterNotes));
    if (note.id !== undefined) await deleteTicketNote(ctx.ticketId, note.id);
    const idx = ctx.notes.indexOf(note);
    if (idx >= 0) ctx.notes.splice(idx, 1);
    syncNotesToState(ctx.ticketId, ctx.notes);
    renderNotes(ctx.ticketId, ctx.notes);
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
}

/** Right-click a draft entry → delete-draft menu (mirrors the pre-fix
 *  per-draft contextmenu handler). */
function openDraftDeleteMenu(e: MouseEvent, entry: HTMLElement): void {
  e.preventDefault();
  if (currentNotesContext === null) return;
  const ctx = currentNotesContext;
  const draftId = entry.getAttribute('data-draft-id');
  if (draftId === null) return;
  document.querySelectorAll('.note-context-menu').forEach(m => m.remove());
  const menu = toElement(
    <div className="note-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
      <div className="context-menu-item danger">
        <span className="dropdown-icon">{ICON_TRASH}</span>
        <span className="context-menu-label">Delete Draft</span>
      </div>
    </div>
  );
  menu.querySelector('.context-menu-item')!.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    menu.remove();
    try { await deleteFeedbackDraft(ctx.ticketId, draftId); } catch { /* ignore */ }
    const drafts = ticketDraftsCache.get(ctx.ticketId) ?? [];
    ticketDraftsCache.set(ctx.ticketId, drafts.filter(d => d.id !== draftId));
    renderNotes(ctx.ticketId, ctx.notes);
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
}

/** Bind the delegated note/draft listeners once at the stable `#detail-notes`
 *  container. Element-identity tracked: production binds once (the detail panel
 *  is page-lifetime), tests rebuild the DOM so a changed element disposes +
 *  re-binds rather than stacking duplicates. */
function ensureNotesDelegationBound(container: HTMLElement): void {
  if (notesDelegationContainer === container) return;
  for (const dispose of notesDelegationDisposers) dispose();
  notesDelegationDisposers = [];
  notesDelegationContainer = container;
  const d = notesDelegationDisposers;

  // Reader button — open the note's body in the §49 reader overlay, with
  // chevron navigation across [Details, ...non-empty notes] (HS-8233 / HS-8429).
  d.push(delegate<HTMLButtonElement>(container, 'click', '.note-reader-btn', (e, btn) => {
    e.stopPropagation();
    const found = noteFor(btn);
    if (found === null) return;
    const { ctx, note } = found;
    const ticket = state.tickets.find(t => t.id === ctx.ticketId) ?? null;
    // HS-8836 — when the note is the active (unanswered) FEEDBACK NEEDED note —
    // i.e. it's still the most recent note, so no response has been added yet —
    // the reader button opens the FEEDBACK dialog (which has its own prev/next
    // context navigation) instead of the read-only reader overlay. Once a
    // response or "No Response Needed" note follows it, `getTicketFeedbackState`
    // returns null and the button falls through to the normal reader below.
    const feedback = getTicketFeedbackState(ctx.notes);
    if (feedback !== null && note.id !== undefined && note.id !== '' && feedback.noteId === note.id) {
      const ticketNumber = ticket?.ticket_number ?? `#${ctx.ticketId}`;
      const nav = buildFeedbackNav(
        { ticketNumber: ticket?.ticket_number, ticketTitle: ticket?.title, detailsMarkdown: ticket?.details ?? '', notes: ctx.notes },
        note.id,
      );
      void openFeedbackDialogForNote(ctx.ticketId, ticketNumber, feedback.prompt, note.id, nav);
      return;
    }
    const combined = buildCombinedReaderEntries({
      ticketNumber: ticket?.ticket_number,
      ticketTitle: ticket?.title,
      detailsMarkdown: ticket?.details ?? '',
      notes: ctx.notes,
    });
    const initialIndex = Math.max(0, combined.findIndex(e2 => e2.id === note.id));
    openReaderOverlay({
      title: buildNoteReaderTitle(note.created_at),
      markdown: note.text,
      navigation: combined.length > 1
        ? { entries: combined.map(e2 => ({ title: e2.title, markdown: e2.markdown })), initialIndex }
        : undefined,
    });
  }));

  // Megaphone — send the note to Claude via the channel (HS-7601).
  d.push(delegate<HTMLButtonElement>(container, 'click', '.note-megaphone-btn', (e, btn) => {
    e.stopPropagation();
    const found = noteFor(btn);
    if (found === null) return;
    void onMegaphoneClick(btn, found.ctx.ticketId, found.note.text);
  }));

  // "Provide Feedback" inline link on the last FEEDBACK-NEEDED note.
  d.push(delegate<HTMLButtonElement>(container, 'click', '.feedback-link', (e, link) => {
    e.stopPropagation();
    const found = noteFor(link);
    if (found === null) return;
    const { ctx, note } = found;
    const feedback = parseFeedbackPrefix(note.text);
    if (feedback === null) return;
    const ticket = state.tickets.find(t => t.id === ctx.ticketId);
    const ticketNumber = ticket?.ticket_number ?? `#${ctx.ticketId}`;
    // HS-8836 — give the dialog the same prev/next context nav as the reader.
    const nav = note.id === undefined || note.id === '' ? undefined : buildFeedbackNav(
      { ticketNumber: ticket?.ticket_number, ticketTitle: ticket?.title, detailsMarkdown: ticket?.details ?? '', notes: ctx.notes },
      note.id,
    );
    void openFeedbackDialogForNote(ctx.ticketId, ticketNumber, feedback.prompt, note.id, nav);
  }));

  // Bottom "Add note" button — forwards to the top add button (HS-7600).
  d.push(delegate(container, 'click', '.detail-add-note-bottom-btn', (e) => {
    e.stopPropagation();
    byIdOrNull('detail-add-note-btn')?.click();
  }));

  // Draft entry — click reopens the feedback dialog with the saved draft.
  d.push(delegate<HTMLElement>(container, 'click', '.feedback-draft-entry', (_e, entry) => {
    if (currentNotesContext === null) return;
    const ctx = currentNotesContext;
    const draftId = entry.getAttribute('data-draft-id');
    const draft = (ticketDraftsCache.get(ctx.ticketId) ?? []).find(dr => dr.id === draftId);
    if (draft === undefined) return;
    const ticket = state.tickets.find(t => t.id === ctx.ticketId);
    const ticketNumber = ticket?.ticket_number ?? `#${ctx.ticketId}`;
    // HS-8836 — page through context relative to the draft's parent feedback note.
    const nav = draft.parentNoteId === null ? undefined : buildFeedbackNav(
      { ticketNumber: ticket?.ticket_number, ticketTitle: ticket?.title, detailsMarkdown: ticket?.details ?? '', notes: ctx.notes },
      draft.parentNoteId,
    );
    showFeedbackDialog(ctx.ticketId, ticketNumber, draft.promptText, toDraftSeed(draft), undefined, nav);
  }));
  d.push(delegate<HTMLElement>(container, 'contextmenu', '.feedback-draft-entry', (e, entry) => {
    openDraftDeleteMenu(e as MouseEvent, entry);
  }));

  // Regular note entry — click to edit, right-click to delete. Skips draft
  // entries (handled above) and clicks that landed on a nested interactive
  // element (reader / megaphone / feedback link / ticket-ref / the edit area
  // itself), mirroring the pre-fix per-button `stopPropagation` guards.
  d.push(delegate<HTMLElement>(container, 'click', '.note-entry', (e, entry) => {
    if (entry.classList.contains('feedback-draft-entry')) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.note-reader-btn, .note-megaphone-btn, .feedback-link, .ticket-ref, .note-edit-area, .note-actions') != null) return;
    if (entry.querySelector('.note-edit-area') !== null) return;
    const found = noteFor(entry);
    if (found === null) return;
    const textEl = entry.querySelector<HTMLElement>('.note-text');
    if (textEl === null) return;
    const textarea = toElement(<textarea className="note-edit-area" rows={3} spellcheck="true"></textarea>) as HTMLTextAreaElement;
    textarea.value = found.note.text;
    textEl.style.display = 'none';
    entry.appendChild(textarea);
    textarea.focus();
  }));
  d.push(delegate<HTMLElement>(container, 'contextmenu', '.note-entry', (e, entry) => {
    if (entry.classList.contains('feedback-draft-entry')) return;
    openNoteDeleteMenu(e as MouseEvent, entry);
  }));

  // Inline edit textarea — commit on blur (auto-promoted to capture by
  // `delegate`), Cmd/Ctrl+Enter saves, Escape cancels.
  d.push(delegate<HTMLTextAreaElement>(container, 'blur', '.note-edit-area', (_e, ta) => { void saveNoteEdit(ta); }));
  d.push(delegate<HTMLTextAreaElement>(container, 'keydown', '.note-edit-area', (e, ta) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) { e.preventDefault(); void saveNoteEdit(ta); }
    if (ke.key === 'Escape') { e.stopPropagation(); ta.blur(); }
  }));
}

/**
 * HS-8651 — commit the freshly-built note children into `#detail-notes` via
 * `morph()` (the HS-8613 delegation removed the per-note listeners that blocked
 * this; the listeners now live on the stable container, so morph can preserve /
 * reuse note-entry nodes without stranding stale closures).
 *
 * Why morph over `replaceChildren`: a tear-down-and-rebuild resets scroll
 * position + loses focus/caret on every re-render (note add / delete / detail
 * poll). morph reconciles in place, so the non-editing notes keep their scroll
 * and any focused element survives.
 *
 * Two things need handling that the plain reconcile would get wrong:
 *
 * 1. **Image-proxy mutations** (`proxyGitHubImages` rewrites `img.src`,
 *    `appendImageDownloadLinks` appends `<a>`s) are applied to the template
 *    entries BEFORE this runs (in `renderNotes`), so the template already
 *    carries the proxied DOM — morph reconciles proxied-against-proxied (an
 *    unchanged note is `isEqualNode`, a no-op) instead of reverting them.
 *
 * 2. **In-progress inline edits** — the edit click injects a `.note-edit-area`
 *    textarea + hides `.note-text`, neither of which is in the template. To
 *    PRESERVE an unsaved edit across an interleaving re-render (e.g. a detail
 *    poll), we mark the live entry `data-morph-skip` so morph leaves it (and
 *    its textarea) verbatim. The SAVE path is distinguished by the
 *    `data-committed='1'` flag the save handler sets on the textarea BEFORE
 *    calling `renderNotes`: a committed entry is NOT skipped, so morph rebuilds
 *    it into display mode with the new text (and the trailing-removal of the
 *    now-committed textarea fires the blur that the HS-8437 re-entrancy guard
 *    already handles). Keyed matching via `data-key` (note id) keeps the skip
 *    aligned with the right entry across concurrent add/delete.
 */
function commitNotesChildren(container: HTMLElement, children: Element[]): void {
  for (const entry of container.querySelectorAll<HTMLElement>('.note-entry')) {
    const ta = entry.querySelector<HTMLTextAreaElement>('.note-edit-area');
    if (ta !== null && ta.dataset.committed !== '1') entry.setAttribute('data-morph-skip', '');
    else entry.removeAttribute('data-morph-skip');
  }
  // Detached holder — morph is childrenOnly, so it reconciles `container`'s
  // children against this holder's children and never touches `container`
  // itself (its `id` / classes are safe). The holder's own tag is irrelevant.
  const template = toElement(<div></div>);
  template.append(...children);
  morph(container, template);
}

export function renderNotes(ticketId: number, notes: NoteEntry[]) {
  const container = byIdOrNull('detail-notes');
  if (!container) return;
  // HS-8613 — bind the delegated note/draft listeners once, and publish the
  // current ticketId + notes so those handlers act on the right data. The rows
  // built below carry NO per-element listeners (delegation reads identity from
  // `data-note-id` / `data-draft-id`).
  ensureNotesDelegationBound(container);
  currentNotesContext = { ticketId, notes };
  // HS-8036 — look up the current ticket so we can skip self-references
  // when linkifying ticket numbers in note bodies (a ticket viewing
  // itself with `HS-1234` in its own notes shouldn't render that as a
  // link).
  const currentTicketNumber = state.tickets.find(t => t.id === ticketId)?.ticket_number;
  // HS-8365 — accumulate every child element in an array, then commit via
  // `morph()` (HS-8651). morph reconciles in place so scroll / focus / caret on
  // the non-editing notes survive a re-render, and `commitNotesChildren`
  // preserves an in-progress inline edit. The image-proxy mutations below are
  // applied to the template entries BEFORE the commit, so morph keeps them.
  if (notes.length === 0) {
    commitNotesChildren(container, [toElement(<div className="notes-empty" data-key="empty">No notes added</div>)]);
    return;
  }

  const children: Element[] = [];

  // HS-9289 — the "Provide Feedback" link belongs on the last MEANINGFUL note, not
  // literally the last note: a trailing claim-reclaim system note must not steal
  // (hide) the link from a preceding FEEDBACK NEEDED note.
  const lastMeaningfulIdx = lastMeaningfulNoteIndex(notes.map(n => n.text));

  for (const note of notes) {
    const isEmpty = note.text.trim() === '';
    // HS-9289 — auto-generated status notes (claim-lease reclaim) render dimmed.
    const isSystem = isSystemStatusNote(note.text);
    // HS-8036 — wrap any ticket-number references (e.g. `HS-1234`) in
    // clickable anchors after `marked` produces the HTML. The
    // `linkifyWithCachedPrefixes` helper no-ops when the prefix cache
    // hasn't loaded yet (app boot race) — it'll re-render correctly
    // once the user mutates a note or re-opens the detail panel.
    const renderedText = isEmpty
      ? ''
      // HS-9539 — memoized: this runs per note on EVERY detail-panel render, and the
      // HS-9538 audit measured 89 % of those renders producing byte-identical output.
      : linkifyWithCachedPrefixes(parseMarkdownCached(note.text), currentTicketNumber);
    // HS-7601 — show the megaphone button when (a) this note isn't a
    // FEEDBACK NEEDED prompt (those are Claude → user, not user → Claude),
    // (b) the channel feature is enabled, and (c) the note has actual text
    // (no point sending an empty note as feedback).
    const feedbackPrefix = parseFeedbackPrefix(note.text);
    const showMegaphone = feedbackPrefix === null && !isEmpty && isChannelFeatureEnabled();
    // HS-7957 — show the book-open-text reader-mode button on every
    // non-empty note (regardless of channel state). Sits to the LEFT of the
    // megaphone in the timestamp row's right-side cluster, so the order is
    // [timestamp] ... [book] [megaphone?]. Empty notes get neither button.
    const showReader = !isEmpty;
    const showRightCluster = showReader || showMegaphone;
    // HS-8613 — the "Provide Feedback" link renders inline (was appended
    // imperatively post-build); the delegated `.feedback-link` handler
    // recovers the prompt + ticket number from the note at click time.
    const showFeedbackLink = lastMeaningfulIdx >= 0 && note === notes[lastMeaningfulIdx] && feedbackPrefix !== null;
    const entry = toElement(
      <div className={`note-entry${isEmpty ? ' note-empty' : ''}${isSystem ? ' note-system' : ''}`} data-note-id={note.id ?? ''} data-key={note.id ?? ''}>
        {note.created_at !== '' || showRightCluster
          ? <div className="note-timestamp-row">
              {note.created_at !== '' ? <span className="note-timestamp">{new Date(note.created_at).toLocaleString()}</span> : <span></span>}
              {showRightCluster
                ? <span className="note-actions">
                    {showReader
                      ? <button className="note-reader-btn" title="Open in reader mode" type="button" data-note-id={note.id ?? ''}>
                          {BOOK_READER_ICON}
                        </button>
                      : null}
                    {showMegaphone
                      ? <button className="note-megaphone-btn" title="Send this note to Claude via channel" type="button" data-note-id={note.id ?? ''}>
                          {MEGAPHONE_ICON}
                        </button>
                      : null}
                  </span>
                : null}
            </div>
          : null}
        <div className="note-text note-markdown">{
          isEmpty
            ? <span className="note-placeholder">Click to add a note...</span>
            // `renderedText` is sanitized markdown HTML from `marked.parse(...)` + `linkifyWithCachedPrefixes`.
            : trustedRaw(renderedText)
        }</div>
        {showFeedbackLink ? <button className="feedback-link">Provide Feedback</button> : null}
      </div>
    );

    // Rewrite GitHub image URLs to go through the server-side proxy so private
    // repo images render (the browser can't fetch them without the PAT).
    proxyGitHubImages(entry);

    // Add clickable download links for any images in the note.
    appendImageDownloadLinks(entry);

    children.push(entry);

    // HS-7599: render any feedback drafts whose `parent_note_id` matches
    // this note inline, immediately below the parent note. Free-floating
    // drafts (parent_note_id missing or no longer matching any note)
    // render at the end of the list — see the post-loop block.
    const drafts = ticketDraftsCache.get(ticketId) ?? [];
    for (const draft of drafts) {
      if (draft.parentNoteId === note.id) {
        children.push(buildDraftEntry(ticketId, draft, notes));
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
      children.push(buildDraftEntry(ticketId, draft, notes));
    }
  }

  // HS-7600: a second "Add note" button at the bottom of the notes list so
  // users who scrolled down to read existing notes don't have to scroll all
  // the way back up to add a new one. Hidden when the list is empty (the
  // top button is already in view + the empty-state row reads cleanly
  // without a duplicate action). Click forwards to the existing top button
  // so the add-note logic stays in one place.
  // HS-8613 — pure markup; the `.detail-add-note-bottom-btn` click is delegated
  // at the container (forwards to the top add button).
  children.push(toElement(
    <button className="detail-add-note-bottom-btn" title="Add note" data-key="add-note-bottom">
      {ADD_NOTE_PLUS_ICON}
      <span>Add note</span>
    </button>
  ));

  // HS-8651 — single commit via `morph()` (was `replaceChildren`). See
  // `commitNotesChildren` for the edit-preservation + image-proxy handling.
  commitNotesChildren(container, children);

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
function buildDraftEntry(ticketId: number, draft: FeedbackDraft, _notes: NoteEntry[]): HTMLElement {
  // HS-8613 — pure markup carrying `data-draft-id`; the click (reopen dialog)
  // and contextmenu (delete) are delegated at the `#detail-notes` container
  // (`.feedback-draft-entry` selectors), recovering the draft from the cache by
  // id. The `_notes` param is retained for the existing call-site signature.
  const previewText = draftPreviewText(draft);
  return toElement(
    // HS-8651 — `data-key` namespaced (`draft-…`) so morph never matches a draft
    // entry to a note-entry with a colliding id.
    <div className="note-entry feedback-draft-entry" data-draft-id={draft.id} data-key={`draft-${draft.id}`}>
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
  setTimeout(() => { btn.classList.remove('is-busy'); }, BUTTON_BUSY_MS);
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
  setTimeout(() => alert.remove(), TOAST_AUTOHIDE_MS);
  const notesContainer = byIdOrNull('detail-notes');
  if (notesContainer !== null) notesContainer.prepend(alert);
}
