# 21. Feedback Needed Notes

## Overview

AI tools and automated workflows can request user feedback by adding notes with special prefixes to tickets. When the user opens a ticket with pending feedback, a dialog prompts them to respond. This enables bidirectional communication between AI tools and users without requiring the AI to wait or poll.

## Functional Requirements

### 21.1 Feedback Note Prefixes

- Two phrases are recognized, checked only on the most recent note of a ticket:
  - `FEEDBACK NEEDED` — Standard feedback request. Shows dialog when the ticket is opened.
  - `IMMEDIATE FEEDBACK NEEDED` — Urgent request. Automatically selects the ticket (if the project tab is active) so the dialog appears immediately.
- The text after the phrase (a single leading colon + whitespace stripped) is the prompt displayed to the user. Any context the AI wrote *before* the phrase stays visible in the full note body in the detail panel but is not shown as the dialog prompt.
- **HS-8702 — relaxed matching.** The phrase is matched **anywhere** in the most recent note (not just as a strict leading prefix), and the trailing colon is **optional**. AIs don't always place the phrase at the very start of the note or include the colon, and the user still wants those treated as feedback prompts. Matching is **case-sensitive** (the all-caps phrase) so ordinary lowercase prose like "feedback needed from the user" never false-positives. The AI-facing instructions (worklist / skill / `hotsheet_request_feedback`) still tell AIs to use the leading `FEEDBACK NEEDED:` prefix — only the *read side* was loosened, so well-formatted notes are unaffected and mis-formatted ones still surface. The three detectors stay mirrored: `parseFeedbackPrefix` (`feedbackDialog.tsx`), `hasPendingFeedback` (`ticketRow.tsx`), and `notesEndWithFeedback` (`src/feedback-state.ts`).
- Once the user responds (or any new note is added), the feedback state clears because the new note becomes the most recent and doesn't contain the feedback phrase.

### 21.2 Feedback Dialog

- Appears automatically when a ticket with pending feedback is opened in the detail panel.
- Shows the prompt text rendered as markdown.
- Provides a **catch-all textarea** at the bottom for a free-form reply, plus **inline response textareas** the user can insert between any two prompt blocks (see §21.2.1 for the click-to-insert layout).
- Supports file attachments (same pattern as the Not Working dialog).
- Action buttons (left to right):
  - **Later** (left side, styled as a muted link): Dismisses the dialog without action. The feedback state persists — the dialog will reappear next time the ticket is opened.
  - **Save Draft** (right side, HS-7599): Persists the in-progress response to the `feedback_drafts` table without sending it. The saved draft renders as a card in the notes list and can be re-opened later. See §21.2.3.
  - **No Response Needed** (right side): Adds a note with text `NO RESPONSE NEEDED`, clearing the feedback state.
  - **Submit** (right side, primary): Creates a new note with the response text, uploads attachments, and notifies the Claude Channel (if connected) that feedback was provided. If the dialog was reopened from a saved draft, the draft is deleted on successful submit. **HS-9207** — on submit the dialog also calls `refreshDetail()` so the new response note renders in the open detail panel immediately; previously it only re-rendered the ticket *list* (`loadTickets`) and relied on a later `/ws/sync` `detail` push or poll to refresh the panel, so the response "sometimes" didn't appear until the user switched tickets and back.
- Click-outside-overlay dismisses the dialog ONLY when the dialog has no text in any input (per HS-7599). When any text is present, the click is ignored — the user can still close explicitly via × / Later / Esc / Save Draft.
- **× close-guard (HS-9180).** Pressing the × with unsaved text no longer drops it silently. It opens a three-way prompt (`choiceDialog`, the sibling of `confirmDialog`) — **Save Draft** (persists via the existing draft path, then closes), **Discard** (closes, losing the text — the destructive/red action), or **Keep Editing** (the safe default: Esc + backdrop-click both resolve here, so an accidental open never loses work). With no text the × closes immediately. (Scoped to the × per the ticket; **Later** still closes directly — it's a deliberate "remind me later" defer.)
- The dialog only auto-shows once per detail-panel open (tracked by note ID) to avoid re-opening on every poll refresh.
- **Auto-show never fires over an already-open dialog (HS-8644).** `showFeedbackDialog` removes + recreates the `.feedback-dialog-overlay`, so an auto-show re-firing while the user is mid-typing destroyed their input — the reported data-loss bug. `shouldAutoShowFeedback` now bails whenever a `.feedback-dialog-overlay` is present. This is the robust guard; the note-ID key alone wasn't enough because an unsaved note's client id was regenerated on each `parseNotesJson` pass, so the key drifted poll-to-poll for an id-less FEEDBACK NEEDED note and the per-key one-shot never caught it. **HS-8645** then made that fallback id deterministic (`deterministicNoteId(index, text, created_at)` — a djb2 content hash + array index — so the same id-less note yields the same id across re-parses), removing the drift at its source; the overlay guard stays as the catch-all against any other re-render path. Manual re-open (a user click) is a separate, intentional path that doesn't route through `shouldAutoShowFeedback`.
- **Auto-show prefers a saved draft (HS-7822).** When the latest note is a FEEDBACK NEEDED request AND a saved draft exists for it, the auto-show opens the dialog with the draft pre-loaded — same form the user gets from clicking the inline draft entry — instead of the bare original prompt. Selection order: a draft whose `parentNoteId` matches the active feedback note wins; otherwise the most recently updated free-floating draft (per §21.2.3) is used; otherwise the bare prompt. The fix is the `pickDraftForFeedbackNote` pure helper in `feedbackDialog.tsx` plus an `await` on the `/feedback-drafts` fetch in `detail.tsx` before deciding which form to show. Pre-fix, the drafts fetch was fire-and-forget so on relaunch the user always saw the original form even when their work was in the database.
- **Clicking "Provide Feedback" also loads the draft (HS-8603).** The HS-7822 fix only covered the *auto-show* on detail-panel open. The explicit **click** affordances — the ticket context-menu "Provide Feedback" item AND the inline "Provide Feedback" link under a FEEDBACK NEEDED note — were still opening a blank form, which spawned a second competing draft for the same note. Both now route through `openFeedbackDialogForNote(ticketId, ticketNumber, prompt, noteId)` (`feedbackDialog.tsx`): it fetches the ticket's `/feedback-drafts` fresh (the context-menu click can fire from the ticket list before the detail panel loaded them), runs the same `pickDraftForFeedbackNote` selection, and seeds the dialog via the canonical `toDraftSeed` mapper — falling back to the bare prompt when there's no draft / no note id / the fetch fails. `toDraftSeed` is now the single source of the `FeedbackDraft → FeedbackDraftSeed` mapping, also used by the draft-card click and the detail-panel auto-show.

### 21.2.1 Click-to-insert inline responses (HS-6998)

AI-generated feedback prompts are unpredictable — sometimes a neat numbered list of independent questions, sometimes a paragraph ending in "which of A/B/C/D/E should I do?" where the letters are **options**, not parts. An earlier version of this dialog tried to auto-detect the question list and render a textarea next to each item, but it got the shape wrong on mixed prompts where the list was an options menu. This version **doesn't try to guess**: the user chooses where to put their answers.

**Layout** — the prompt is split into top-level markdown blocks (paragraphs, lists, headings, code blocks, ...) via `parseFeedbackBlocks` in `src/client/feedbackParser.ts`. Each block is rendered as an accent-bordered pill. Between every pair of blocks, and after the last block, a full-width insert-response affordance sits in a `.feedback-insert-slot`: by default it shows only a muted `+` glyph on the left so the stack stays visually quiet, and on hover the glyph brightens and " Add response here" reveals next to it. The click target is the full width of the dialog (minus the block's horizontal padding), so the user can click anywhere in the gap between two blocks to open an inline textarea at that exact position. A catch-all textarea always sits at the bottom — when the prompt is a single-question paragraph, that's the only input the user needs.

**Inserting responses** — clicking an insert slot creates a new inline response block (`<div class="feedback-inline-response">`) containing a textarea and a small `×` remove button. Focus jumps to the new textarea immediately. Multiple inline responses may be added to the same slot; they're emitted in insertion order. The insert button stays visible after insertion so users can add more.

**Submit — catch-all only** — when the user fills in only the bottom catch-all textarea (no inline responses), the note body is that catch-all text verbatim. No quoting, no restating of the prompt — just the user's reply. This is the common case for short, simple prompts.

**Submit — with inline responses** — when any inline response has non-empty text, `combineQuotedResponse(blocks, inlineResponses, catchAll)` re-emits the **whole prompt** as markdown blockquotes (`> ...` on every line of every block) with the user's inline responses interleaved un-quoted in the correct slots, and the catch-all (if any) appended un-quoted at the end. The reader — human or AI — sees the original question text right next to each answer, without needing to open the original feedback note.

**Empty inline responses** — inline textareas whose text is empty or whitespace-only are dropped from the output rather than included as placeholders. Empty text-areas are noise — the user clicked `+ Add response` then changed their mind. They don't need to be called out.

**Submission gates** — if neither any inline textarea nor the catch-all contains text, submission is blocked and focus returns to the catch-all (or the first inline textarea if one exists). Attachments may still be submitted alone with no note body.

**Focus** — on dialog open, focus the catch-all. Once the user clicks `+ Add response`, focus jumps to the newly inserted inline textarea.

**Edge cases:**
- Empty prompt — no blocks are rendered; only the catch-all textarea is shown. The `+ Add response` affordance is absent (there's nothing to insert between).
- Prompts with only one block — a single `+ Add response` slot appears after the block, plus the catch-all. Equivalent to the single-textarea flow most of the time.
- Lists — see §21.2.2. As of HS-7930 every top-level list is unconditionally split into one block per item, so every gap (between paragraphs, between list items, between headings) is a potential insertion point. The dialog's hover-only indicator (§21.2.3) keeps the visual cost zero for prompts the user doesn't intend to insert into.
- Code blocks, headings, blockquotes — each is a distinct block and can have its own inline response.

### 21.2.3 Save Draft + don't-close-on-clickaway (HS-7599)

When a feedback prompt has multiple parts or the user wants to step away mid-response, they need a way to save in-progress state without sending an incomplete answer. HS-7599 adds two related changes to the dialog:

**Don't-close-on-clickaway threshold.** Click-outside-the-dialog dismissal is now gated on whether ANY input contains text. Catch-all OR any inline-response textarea counts. The threshold is "any text entered at all" — not "text changed from initial state" — because none of the dialog's inputs are pre-filled with quoted prompt text, so a populated input always represents user-typed content. The user can still close explicitly via the × close button, the **Later** link, the **Esc** key, or the new **Save Draft** button. Rationale: stray clicks on the backdrop while typing a long response shouldn't lose the user's work.

**Save Draft button.** A new button sits in the action row (between **Later** on the left and **No Response Needed** + **Submit** on the right). On click, the dialog persists the current input state to the `feedback_drafts` table and closes. The button is enabled only when the dialog has any non-whitespace text in the catch-all or any inline response — consistent with the click-away gate, and prevents the user from creating empty drafts by accident. The dialog re-uses the form's existing collection logic; nothing about the prompt-block layout changes.

**Click-to-reopen.** Each draft renders in the notes list as a small dashed-bordered card with a **Draft** badge, the saved updated_at timestamp, and a one-line preview (the first ~80 chars of the saved catch-all + non-empty inline responses joined by `/`). Click reopens the same feedback dialog with the draft's saved partition structure restored verbatim — inline responses are pre-inserted at their original `blockIndex` slots, and the catch-all is pre-filled. Right-click on the card opens a "Delete Draft" context menu.

**Saved partition structure is authoritative.** When a draft is re-opened, the dialog uses the saved `blocks` array from the draft (NOT a fresh `parseFeedbackBlocks` call against the original prompt text). This is load-bearing: if `parseFeedbackBlocks`'s heuristic changes between save and reopen (e.g. a future tweak to the §21.2.2 list-split rule, or a new heuristic added entirely), the user's draft must continue to render in the structure they originally saw — otherwise their inline responses might land in the wrong places, or the layout could shift entirely. The original prompt text is also snapshotted alongside the partitions so the dialog header + block content can be reconstructed even after the parent FEEDBACK NEEDED note is deleted.

**Inline placement vs free-floating.** A draft's `parent_note_id` is the FEEDBACK NEEDED note that prompted it. When that note still exists, the draft renders immediately below it in the notes list (so a draft visually pairs with its source). When the parent note has been deleted (or was never set, e.g. the user manually opened the feedback dialog from a non-prefixed note via the "Provide Feedback" link path), the draft renders at the BOTTOM of the notes list, after every regular note, in created-at order. Either way, drafts intersperse cleanly with regular notes — adding a new note after a draft does NOT make the draft disappear; the renderer walks notes-then-drafts deterministically on every render.

**Lifecycle.** Drafts persist as free-floating entries when their parent FEEDBACK NEEDED note is deleted or its prefix is cleared by Claude responding. The `parent_note_id` foreign-key relationship is to a JSON-array element ID inside `tickets.notes`, which has no DB-level constraint — the renderer just falls through to the free-floating path when the saved `parent_note_id` doesn't appear in the current notes list. Submitting a draft via the Submit button (with non-empty content) deletes the draft and adds the new note. The cascading delete on `tickets.id` is the only DB-level cleanup: when the entire ticket is hard-deleted, all its drafts go with it.

**Persistence — separate table, not in `tickets.notes`.** Drafts live in a new `feedback_drafts` table (`id TEXT PK`, `ticket_id INTEGER FK ON DELETE CASCADE`, `parent_note_id TEXT NULLABLE`, `prompt_text TEXT`, `partitions_json TEXT`, `created_at`, `updated_at`). Local-only, NOT replicated through any plugin sync engine — drafts are private working state, not first-class ticket history that other backends should see. The `id` is generated client-side as `fd_<base36-time>_<base36-rand>` so the dialog can persist + render optimistically without waiting for a round-trip.

**API.** Four routes under `/api/tickets/:id/feedback-drafts`:
- `GET` — list every draft for the ticket in created-at order.
- `POST` body `{id, parent_note_id, prompt_text, partitions}` — create.
- `PATCH /:draftId` body `{partitions}` — update only the partitions field.
- `DELETE /:draftId` — remove.

The `partitions` JSON shape is `{blocks: [{markdown, html}], inlineResponses: [{blockIndex, text}], catchAll: string}` — mirrors the dialog's working state so a saved draft round-trips back to the same UI on reopen.

**Implementation.** Server: `src/db/feedbackDrafts.ts` (CRUD + the `FeedbackDraft` shape), four routes in `src/routes/tickets.ts`, schemas in `src/routes/validation.ts`, table DDL in `src/db/connection.ts`. Client: `src/client/feedbackDialog.tsx` extends `showFeedbackDialog()` with an optional `draftSeed` parameter for the reopen path + a Save Draft handler that POSTs (new) or PATCHes (existing seed) the dialog's collected partitions; it also exports `toDraftSeed(draft)` (canonical `FeedbackDraft → FeedbackDraftSeed` mapping) and `openFeedbackDialogForNote(...)` (HS-8603 — the shared click entry point that loads the draft before showing the dialog). `src/client/noteRenderer.tsx` exposes `setTicketDrafts(ticketId, drafts)` + `getTicketDrafts(ticketId)` accessors and renders draft cards inline; `src/client/detail.tsx` GETs `/feedback-drafts` on detail-panel-open and re-renders the notes list with drafts populated.

**Tests.** 7 unit tests in `src/db/feedbackDrafts.test.ts` cover CRUD round-trips, partition idempotency, listing order, free-floating drafts, missing-id PATCH returns null, and FK CASCADE on parent ticket delete. e2e tests in `e2e/feedback-drafts.spec.ts` cover empty-input click-away closes the dialog, populated-input click-away keeps it open, Save Draft persists + renders inline, and click-to-reopen restores the catch-all + Submit deletes the draft. **HS-9180** adds: the × with unsaved text opens the Save Draft / Discard / Keep Editing guard (Discard + Keep-Editing + Save-Draft paths), and the × with no text closes immediately; `choiceDialog`'s 7 unit tests live in `src/client/confirm.test.ts` (each button + Esc/Enter/backdrop).

**Draft-scoped attachments (HS-8428, 2026-05-18).** Pre-fix the Save Draft handler dropped attached files silently — only Submit's per-file `apiUpload('/tickets/:id/attachments', file)` loop persisted them. With many feedback flows being "screenshot + describe", that meant the user lost their screenshots whenever they hit Save Draft instead of Submit. Fix: a new nullable `attachments.draft_id` column lets the server track in-flight feedback-dialog attachments separately from real ticket attachments. The dialog generates a stable `sessionDraftId` at open time (reusing the draft's id when reopening) and uploads on file-select to `POST /api/tickets/:id/feedback-drafts/:draftId/attachments`. Save Draft becomes a pure text save; the attachments are already linked. Submit promotes the whole batch atomically via `POST /api/tickets/:id/feedback-drafts/:draftId/promote-attachments` (single `UPDATE … SET draft_id = NULL`) before the note PATCH. Discard (× / Later / outside-click-when-no-text-or-attachments) hits `DELETE /api/tickets/:id/feedback-drafts/:draftId`, which cascades to draft attachments AND their files on disk; the DELETE handler tolerates a missing draft row so the client can fire it even when Save Draft was never clicked. `getAttachments(ticketId)` filters `WHERE draft_id IS NULL` so draft-scoped attachments don't leak into the ticket's main attachment list / count. GET `/feedback-drafts` hydrates each draft with its attachments so a reopen pre-populates the file list. Save Draft also now proceeds with no text when attachments exist (the attachments are themselves draft state worth preserving). Cleanup sweep (`src/cleanup.ts`) GCs orphan rows older than 7 days whose `draft_id` no longer matches any `feedback_drafts` row (backstop for crashed tabs that miss the client-side cleanup). Schema bump: `SCHEMA_VERSION` in `src/db/connection.ts` (was `2` at the time of this change; the constant has since advanced — see the current value in code). Tests: 7 unit cases in `src/db/queries.test.ts` (`addDraftAttachment` / `getDraftAttachments` / `promoteDraftAttachments` / `deleteDraftAttachments` / isolation across tickets / `listOrphanDraftAttachments` horizon + draft-still-exists exclude) + 2 cleanup-sweep cases in `src/cleanup.test.ts` (7-day orphan reap + live-draft skip).

### 21.2.2 Uniform always-split insertion points (HS-7930, supersedes the HS-7558 heuristic)

HS-7558 introduced a per-list **heuristic** that decided whether to split a list into per-item blocks based on whether it "looked like a question set" (first-block rule + every-item-ends-in-punctuation rule). The heuristic was right often enough to be useful but wrong often enough that the user reported it: option menus that ended in punctuation got over-split, mid-prompt question lists that didn't all end in `?` got under-split, and the user's intent didn't always match the markdown shape.

HS-7930 throws the heuristic out and goes uniform: **every top-level list is always split into one block per item.** That gives the user a click-to-add-response point between every list item, every paragraph, every heading. The visual cost (more potential insertion points) is offset by §21.2.3's hover-only affordance — the dialog hides every insert indicator until the user hovers the gap, so a prompt the user doesn't intend to insert into is visually identical to a single rendered markdown block.

Examples (post-HS-7930):

- `- foo / - bar / - baz` mid-prompt → 3 blocks (one per item).
- `1. Question A? / 2. Question B! / 3. Question C.` → 3 blocks.
- `Pick one: / - option A / - option B / - option C` → 4 blocks (intro + 3 items).
- `Outline: / - First section name? / - Second section name / - Third question?` → 4 blocks.

**Sub-bullets stay with their parent.** When a list item has sub-bullets nested under it, the parent + its sub-bullets stay in ONE block — sub-bullets are typically clarifications of the question, not separate questions. Example: `1. Top question? — sub a — sub b — 2. Plain question?` produces 2 blocks (block 0 contains the parent + both sub-bullets, block 1 contains the second top-level question).

**Backward compat for saved drafts.** A saved feedback draft snapshots its `partitions.blocks` array verbatim. Drafts saved against the HS-7558 heuristic stay grouped the way they were saved; drafts saved against HS-7930 always-split slot in transparently. The §21.2.3 "saved partition structure is authoritative" rule covers both shapes — `blockIndex` is just an integer index into whatever the draft's own array shape is.

**Implementation.** `parseFeedbackBlocks` lost its `shouldSplitListIntoItems` heuristic and now unconditionally splits every top-level list into one block per item. `combineQuotedResponse` is unchanged. Tests in `feedbackParser.test.ts` were renamed + updated to reflect the always-split behavior; the heuristic-specific cases that used to assert "stays grouped" now assert "splits per item."

### 21.2.3 Hover-only insert indicator (HS-7930)

The HS-6998 v1 / HS-7558 dialog rendered a visible `+ Add response here` button beneath every block, pulling the eye to insertion affordances even on prompts the user intended to answer with a single catch-all reply. HS-7930 makes the affordance hover-only.

**Iteration 1.** The first pass reduced the button to a hover-fade — at rest, a 14 px gap with the label hidden; on hover, a thin 1 px bar plus the "+ Add response here" label faded in. The user reported (a) the label stuck around after the cursor left and (b) the visible 14 px gap looked like blank padding when no insertion was intended.

**Iteration 2 (current).** The dialog now collapses the gap to a 6 px zero-content hover zone with NO button text or icon at all. On hover the slot lights a 2 px accent-colored bar (drop-target style) marking the exact split point a click would target. Cursor stays pointer. The whole affordance disappears the moment the cursor leaves — there's no labeled button to linger.

- `.feedback-insert-slot { min-height: 6px; padding: 0; }` — invisible at rest, clickable everywhere in the gap.
- `.feedback-insert-slot::before` — 2 px solid `#3b82f6` bar, `opacity: 0` at rest, `opacity: 1` on `:hover`, 100 ms transition.
- `.feedback-insert-btn` — kept in the JSX for backwards-compat with HS-7558 callers but `display: none`. The slot itself is the click target.
- One response per slot. Once a textarea is inserted, `:has(.feedback-inline-response)` hides the bar so the gap doesn't double-up; clicking the textarea's `×` button removes the textarea and restores the click-to-add affordance.

The implementation lives entirely in `src/client/styles.scss` (`.feedback-insert-slot` rules) + the slot-level click listener in `feedbackDialog.tsx`.

### 21.2.4 Prev/next context navigation + reader-button routing (HS-8836)

When composing a response, the user often needs to re-read earlier notes or the ticket description for context — without losing their in-progress answer. The feedback dialog gains the same **prev/next chevron navigation** the §49 reader overlay uses, plus the per-note reader button now routes unanswered feedback notes here.

**Prev/next navigation (Option 1 — pinned response, navigable context).** When there's prior context to page to (any earlier non-empty note, or non-empty Details), the dialog header renders ▲/▼ chevrons (`.feedback-nav-prev` / `.feedback-nav-next`, the same Lucide glyphs as the reader). They page a read-only view through the ticket's combined **[Details + notes]** list — the exact list `buildCombinedReaderEntries` (`readerOverlay.tsx`) builds for the reader, so the two surfaces stay identical. The dialog opens anchored on the feedback note's entry, showing the interactive prompt-stack. Paging back swaps in a read-only `.feedback-context-view` (rendered via the reader's `renderReaderBodyHtml`) with a `.feedback-nav-caption` showing the entry title, and **hides** the prompt-stack; paging forward to the feedback entry restores it. Crucially, the response box, attachments, and action buttons stay **pinned below at all times** — they're never rebuilt — so the catch-all text, any inserted inline responses, and pending attachments survive navigation intact. Keyboard ↑/↓ also navigate, but only when focus is **not** in a textarea/input/contenteditable, so typing a response keeps normal cursor motion. The chevrons are omitted entirely when the feedback note is the only entry (nothing to page to). The nav is built by the exported `buildFeedbackNav(input, activeNoteId)` helper and passed through `showFeedbackDialog(..., nav?)` / `openFeedbackDialogForNote(..., nav?)`; every entry point (auto-show in `detail.tsx`, the inline "Provide Feedback" link + draft-card reopen in `noteRenderer.tsx`, and the context-menu item in `contextMenu.tsx`) supplies it, so the arrows appear regardless of how the dialog was opened.

**Reader-button routing.** The per-note 📖 reader button (`.note-reader-btn`, §49) on a note that is the **active, unanswered** FEEDBACK NEEDED note (i.e. `getTicketFeedbackState` returns it — it's still the most recent note, so no response or "No Response Needed" has been added) now opens the **feedback dialog** (with the nav above) instead of the read-only reader overlay. Once any later note answers it, `getTicketFeedbackState` returns null and the button falls through to the normal reader overlay. Every other note's reader button is unchanged.

**Tests.** Unit (`feedbackDialog.test.ts`): `buildFeedbackNav` entry-building (undefined when nothing prior; [Details + notes] anchored on the feedback note; empty notes skipped) + `buildOverlay` chevron/context-view rendering under `showNav`. E2E (`feedback-drafts.spec.ts`): paging back shows the earlier note read-only while the pinned response box keeps its typed text, paging forward restores the prompt; and the reader button on the unanswered feedback note opens the feedback dialog (not the reader overlay) while an earlier note's reader button still opens the reader. The E2E surfaced a real CSS bug — the prompt-stack's explicit `display: flex` overrode the `[hidden]` attribute — fixed with a `.feedback-prompt-stack[hidden] { display: none }` rule.

### 21.3 Provide Feedback Link

- In the detail panel, below notes that have a feedback prefix (when that note is the most recent), a "Provide Feedback" link button appears.
- Clicking it re-opens the feedback dialog, in case the user dismissed it earlier.
- **HS-8339** — the same affordance also appears as the **first item** in the ticket right-click context menu (`showTicketContextMenu` in `src/client/contextMenu.tsx`) whenever the ticket is the sole selection AND `hasPendingFeedback(ticket)` returns true. A megaphone icon anchors the item; clicking it parses the latest note via `parseNotesJson` + `getTicketFeedbackState` and calls `showFeedbackDialog(ticket.id, ticket.ticket_number, feedback.prompt, undefined, feedback.noteId)` — exactly the same entry point the inline detail-panel link uses, so saved-draft pickup and channel notification on submit behave identically. The item is intentionally rendered without a trailing separator so the existing separator-count-indexed insertion logic for the Push-to-backend submenu stays balanced.

### 21.3.1 Clickable ticket references inside the dialog (HS-8338)

The feedback dialog renders two places where `HS-NNNN`-style ticket references can appear, and both are wired through the §55 ticket cross-reference machinery so a click opens a stacked reference dialog on top of the feedback dialog (the user doesn't lose their in-progress response):

1. **Dialog title.** The header reads `Feedback Needed — HS-9001`; HS-8338 wraps the ticket number in `<a class="ticket-ref" data-ticket-number="HS-9001">HS-9001</a>` so clicking the number opens the originating ticket's reference dialog. This is the headline affordance — the user often wants to glance at the original ticket (title, status, recent notes) while composing a response without dismissing the dialog.
2. **Prompt body blocks.** Each rendered block's HTML is passed through `linkifyWithCachedPrefixes(block.html)` (from `src/client/ticketRefs.ts`) before being injected via `raw(...)`. Every `HS-NNNN` match (or any other prefix the project has registered) becomes a clickable anchor. Self-references are deliberately NOT skipped here — passing `undefined` for the `currentTicketNumber` argument; the user explicitly asked for "see the original ticket for reference" even when the prompt mentions the host ticket's own number.

The reference dialog is appended to `document.body` at `z-index: 2600 + stackIndex * 2`, well above the feedback dialog's `z-index: 2500`. Clicks on the reference dialog's backdrop / close button call `stopPropagation()` so they don't bubble to the feedback overlay's click-outside-to-dismiss handler, and the reference dialog's capture-phase Esc handler pops only the top of the reference stack — pressing Esc with both up dismisses the reference first, then a second Esc reaches the feedback dialog's normal Esc-blur handling. Stacking depth matches the §55 30 px transform offset so a chain of refs reads as a fan.

Implementation lives in `buildOverlay(ticketNumber, blocks)` inside `src/client/feedbackDialog.tsx` (exported for unit tests). Five unit tests in `feedbackDialog.test.ts` under the `buildOverlay ticket-ref linkification (HS-8338)` describe block cover: header anchor + dataset wiring, label-prefix preservation, body-block linkification across multiple matches, self-reference is NOT skipped, and the empty-prompt placeholder has no ticket-ref anchors.

### 21.4 Immediate Feedback Auto-Select

- When `IMMEDIATE FEEDBACK NEEDED:` is detected on any ticket during the poll cycle, the ticket is automatically selected (if no other ticket is currently selected).
- This does NOT switch project tabs — it only applies to the currently active project.
- The auto-select triggers `syncDetailPanel()`, which loads the detail and auto-shows the feedback dialog.

### 21.5 Ticket Indicator Dot

- Tickets with pending feedback (last note has a feedback prefix) show a purple dot (`#8b5cf6`) in both list view and column view.
- The purple feedback dot takes priority over the blue unread dot — if a ticket is both unread and has pending feedback, only the purple dot is shown.

### 21.6 Project Tab Indicator

- When any ticket in a project has pending feedback, a purple dot appears on the project tab.
- The dot clears when all feedback notes in the project are resolved (responded to, or "No Response Needed" added).
- Priority order for tab dots: feedback (purple) > permissions attention (blue) > channel busy (yellow).
- **HS-8378** — cross-project visibility: the dot reflects EVERY registered project's state, not just the active one. The active project is still updated inline by `feedbackDialog.checkFeedbackState()` from `state.tickets` so the dot appears/clears immediately on submit / "No Response Needed". Every OTHER project's state is bulk-refreshed from the server-side aggregator `GET /api/projects/feedback-state` on every poll-version bump (wired in `src/client/poll.tsx` via `refreshProjectFeedbackState()` in `src/client/projectTabs.tsx`). The server-side check (`projectHasPendingFeedback(db)` in `src/feedback-state.ts`) uses a SQL `LIKE '%FEEDBACK NEEDED%'` pre-filter (HS-8702 — colon dropped; `IMMEDIATE FEEDBACK NEEDED` is a superset so one clause covers both) to narrow the JSON-parse loop to tickets whose notes column literally contains the phrase somewhere, then JSON-parses each candidate and confirms the phrase appears on the LAST note (matching the client-side `hasPendingFeedback(ticket)` semantics in `ticketRow.tsx`). Pre-fix, `feedbackSecrets` was only ever populated for the active project, so a `FEEDBACK NEEDED` note in any non-active project was invisible on its tab until the user switched into it.
- **HS-8381** — backlog + archive exclusion: the project-tab dot only fires for tickets in actionable buckets. `projectHasPendingFeedback`'s SQL filter is `status NOT IN ('deleted', 'backlog', 'archive')` (pre-fix it only excluded `deleted`), and the inline client path in `checkFeedbackState` skips backlog / archive / deleted tickets before consulting `getTicketFeedbackState`. Rationale: a user moving a ticket to backlog or archive has explicitly set it aside; the purple dot is meant to flag prompts the user still needs to answer, and a stale `FEEDBACK NEEDED:` left on a deferred ticket shouldn't pull attention back to the project. The detail-panel inline "Provide Feedback" link + the megaphone affordances on individual notes still work on backlog / archive tickets — only the cross-project dot defers. **Tests:** 6 new DB-level tests in `src/feedback-state.test.ts`'s `projectHasPendingFeedback (HS-8381 — bucket exclusions)` describe block cover the active / backlog / archive / deleted / mixed / no-notes paths.

### 21.7 Channel Notification

- When the user submits feedback and the Claude Channel is alive, `triggerChannelAndMarkBusy` is called with a message: `"Feedback was provided on ticket {ticketNumber}. Please re-read the worklist and continue work on this ticket."`
- This re-triggers the AI to process the updated ticket.
- HS-7601 follow-up: when channel comm fails (channel feature disabled, Claude not connected, or any thrown error), a `.note-megaphone-warning` toast is prepended to `#detail-notes` with a specific reason. The feedback note itself was already saved — the warning just flags that Claude wasn't notified, so the user can launch Claude or otherwise re-trigger manually. Auto-dismisses after 6 s. Mirrors the warning shape used by the unsolicited-feedback megaphone (§21.10) so the two paths read consistently.

### 21.10 Unsolicited Feedback Megaphone (HS-7601)

Sometimes the user wants to flag a comment to Claude proactively, without waiting for Claude to ask via FEEDBACK NEEDED. HS-7601 adds a small **megaphone** button to each note in the detail panel that, on click, sends the note's text to Claude via the channel as if it were unsolicited feedback.

**Where it appears.** On every note's top row, right-aligned alongside the timestamp. Hidden when:
- The channel feature is disabled (`isChannelEnabled() === false`).
- The note has a `FEEDBACK NEEDED:` or `IMMEDIATE FEEDBACK NEEDED:` prefix — those are Claude → user requests, not user → Claude proactive comments. The user responds via the existing feedback dialog.
- The note is empty (`text.trim() === ''`) — there's nothing to send.

**Click behavior.**
1. Verify channel is enabled — if not, show a `.note-megaphone-warning` toast: "Channel feature not enabled in Settings → Experimental." Don't proceed.
2. Verify channel is alive (Claude is connected) — if not, show "Claude is not connected. Launch Claude Code with channel support first." Don't proceed.
3. Otherwise, fire `triggerChannelAndMarkBusy(framedMessage)` where `framedMessage` mirrors the §21.7 wording but adds the note text + ticket context as an anchor: `"An unsolicited comment was added to ticket {ticketNumber} ({ticketTitle}). Please re-read the worklist and continue work on this ticket. The user's comment was:\n\n{noteText}"`.
4. Toggle the button into a busy state (`is-busy` class — accent-tinted background + subtle pulse animation) for ~2 s, then auto-clear.

**Visual.** Lucide `megaphone` icon (24 × 24 viewBox, 14 × 14 rendered), tight 22 × 22 px pill button. Resting state is muted; hover lifts to the accent color with an accent-tinted background.

**Implementation.** `src/client/noteRenderer.tsx` adds the button to the existing note-entry render in `renderNotes()`, wired to `onMegaphoneClick(btn, ticketId, noteText)` which performs the channel-send + busy-state dance. `showMegaphoneWarning(message)` builds the toast inside `#detail-notes` (auto-dismiss after 6 s, manual `×` close also wired). `isChannelFeatureEnabled()` is a thin wrapper around `isChannelEnabled()` from `experimentalSettings.tsx`. The §21.7 `notifyChannel` path was extended to use the same warning shape, so feedback Submit and the megaphone send share the same failure UX. Regression test (`e2e/detail.spec.ts` "megaphone button hidden when channel feature is disabled (HS-7601)") asserts the button is absent when the channel feature is off (the default test config); the channel-on positive path is exercised manually since flipping `setChannelEnabledState` from a Playwright page evaluate is fragile.

### 21.8 AI Tool Integration

- The worklist.md includes a "Requesting User Feedback" section with curl examples for both standard and immediate feedback.
- AI tool skill version is bumped so the skills regenerate with the new instructions.
- AI tools add feedback notes via the standard `PATCH /api/tickets/{id}` endpoint with `{"notes": "FEEDBACK NEEDED: ..."}`.

## Non-Functional Requirements

### 21.9 Implementation

- Core module: `src/client/feedbackDialog.tsx` — prefix parsing, dialog rendering, click-to-insert wiring, channel notification
- Prompt splitter (HS-6998): `src/client/feedbackParser.ts` — `parseFeedbackBlocks` + `combineQuotedResponse`, covered by unit tests in `feedbackParser.test.ts`
- Note rendering: `src/client/noteRenderer.tsx` — "Provide Feedback" link
- Detail panel: `src/client/detail.tsx` — auto-show on ticket open
- Poll: `src/client/poll.tsx` — IMMEDIATE auto-select, feedback state scanning
- Project tabs: `src/client/projectTabs.tsx` — blue dot state management
- Worklist: `src/sync/markdown.ts` — AI instructions
- DB: `last_read_at` column (unrelated to feedback but enables unread detection)
