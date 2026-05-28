# 59. Reader-mode note navigation

HS-8233. Adds chevron-up (previous) / chevron-down (next) buttons to the [§49 reader mode](49-reader-mode.md) overlay so the user can read through every non-empty note on a ticket without having to dismiss the overlay and re-click the book icon for each note. Builds on HS-7961's reader overlay infrastructure; does NOT change the per-note book trigger or the Details book trigger entry points.

> **Status:** Shipped. New optional `navigation` slot on `OpenReaderOverlayOptions` in `src/client/readerOverlay.tsx`; the per-note book-button click handler (in `src/client/contextMenu.tsx`) builds the navigation list at click time. 14 new unit tests in `readerOverlay.test.ts` cover the rendered-buttons / disabled-at-boundaries / step-forward / step-backward / keyboard / aria-label / clamped-initialIndex / Escape-still-works contracts.

## 59.1 Problem statement

The §49 reader overlay was originally per-content: click the book icon on note A → reader shows A; close → click on B → reader shows B. For users with long-running tickets where every status update is a multi-paragraph note, that round-trip (close, scroll, click, read, close, scroll, click, …) is friction. The user asked for in-place navigation: open the reader on any note, then chevron through the rest.

## 59.2 Scope

**In scope.**
- Two new buttons in the reader overlay header — chevron-up (`previous`) + chevron-down (`next`) — visible whenever the overlay is opened with a list-navigation context.
- Buttons are **disabled** at list boundaries (chevron-up at the first entry, chevron-down at the last entry) per the ticket's explicit ask.
- Keyboard shortcuts: `ArrowUp` = previous, `ArrowDown` = next.
- The per-note book-button entry point in `contextMenu.tsx` builds a navigation list of every non-empty note in display order and passes the clicked note's index as the initial.

**Out of scope.**
- ~~Navigation for the ticket Details reader. The Details reader has only one entry — there's nothing to navigate. The buttons are not rendered when navigation isn't supplied.~~ **Updated 2026-05-18 (HS-8429):** the Details reader now also navigates across the unified `[Details, ...non-empty notes]` list; see §59.9.
- Cross-ticket navigation. The reader stays scoped to the active ticket's notes; navigation does not jump to the next ticket.
- Wrapping. Past-the-end and before-the-beginning navigation is a no-op (button disabled, key handler bails). No wrap-around to the other end.
- Edit-in-place from the reader. Still read-only per §49.

## 59.3 API change

`src/client/readerOverlay.tsx::OpenReaderOverlayOptions` gained an optional `navigation` field:

```ts
export interface ReaderEntry {
  title: string;
  markdown: string;
}

export interface ReaderNavigationOptions {
  /** Every entry in display order. Index 0 is the topmost entry in the
   *  caller's list. Must contain at least one element. */
  entries: ReaderEntry[];
  /** Initial entry to render. Must be in `[0, entries.length)`. Out-of-
   *  range values are clamped defensively. */
  initialIndex: number;
}

export interface OpenReaderOverlayOptions extends ReaderEntry {
  navigation?: ReaderNavigationOptions;
}
```

When `navigation` is omitted (the existing Details-reader path), the buttons are not rendered and the overlay behaves exactly as it did pre-HS-8233. When `navigation` is provided:

- The active entry is the source of truth — the top-level `title` / `markdown` fields are ignored on initial paint and on every subsequent navigation step. (Callers still pass them so the function shape stays back-compatible with single-entry sites.)
- The chevron-up / chevron-down buttons appear in the header next to the close X.
- `paintCurrent()` rewrites the title text + body innerHTML + `aria-label` + the disabled state on both buttons whenever the index changes.
- ArrowUp / ArrowDown handle the same navigation as the buttons.
- Escape still dismisses the overlay (not consumed by the navigation handler).

## 59.4 Per-note caller wiring

The `.note-reader-btn` click handler (in `contextMenu.tsx`) builds the navigation list at click time:

1. Iterate every note in display order.
2. Skip notes whose `text.trim() === ''` (empty notes don't have a reader button so they aren't navigable from this surface either).
3. Find the clicked note's position in the filtered list — that's the `initialIndex`.
4. Pass `navigation: { entries, initialIndex }` only when `entries.length > 1`. When the ticket has just one non-empty note, the chevron buttons would always be disabled anyway — omitting `navigation` keeps the overlay's chrome cleaner.

The per-note `note.text` snapshot at click time matches the §49.5 snapshot semantics — a mid-edit reader shows the persisted note content, not the in-flight edit-area value.

## 59.5 Visual design

Header layout:

```
[<title>]                    [^] [v] [×]
```

The chevron buttons sit in a new `.reader-mode-header-actions` flex cluster alongside the close X. They share the visual treatment (`.reader-mode-close, .reader-mode-prev, .reader-mode-next` collapsed into a common rule):

- 26 px square, transparent background, `currentColor` icon, hover lights up against `var(--bg-hover)`.
- `:disabled` state: `opacity: 0.35`, `cursor: default` (a disabled chevron remains visible so the user knows they're at a boundary, but doesn't react to hover).
- Glyphs: Lucide [`chevron-up`](https://lucide.dev/icons/chevron-up) + [`chevron-down`](https://lucide.dev/icons/chevron-down), 14 px stroked SVG inherited from the same icon font as the rest of the overlay chrome.

## 59.6 Accessibility

- `aria-label` updates on every navigation step so a screen-reader announces the new entry's title.
- `aria-label` on each chevron button (`Previous note` / `Next note`) describes intent rather than glyph.
- Disabled chevrons get `disabled` attribute + the visual opacity treatment so both keyboard- and mouse-driven users see the boundary.
- `title` tooltips include the keyboard shortcut hint (`Previous (Up)` / `Next (Down)`).

## 59.7 Tests

14 new tests in `src/client/readerOverlay.test.ts`:

- `does NOT render prev/next buttons when navigation is omitted` — back-compat for the Details reader.
- `renders prev + next buttons when navigation is supplied` — basic mount.
- `disables prev at the first entry and next at the last entry` — boundary states; navigates to the end and re-asserts.
- `clicking next steps forward and rewrites title + body` — primary happy path.
- `clicking prev steps backward` — second direction.
- `ArrowDown navigates next; ArrowUp navigates previous` — keyboard variant.
- `ArrowDown at the last entry is a no-op` — boundary-on-keyboard.
- `ArrowUp at the first entry is a no-op` — symmetric boundary.
- `Escape still dismisses when navigation is active` — Escape isn't consumed by the navigation handler.
- `clamps initialIndex into bounds defensively` — out-of-range positive value clamps to last.
- `clamps a negative initialIndex to 0` — symmetric defensive clamp.
- `updates ARIA label on navigation so screen readers see the active entry` — accessibility regression guard.

Plus 2 tests for the new exported pure helper:

- `renderReaderBodyHtml renders empty markdown to a placeholder`.
- `renderReaderBodyHtml renders non-empty markdown to HTML containing the source text`.

## 59.8 Cross-references

- [49-reader-mode.md](49-reader-mode.md) — the parent reader-mode design. §49.6 covers the overlay shell HS-8233 extends.
- [3-ticket-management.md](3-ticket-management.md) — note ordering is determined by the canonical `notes` array on the ticket; HS-8233 doesn't change ordering, just lets the user step through it.

## 59.9 Unified Details + Notes navigation (HS-8429)

**HS-8429 (2026-05-18) — extended the navigation list across the Details/Notes boundary.** Pre-fix the Details reader was single-entry-only (HS-8233 explicitly scoped it out) and the per-note reader only stepped through notes. Reading a ticket front-to-back required closing the Details reader, scrolling to the first note, and re-clicking the book icon there — and the same friction in reverse for jumping back to Details from a note. The user reported this as exactly the round-trip the original HS-8233 work was supposed to eliminate, just shifted by one boundary.

**Fix.** Both surfaces now build the same combined `[Details, ...non-empty notes]` list via a new pure helper:

```ts
export function buildCombinedReaderEntries(input: {
  ticketNumber: string | null | undefined;
  ticketTitle: string | null | undefined;
  detailsMarkdown: string;
  notes: readonly { id?: string; text: string; created_at: string }[];
}): CombinedReaderEntry[]
```

- Details lands at index 0 when its markdown is non-empty (whitespace-only is treated as empty, same gate as the noteRenderer's empty-note filter — empty bodies don't have a book button so they shouldn't be reachable from the reader either).
- Non-empty notes follow in display order, each carrying a stable `id` (the note's `id` field, or a synthetic `__no-id-<idx>` fallback so the noteRenderer's `findIndex(e => e.id === note.id)` lookup stays unique across notes without ids).
- Titles use the existing `buildDetailsReaderTitle` and `buildNoteReaderTitle` helpers — no new title formatting.
- Returns an empty array when both Details and every note are empty (defensive — caller still gates `navigation` on `entries.length > 1`).

The helper is pure (no DOM, no async, no module state) so it's testable in isolation. Both `detailBindings/readerButton.tsx::bindDetailReaderButton` and the `.note-reader-btn` click handler in `contextMenu.tsx` call it; each computes its own `initialIndex` (Details reader → position of the Details entry, typically 0; note reader → position of the clicked note, +1 when Details is included).

**Behavior summary.**

| Starting point | Prev chevron | Next chevron | ArrowUp / ArrowDown |
|----------------|--------------|--------------|---------------------|
| Details reader, ticket has notes | disabled (at index 0) | walks into notes | same as chevrons |
| Note reader, first note (Details non-empty) | walks back to Details | walks to next note (or disabled at last) | same |
| Note reader, first note (Details empty) | disabled (at index 0) | walks to next note (or disabled if only one) | same |

**Tests.** 9 new pure-helper cases in `readerOverlay.test.ts` under `describe('buildCombinedReaderEntries (HS-8429)')` cover: full list shape (Details + multiple notes), Details omission when empty, Details omission when whitespace-only, empty-note filtering, just-Details when there are no notes, fully-empty input returning `[]`, synthetic id fallback for notes without ids, Details title fallback (number-only / title-only), Note title fallback when `created_at` is missing. Plus 3 end-to-end integration cases under `describe('reader navigation across Details/Notes (HS-8429)')` exercise the full open → navigate flow: Details → next → first note, first-note → prev → Details, Prev disabled at the Details index.
