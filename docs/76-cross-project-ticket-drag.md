# 76. Cross-Project Ticket Drag (Copy / Move)

Drag tickets from the list / column view onto another project's tab to **copy**
them there, or hold **Option/Alt** to **move** them. Dropping onto the tab
strip's **"+" button** picks a folder for a brand-new project and transfers the
tickets into it. The operation mirrors the existing keyboard copy/paste and
cut/paste (§3) — drag-copy ≈ copy/paste, Option-drag ≈ cut/paste — but is
driven entirely by drag-and-drop. Introduced in HS-8663; builds on the
always-tabbed strip + add-project button from [4-user-interface.md](4-user-interface.md) §4.2 (HS-8664).

## 76.1 Drag source

- Ticket rows (`ticketRow.tsx`) and column cards (`columnView.tsx`) are already
  draggable and publish the dragged ticket ids via `setDraggedTicketIds(...)`
  (`ticketListState.ts`) on `dragstart`. The dragged set is the multi-selection
  when the dragged ticket is part of a 2+ selection, otherwise just that ticket.
- `dragstart` sets `dataTransfer.effectAllowed = 'copyMove'` (was `'move'`) so a
  drop target can offer **copy** as well as **move**. Existing in-app move
  targets (the column-view status drop) set `dropEffect = 'move'` explicitly, so
  their cursor is unchanged.

## 76.2 Drop onto a project tab

- While a ticket drag is in flight (detected as "not a tab reorder": the tab
  reorder sets an internal `dragSecret`, a ticket drag leaves it null and
  populates `draggedTicketIds`), hovering a project tab lights it with a
  `.drag-over` accent highlight. The highlight is single-slot — it follows the
  cursor between tabs / the "+" button without flicker, and clears on
  `dragleave`, on drop, and on a global `dragend` (covers a release over empty
  space).
- **Copy (default):** `dropEffect = 'copy'`. The selected tickets are recreated
  in the target project.
- **Move (Option/Alt held):** `dropEffect = 'move'`. The tickets are recreated
  in the target project and the originals are soft-deleted (moved to Trash) from
  the source project. After a move the source list reloads so the moved tickets
  drop out and their selection clears.
- **Dropping onto the source project's own tab is a no-op** (the dragged
  tickets already live there) — that tab is not highlighted and rejects the drop.
- A toast confirms the result: "Copied N ticket(s) to <project>" /
  "Moved N ticket(s) to <project>".

## 76.3 Drop onto the "+" (add-project) button

- Dropping tickets onto the "+" button (§4.2) captures the dragged ids + the
  copy/move intent, then opens the folder picker (`showOpenFolderDialog`, native
  Tauri `pick_folder` or the in-app `#open-folder-overlay`).
- On a folder being registered as a new project, the tickets are copied / moved
  into it (before the app switches to the new project, so a move deletes from the
  still-active source). The app then switches to the new project, showing the
  transferred tickets.
- **Canceling the picker changes nothing** — no project is created and no
  tickets are copied or moved. The one-shot transfer callback is dropped on
  cancel (native-picker cancel, the overlay close button, and a backdrop click).

## 76.4 Transfer semantics (`transferTicketsToProject`)

`src/client/ticketTransfer.ts` is the shared engine for both drop targets. For
each source ticket it:

- Creates a new ticket in the target project (`createTicket(req, { secret })`),
  carrying **title, details, category, priority, status, up_next, tags**. A copy
  of a trashed ticket re-enters as `not_started`. Priority/status are narrowed
  through the `TicketSchema` SSOT with a safe default fallback.
- Carries **notes** (`putTicketNotesBulk(id, notes, { secret })`) when the source
  has any.
- For a **move**, soft-deletes each original via
  `updateTicket(id, { status: 'deleted' }, { secret: sourceSecret })` — the
  source secret is threaded explicitly so a subsequent project switch (the
  "+"-button flow) can't redirect the delete to the wrong project.

The typed callers `createTicket` and `putTicketNotesBulk` gained an optional
`{ secret }` argument (HS-8663) to route cross-project, matching `updateTicket` /
`deleteTicket` which already had it.

### 76.4.1 Known gap — attachments are not carried

`transferTicketsToProject` does **not** copy a ticket's attachments to the target
project — the same gap the existing cross-project clipboard paste
(`clipboard.ts::pasteTickets`) has. For a **move**, this means the originals'
attachments are lost when the source is trashed (and later cleaned up). Tracked
as a follow-up to carry hash-addressed attachments across projects for both the
clipboard-paste and drag paths.

## 76.5 Testing

- **Unit** — `ticketTransfer.test.ts` (copy creates in target with target
  secret, move also soft-deletes with source secret, notes carried / empty
  skipped, trashed→not_started, move without sourceSecret falls back to the
  active project). `projectTabsTicketDrop.test.ts` (drop onto another tab calls
  the transfer with the right secret + copy/move flag, Option threads move,
  drop onto the source tab is a no-op, a tab reorder doesn't transfer).
- **Manual** — the real OS drag-and-drop gesture, the Option-key copy↔move
  cursor, and the "+"-button-drop → folder-picker → transfer flow are in the
  manual test plan (drag-and-drop is not reliably automatable end-to-end).
