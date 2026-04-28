# 49. Reader Mode (Notes + Details)

HS-7957 (design) / HS-7961 (implementation). Almost-full-screen, read-only **reader mode** overlay for individual notes and for a ticket's Details section. Both surfaces routinely grow long enough that scanning them inside the constrained detail panel is tedious — the user wants to "expand to read" without leaving the current ticket / project context.

> **Status:** Shipped. Notes + Details share a single `openReaderOverlay({title, markdown})` export from `src/client/readerOverlay.tsx`. 18 unit tests in `readerOverlay.test.ts` cover the two pure title-builders (`buildNoteReaderTitle`, `buildDetailsReaderTitle`) and the open / dismiss happy paths.

## 49.1 Problem statement

The detail panel ([4-user-interface.md](4-user-interface.md)) is sized to coexist with the ticket list — it's typically 30–45 % of the viewport width and shorter than the rendered notes / details often need. Users routinely:

- Open a note that's a multi-page postmortem and scroll inside a ~400 px tall card.
- Read a ticket's Details that runs ~1000 words.
- Lose place / context when scrolling because the card's scroll-bar is competing with the page's scroll-bar.

The catch-all "make the detail panel taller" lever exists (the resize divider — HS-6312 expand) but it sacrifices the ticket list and is reset per project. What's missing is a **per-content** "give me real reading space" affordance that pops up, lets the user read, and dismisses cleanly.

## 49.2 Scope

**In scope.**
- A book-open-text **trigger button** on every note's header row (right side, to the left of the megaphone when it's shown — see §49.4).
- The same trigger on the ticket Details section's label row (§49.5).
- An **almost-full-viewport overlay** rendering the rendered markdown content read-only (§49.6).
- Close via X button, Escape, or backdrop click.

**Out of scope.**
- **Editing in reader mode.** The detail panel is the editor; reader mode is the reader. Switching modes within the overlay is deferred — a user who wants to edit clicks through to the underlying note / details field.
- **Print view.** Reader mode is interactive; printing a ticket has its own concerns (paper sizing, page breaks, attachment handling) and the existing `Cmd/Ctrl+P` print path covers it.
- **Reader mode for other fields.** Title / category / priority / etc. are short and don't benefit. Tags lists could in theory but aren't long enough to justify.
- **Drafts / comments / attachments inside the overlay.** Reader mode renders ONLY the source field's markdown.

## 49.3 Trigger icon

Lucide [`book-open-text`](https://lucide.dev/icons/book-open-text). 14 px stroked SVG, inherits the `currentColor` of the surrounding text. Inline-SVG, not a sprite reference, so it doesn't fight Tauri's WKWebView about CSP.

```html
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 7v14"/>
  <path d="M16 12h2"/>
  <path d="M16 8h2"/>
  <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
  <path d="M6 8h2"/>
  <path d="M6 12h2"/>
</svg>
```

## 49.4 Note trigger

Inserted into the existing `.note-timestamp-row` ([`src/client/noteRenderer.tsx`](../src/client/noteRenderer.tsx)). Today the row layout is `[timestamp on left] [megaphone on right]`; the new layout is `[timestamp on left] [book-open-text] [megaphone (when shown)]`.

- The book button is **always shown** on a non-empty note (empty notes get neither button). The megaphone is conditional on §12.10 channel state; the book is unconditional.
- Visual styling matches the megaphone — same hit area, same hover state, same `title` tooltip ("Open in reader mode").
- Click opens the reader (§49.6) with the note's body. Stops propagation so the click doesn't also trigger note-edit.
- A note that's also a `FEEDBACK NEEDED` prompt gets the book button too — those are often long Claude prompts the user benefits from reading at width.

Edge case: a feedback-prefix note already shows the "Provide Feedback" link button below it. That link stays where it is (full row beneath the note); the book icon is in the timestamp row above and doesn't crowd it.

## 49.5 Details trigger

Inserted next to the existing `<label>Details</label>` in [`src/routes/pages.tsx`](../src/routes/pages.tsx). The label becomes a flex row with the text on the left and the book button on the right:

```jsx
<label className="detail-details-label">
  <span>Details</span>
  <button className="detail-reader-btn" title="Open in reader mode">{book-open-text icon}</button>
</label>
```

- Disabled when the Details textarea is empty (no point opening a reader for nothing). Greyed out, no click handler fires.
- Click opens the reader with the current Details textarea value, rendered through the same `marked.parse` pipeline notes use.
- Snapshot at click time — if the user is mid-edit and clicks the book, the reader shows the in-memory edited value, not the persisted one. Reader-mode is read-only so there's no save back.

## 49.6 Reader mode overlay

Anatomy:

```
┌──────────────────────────────────────────────────────────────────┐
│  ▍ Note from 2026-04-28 14:32                            [ × ]   │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ # Heading                                                    │ │
│ │                                                              │ │
│ │ Body paragraphs render at 16 px line-height ~1.6 with the    │ │
│ │ same markdown CSS notes use elsewhere.                       │ │
│ │                                                              │ │
│ │ ```js                                                        │ │
│ │ code blocks render with the existing syntax highlighting.    │ │
│ │ ```                                                          │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Sizing.** 90 % of viewport in both axes (clamped to a maximum readable line-length: `max-width: min(960px, 90vw)`). Centered. Backdrop `rgba(0, 0, 0, 0.4)` so the underlying ticket / panel is dimmed but the user keeps spatial context.

**Header.** A single row: title on the left, close `×` button on the right (mirrors the existing dialog header pattern from `feedbackDialog.tsx` / `confirmDialog.tsx`).

- Note title: `Note from <localised timestamp>` (omits the timestamp if the note has no `created_at`).
- Details title: `Details for <ticketNumber>: <ticketTitle>` (so a user reading details for HS-1234 sees the ticket number + title in the header).

**Body.** A scroll-bounded `<div class="reader-mode-body note-markdown">` rendering the markdown HTML. The `note-markdown` class reuses the same CSS that styles inline-rendered notes, so headings / lists / code blocks / blockquotes / tables look identical to how they render in the panel — just at width.

**Read-only.** No textarea, no contenteditable, no inline edit affordance. Selecting + copying text works (browser-default behaviour). Right-click context menu is the browser default.

**Dismiss.** Three paths, all equivalent:
1. Click the `×` in the header.
2. Press `Escape`.
3. Click the dimmed backdrop (`e.target === overlay`).

The `Escape` listener is added on the document with `capture: true` so it beats any other `Escape` handler (e.g., the global "blur input" handler in `shortcuts.tsx`). Removed on overlay teardown.

**Tauri-safe.** No native dialogs. The overlay is a plain `.reader-mode-overlay` div with `position: fixed; inset: 0` mounted on `document.body` — same pattern as feedbackDialog / confirmDialog.

**Stacking.** `z-index: 2400`. Below the feedback dialog (`2500`) so a `Provide Feedback` flow opened on top wins, but above everything else (terminal dashboard, popups).

## 49.7 Open question — multi-content navigation

A note's reader could in theory expose prev / next arrows so the user reads through every note in the ticket without dismissing + reopening. Out of scope for v1 — the user can dismiss + click the next note's book icon. Worth a follow-up if the reading flow proves common.

## 49.8 Implementation

Single follow-up ticket because the surfaces share the overlay component:

- New `src/client/readerOverlay.tsx` exporting `openReaderOverlay({ title, markdown })`. Builds the overlay, mounts on body, wires the three dismiss paths, returns nothing (fire-and-forget).
- `src/client/noteRenderer.tsx` — extend `.note-timestamp-row` with the book button (left of megaphone, unconditional on non-empty notes); wire click → `openReaderOverlay`.
- `src/routes/pages.tsx` — wrap the existing `<label>Details</label>` with a flex row + book button; new `bindDetailsReader` in `src/client/detail.tsx` handles the click.
- `src/client/styles.scss` — `.reader-mode-overlay`, `.reader-mode-dialog`, `.reader-mode-header`, `.reader-mode-body`, `.detail-details-label` (flex layout). Reuse `.note-markdown` for the body so the rendered content is style-identical to inline notes.
- Tests:
  - Pure helper test for the title-builder (note timestamp formatting, ticket-number + title concatenation, empty / missing fields).
  - Happy-dom test for the overlay: open, assert markdown is rendered + read-only, close via X / Escape / backdrop, assert overlay removed.
  - E2E (Playwright): open a ticket, click a note's book icon, verify overlay appears with the note's content; press Escape; verify dismissal.

## 49.9 Cross-references

- §3 Ticket management — notes data model.
- §4 User interface — detail panel layout.
- §12.10 Permission relay — established overlay pattern reused here.
- §21 Feedback dialog — same pattern + similar dialog structure.
- HS-7601 — megaphone button; the new book button sits to its left in the timestamp row.
