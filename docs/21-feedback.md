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
  - **No Response Needed** (right side): Adds a note with text `NO RESPONSE NEEDED`, clearing the feedback state.
  - **Submit** (right side, primary): Creates a new note with the response text, uploads attachments, and notifies the Claude Channel (if connected) that feedback was provided.
- Click-outside-overlay dismisses the dialog (same as "Later").
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
- Lists — always rendered as a single block. If the user wants to answer item-by-item they can add multiple inline responses after the list and label them themselves in the response text. (The dialog deliberately doesn't split list items into their own slots — false positives on options menus were the bug we were fixing.)
- Code blocks, headings, blockquotes — each is a distinct block and can have its own inline response.

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
