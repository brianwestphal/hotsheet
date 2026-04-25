# 21. Feedback Needed Notes

## Overview

AI tools and automated workflows can request user feedback by adding notes with special prefixes to tickets. When the user opens a ticket with pending feedback, a dialog prompts them to respond. This enables bidirectional communication between AI tools and users without requiring the AI to wait or poll.

## Functional Requirements

### 21.1 Feedback Note Prefixes

- Two prefixes are supported, checked only on the most recent note of a ticket:
  - `FEEDBACK NEEDED:` — Standard feedback request. Shows dialog when the ticket is opened.
  - `IMMEDIATE FEEDBACK NEEDED:` — Urgent request. Automatically selects the ticket (if the project tab is active) so the dialog appears immediately.
- The text after the prefix is the prompt displayed to the user.
- Once the user responds (or any new note is added), the feedback state clears because the new note becomes the most recent and doesn't have a feedback prefix.

### 21.2 Feedback Dialog

- Appears automatically when a ticket with pending feedback is opened in the detail panel.
- Shows the prompt text rendered as markdown.
- Provides a **catch-all textarea** at the bottom for a free-form reply, plus **inline response textareas** the user can insert between any two prompt blocks (see §21.2.1 for the click-to-insert layout).
- Supports file attachments (same pattern as the Not Working dialog).
- Action buttons (left to right):
  - **Later** (left side, styled as a muted link): Dismisses the dialog without action. The feedback state persists — the dialog will reappear next time the ticket is opened.
  - **Save Draft** (right side, HS-7599): Persists the in-progress response to the `feedback_drafts` table without sending it. The saved draft renders as a card in the notes list and can be re-opened later. See §21.2.3.
  - **No Response Needed** (right side): Adds a note with text `NO RESPONSE NEEDED`, clearing the feedback state.
  - **Submit** (right side, primary): Creates a new note with the response text, uploads attachments, and notifies the Claude Channel (if connected) that feedback was provided. If the dialog was reopened from a saved draft, the draft is deleted on successful submit.
- Click-outside-overlay dismisses the dialog ONLY when the dialog has no text in any input (per HS-7599). When any text is present, the click is ignored — the user can still close explicitly via × / Later / Esc / Save Draft.
- The dialog only auto-shows once per detail-panel open (tracked by note ID) to avoid re-opening on every poll refresh.

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
- Lists — see §21.2.2 for the HS-7558 split-into-items heuristic. Lists that match the heuristic become one block per item (with one `+ Add response` slot per item); lists that don't match stay grouped as a single block (matching the original HS-6998 v1 behavior).
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

**Implementation.** Server: `src/db/feedbackDrafts.ts` (CRUD + the `FeedbackDraft` shape), four routes in `src/routes/tickets.ts`, schemas in `src/routes/validation.ts`, table DDL in `src/db/connection.ts`. Client: `src/client/feedbackDialog.tsx` extends `showFeedbackDialog()` with an optional `draftSeed` parameter for the reopen path + a Save Draft handler that POSTs (new) or PATCHes (existing seed) the dialog's collected partitions; `src/client/noteRenderer.tsx` exposes `setTicketDrafts(ticketId, drafts)` + `getTicketDrafts(ticketId)` accessors and renders draft cards inline; `src/client/detail.tsx` GETs `/feedback-drafts` on detail-panel-open and re-renders the notes list with drafts populated.

**Tests.** 7 unit tests in `src/db/feedbackDrafts.test.ts` cover CRUD round-trips, partition idempotency, listing order, free-floating drafts, missing-id PATCH returns null, and FK CASCADE on parent ticket delete. 4 e2e tests in `e2e/feedback-drafts.spec.ts` cover empty-input click-away closes the dialog, populated-input click-away keeps it open, Save Draft persists + renders inline, and click-to-reopen restores the catch-all + Submit deletes the draft.

### 21.2.2 Per-list-item insertion points (HS-7558)

The HS-6998 v1 always rendered a list as a single block, which meant a numbered list of question — the most natural shape for a multi-part feedback prompt — only got ONE `+ Add response here` slot at the end of the whole list. Users wanted to answer question-by-question. HS-7558 extends `parseFeedbackBlocks` with a heuristic that splits a list into per-item blocks when it "looks like a question set."

**The heuristic.** A top-level list is split into one block per item when EITHER:
1. The list is the **first meaningful block** of the prompt (paragraphs / headings / etc. before it would push it later in the order). Rationale: a leading numbered list of questions is almost always a question set, regardless of whether each item ends with sentence punctuation. This is the screenshot scenario from the original ticket.
2. **Every item's first line ends with `.`, `?`, or `!`.** Picks up question lists in the middle of a prompt while still leaving option menus / flat tag lists alone. The first-line-only check matters: items with sub-bullets ("1. Top question? — sub a — sub b") have the parent question on line 1 and bullets after; the heuristic ignores the sub-bullets when deciding whether the list is question-shaped.

If neither holds, the list stays grouped as a single block. Examples:

- `- foo / - bar / - baz` mid-prompt — items lack sentence punctuation, list isn't first → **not split**, stays one block.
- `1. Question A? / 2. Question B! / 3. Question C.` mid-prompt — every item ends in punctuation → **split**, three blocks.
- `1. heading / 2. another` at top of prompt — first-block rule wins → **split**, two blocks. (Edge case: a leading list that's a tag list rather than a question list will get split too. Acceptable trade-off — tag lists at the top are rare in feedback prompts, and the user can just ignore the extra slots.)
- `Outline: / - First section name? / - Second section name / - Third question?` — only some items end in punctuation → **all-or-nothing**, list stays grouped.

**Sub-bullets stay with their parent.** When a list item has sub-bullets nested under it, splitting puts the parent + its sub-bullets into ONE block. Sub-bullets are typically clarifications of the question, not separate questions. Example: `1. Top question? — sub a — sub b — 2. Plain question?` produces 2 blocks (block 0 contains the parent + both sub-bullets, block 1 contains the second top-level question).

**Backward compat.** Existing prompts with no top-level lists are unaffected. Prompts with non-question lists (option menus, flat tags) are unaffected. Only question-shaped lists pick up the new per-item slots.

**Implementation.** `shouldSplitListIntoItems(list, isFirstBlock)` is a pure helper in `feedbackParser.ts` that gates the split per-list. `combineQuotedResponse` is unchanged — `blockIndex` indexes into whatever block list `parseFeedbackBlocks` returns, so per-item blocks slot in transparently. 4 new unit tests in `feedbackParser.test.ts` cover the four cases (leading list always splits, mid-prompt sentence-punctuated list splits, mid-prompt option list stays grouped, partial-punctuation list stays grouped) plus a sub-bullet preservation test. The existing "treats a list as a single block" test was renamed and updated; the existing "treats a numbered list the same way" test was renamed to reflect the new leading-list-always-splits behavior.

### 21.3 Provide Feedback Link

- In the detail panel, below notes that have a feedback prefix (when that note is the most recent), a "Provide Feedback" link button appears.
- Clicking it re-opens the feedback dialog, in case the user dismissed it earlier.

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

**Click behaviour.**
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
