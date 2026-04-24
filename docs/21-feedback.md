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
- Provides a text area for the user's response — **single textarea** for simple prompts, or **per-part textareas** when the prompt is a multi-part question set (see §21.2.1 for the multi-part layout).
- Supports file attachments (same pattern as the Not Working dialog).
- Action buttons (left to right):
  - **Later** (left side, styled as a muted link): Dismisses the dialog without action. The feedback state persists — the dialog will reappear next time the ticket is opened.
  - **No Response Needed** (right side): Adds a note with text `NO RESPONSE NEEDED`, clearing the feedback state.
  - **Submit** (right side, primary): Creates a new note with the response text, uploads attachments, and notifies the Claude Channel (if connected) that feedback was provided.
- Click-outside-overlay dismisses the dialog (same as "Later").
- The dialog only auto-shows once per detail-panel open (tracked by note ID) to avoid re-opening on every poll refresh.

### 21.2.1 Multi-part feedback layout (HS-6998)

AI-generated feedback requests are often multi-part — a numbered or bulleted list of questions, each needing its own answer. In the single-textarea layout, the user has to scroll between the prompt up top and their response at the bottom while typing each answer, losing track of which question they're on. The multi-part layout eliminates the scrolling by rendering a dedicated textarea **directly below each question**.

**Detection** — the prompt is parsed with `marked.lexer` (`src/client/feedbackParser.ts`). The first top-level list token with **≥ 2 items** triggers multi-part mode. Either ordered (`1.`, `2.`) or unordered (`-`, `*`, `+`) lists qualify. If no qualifying list is found, the dialog falls back to the single-textarea layout — no behavioural change for prompts that don't fit the pattern.

**Layout** — an `<ol class="feedback-parts-list">` with one `<li class="feedback-part">` per item. Each item shows the question text rendered as markdown (bold, code spans, links all preserved) and a short-height textarea for the response. Intro markdown (anything before the list) and outro markdown (anything after) wrap the list so the user still sees any framing context the AI provided.

**Multiple sibling lists** — only the first qualifying list is split into parts. Trailing lists fold into the outro. Rationale: a primary question set rarely ships alongside a second question set; more commonly a trailing list is a "references" or "to-do" recap that should stay as prose.

**Submit** — responses are re-combined into a single markdown note body via `combineResponses(values, ordered)`. The numbering scheme matches the prompt (`1.`, `2.`, ... for ordered; `- ` for unordered). Empty responses are preserved as `*(no response)*` placeholders so the submitted note keeps its numbering aligned with the prompt — a reader (human or AI) can always map answer N to question N. If **every** response textarea is empty, submission is blocked (same semantics as the single-textarea flow) and focus jumps to the first empty field.

**Focus** — on dialog open, focus the first empty part's textarea. On re-open after partial fill, focus the first empty one (or the first, if all are filled). Keeps keyboard users moving forward through the question list.

**Edge cases:**
- List with only one item — falls through to single-textarea. One question doesn't need the per-part affordance.
- Nested lists inside an item — rendered as nested markdown inside the question bubble; still one textarea per top-level item.
- Code blocks inside an item — rendered inline; the textarea is still plain text.

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

- Core module: `src/client/feedbackDialog.tsx` — prefix parsing, dialog rendering, channel notification
- Multi-part prompt parser (HS-6998): `src/client/feedbackParser.ts` — `parseFeedbackPrompt` + `combineResponses`, covered by 15 unit tests in `feedbackParser.test.ts`
- Note rendering: `src/client/noteRenderer.tsx` — "Provide Feedback" link
- Detail panel: `src/client/detail.tsx` — auto-show on ticket open
- Poll: `src/client/poll.tsx` — IMMEDIATE auto-select, feedback state scanning
- Project tabs: `src/client/projectTabs.tsx` — blue dot state management
- Worklist: `src/sync/markdown.ts` — AI instructions
- DB: `last_read_at` column (unrelated to feedback but enables unread detection)
