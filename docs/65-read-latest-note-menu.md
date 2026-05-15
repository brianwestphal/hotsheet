# §65 Read Latest Note context-menu item (HS-8401)

A right-click affordance on ticket rows + column-view cards that opens
the most recent non-empty note in the §49 reader-mode overlay. The
existing entry-points to the reader (the `book-open-text` icon next to
each note's timestamp row, plus the Details label button) require the
user to first select the ticket, scroll to the relevant note, then
hover its row. The §65 menu item collapses that into a single
right-click on the ticket itself.

## §65.1 Surfaces

The item lives in `showTicketContextMenu` (`src/client/contextMenu.tsx`),
which is wired into both list-view rows (via
`src/client/ticketRow.tsx::createTicketRow`) and column-view cards (via
`src/client/columnView.tsx::createColumnCard`). The same item therefore
appears on either surface without duplicate wiring.

## §65.2 Behavior

- **Position in the menu**: directly below the §49 / HS-8339 Provide
  Feedback item (when present). Both actions are note-related, so they
  cluster at the top of the menu where eye-tracking studies (and
  observation) suggest first-action items belong. **HS-8414 (2026-05-15)**
  — a separator follows the cluster (under Read Latest Note, below
  Provide Feedback when present) to visually divide the two top
  inspection affordances from the configuration submenus
  (Category / Priority / Status / Up Next) that begin immediately below.
  The separator is gated on single-selection — the same gate that
  controls whether either top item renders — so multi-select menus
  still open straight on the Category submenu without a leading sep.
- **Icon**: Lucide `book-open-text` — the same glyph the §49 reader
  trigger uses on note rows and the Details label button. Users learn
  one icon for the reader entry-point.
- **Action**: opens `openReaderOverlay({ title, markdown })` from
  `src/client/readerOverlay.tsx` with the latest non-empty note's
  `text` as `markdown` and `buildNoteReaderTitle(note.created_at)` as
  the title. The overlay's own dismiss / Escape / backdrop-click
  behavior is unchanged from §49.
- **Single-selection only**: the item is omitted when
  `state.selectedIds.size !== 1`. The reader overlay targets one note
  at a time; a "read latest note across N tickets" affordance would
  need a multi-ticket overlay variant which doesn't exist.

## §65.3 Empty-state

The item is **disabled** (greyed out, present) when the ticket has no
non-empty notes. The DOM is rendered with the `.disabled` class on the
`.context-menu-item` element; the click listener is omitted so the
item is unreachable but visible. Users learn the affordance exists
even on tickets that don't yet have content.

A note counts as "empty" when its `text` is empty after `.trim()`. Two
practical cases:

- The ticket's `notes` field is an empty string or `[]`.
- The notes array contains only placeholder rows whose `text` is `''`,
  whitespace-only, or a bare newline. (Notes can be created via the
  `n` keyboard shortcut and immediately discarded with Escape; those
  rows may live in the array with empty text.)

The "find latest non-empty note" search walks the notes array from
the end backwards, returning the first row whose `text` is non-empty
after trimming. Returns `null` when no row matches, which is the
signal the menu item uses to apply the `disabled` class.

## §65.4 Implementation pointer

- Pure helper: `collectNonEmptyNotes(notesJson: string)` in
  `src/client/contextMenu.tsx`. Returns `{ entries, latestIndex } | null`
  — a single pass through `parseNotesJson` yields the full non-empty
  list plus the index of the latest entry, so the menu can pass a
  §59 `navigation` slot to the reader without re-walking the array
  (HS-8415 renamed the helper from `findLatestNonEmptyNote` for this).
- Menu wiring: inside `showTicketContextMenu` after the Provide
  Feedback block — single-call to `addActionItem(menu, 'Read Latest
  Note', open, { icon, disabled })` with the existing
  `addActionItem` helper widened to support a `disabled?: boolean`
  option (which adds the CSS class and skips the click listener
  attachment). The click handler builds `navEntries` from
  `collectNonEmptyNotes` and passes
  `navigation: { entries, initialIndex }` to `openReaderOverlay` when
  more than one non-empty note exists — chevron + ArrowUp / ArrowDown
  step back through earlier notes (HS-8415; matches the per-note
  book-icon trigger in `noteRenderer.tsx`).
- Separator: `addSeparator(menu)` immediately after the Read Latest
  Note `addActionItem` call, gated on `state.selectedIds.size === 1`
  (HS-8414). The Push-to-backend insertion point further down the
  menu is anchored on the `.context-menu-separator-backlog` marker
  class — added via the `addSeparator(menu, extraClass)` parameter on
  the separator above Move to Backlog — so adding the HS-8414
  separator higher up doesn't shift the Push position.

## §65.5 Regression coverage

`src/client/contextMenu.test.ts` under the
`showTicketContextMenu — Read Latest Note (HS-8401)` describe block
covers nine cases: enabled item appears for tickets with non-empty
notes, disabled when notes are empty, disabled when every note is
placeholder-only (whitespace), clicking the enabled item opens the
overlay with the latest non-empty markdown, the search walks back
past empty newer notes to find the actual content, multi-select
omits the item, and three HS-8415 navigation cases — chevrons render
for multi-note tickets and are correctly disabled at the latest
boundary, chevrons omitted when only one non-empty note exists, and
the navigation list skips empty notes so chevron-up walks from later
straight to earlier with the blank middle removed. A separate
`HS-8414 separator under inspection block` describe block covers
the separator placement (between Read Latest Note and Category for
single-selection, present for feedback tickets too, omitted on
multi-select).

## §65.6 Follow-up tickets

None outstanding. The item is single-purpose; no keyboard-shortcut
binding was specified by the user.
