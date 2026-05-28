# §66 Move to Open context-menu item (HS-8408)

A right-click affordance on backlog tickets that moves them out of the
backlog and back into active work (`status: not_started`). Mirrors the
existing **Move to Backlog** item one slot above it in the same menu,
so a backlog ticket has a one-click way back without going through the
status submenu.

## §66.1 Label and terminology

The label is **Move to Open**, not "Move to Inbox". Hot Sheet doesn't
use "inbox" terminology — the sidebar's view of active (non-backlog,
non-archive) tickets is named **Open**, so the menu label mirrors that
view name. The destination status under the hood is `not_started` —
the same status a freshly-created ticket gets — which is consistent
with how every other "this ticket is now active" affordance behaves.

## §66.2 Gating

The item appears only when **every** selected ticket is currently in
`status: backlog`. Mixed selections (some backlog, some not) and
single-selection non-backlog tickets do NOT render the item — strict
inverse of how **Move to Backlog** works (always present, sets every
selection to backlog regardless of current status).

Archive tickets do NOT get the symmetric item. Strict reading of
HS-8408: the user asked for "when items are in backlog" specifically.
If a "Move to Open" affordance for archive is wanted later, the gate
just adds an OR — no other plumbing needed.

## §66.3 Position in the menu

Renders directly **above** Move to Backlog, with no separator between
them. The natural reading is "out of backlog ↔ into backlog" as
paired adjacent items, with **Archive** following both as the other
forward stash action and the existing separators (one above the
group, one below before Delete) preserved unchanged.

The HS-8414 inspection-block separator above Category and the
Push-to-backend marker-class anchor (`.context-menu-separator-backlog`)
still work — the new item sits below both and doesn't shift
positional indices on the marker-class lookups.

## §66.4 Action

`applyToSelected('status', 'not_started')` — the same helper every
other status mutation in the context menu uses. Goes through the
undo-tracked `trackedPatch` / `trackedBatch` so the action is
undoable.

## §66.5 Icon

Lucide `inbox` (new `ICON_INBOX` constant in `src/client/icons.tsx`).
The user explicitly declined "inbox" as a label, but the visual is the
universally-recognized glyph for "active work pile" — picking a less
familiar icon would force users to learn a new affordance for what is
fundamentally the inverse of the calendar-icon Move to Backlog.

## §66.6 Implementation pointer

- Icon: `ICON_INBOX` in `src/client/icons.tsx`.
- Menu wiring: inside `showTicketContextMenu` (`src/client/contextMenu.tsx`),
  immediately above the existing `Move to Backlog` block. Gate:
  `state.selectedIds.size > 0 && Array.from(state.selectedIds).every(id => state.tickets.find(tk => tk.id === id)?.status === 'backlog')`.
  Action: `applyToSelected('status', 'not_started')`.

## §66.7 Regression coverage

`src/client/contextMenu.test.ts` adds five tests under the existing
`HS-8414 separator under inspection block` describe block:

- **shown for backlog tickets** — asserts the item appears directly
  above Move to Backlog (the natural inverse-pair position).
- **omitted for non-backlog tickets** — single-selection ticket with
  `status: not_started`; Move to Open absent.
- **omitted for mixed selections** — one backlog + one not-started
  selected; item absent (strict gate).
- **shown for multi-backlog selections** — two backlog tickets
  selected; item present (multi-select bulk action).
- **omitted for archive tickets** — single archive ticket; item
  absent (backlog-only per user direction; see §66.2).

## §66.8 Follow-up tickets

None outstanding. If a parallel "Move to Open" for archive is wanted
later, that's a one-line gate change + one-line label-tweak decision
(probably "Move to Open" still, since the destination is the same).
The user-facing direction was explicitly "backlog only" for this
ticket, so no follow-up is filed.
