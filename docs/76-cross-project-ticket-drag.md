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
- **Modifier detection (HS-8663 fix):** the copy-vs-move decision reads a
  **window-level Alt tracker** (`keydown`/`keyup`/`blur` on `window`) OR'd with
  the drag event's own `altKey`. Native HTML5 drag events don't reliably carry
  modifier flags in Tauri's WKWebView, so reading `e.altKey` alone made Option
  silently fall back to copy in the desktop app. Since the user holds Option
  before/as the drag begins, its `keydown` lands before the native drag loop and
  the flag is set; the `e.altKey` fallback preserves Chromium + mid-drag behavior.
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

### 76.4.1 Attachments are carried (HS-8739)

Both `transferTicketsToProject` (drag) and `clipboard.ts::pasteTickets`
(copy/cut/paste) copy a ticket's attachments to the target project via the
server endpoint **`POST /api/tickets/:id/attachments/copy-from`** (typed caller
`copyTicketAttachments(targetId, { sourceSecret, sourceTicketId }, { secret })`).
The target ticket `:id` is authed with the target secret; the source project is
named in the body. The server reads the source ticket's non-draft attachment
rows from the source project's DB (`runWithDataDir(sourceDataDir, …)`) and copies
the files (by their absolute `stored_path`) into the target project's
`attachments/` dir — the bytes never round-trip through the browser. Duplicate
target filenames are suffixed (`_1`, `_2`, …) so a copy never clobbers an
existing file; draft attachments are skipped; a vanished source file is skipped
rather than failing the batch. The copy is best-effort: a failure logs and is
swallowed so the ticket transfer itself still succeeds. This closes the prior
move-loses-attachments gap.

## 76.5 Testing

- **Unit** — `ticketTransfer.test.ts` (copy creates in target with target
  secret, move also soft-deletes with source secret, notes carried / empty
  skipped, trashed→not_started, move without sourceSecret falls back to the
  active project). `projectTabsTicketDrop.test.ts` (drop onto another tab calls
  the transfer with the right secret + copy/move flag, Option threads move,
  drop onto the source tab is a no-op, a tab reorder doesn't transfer).
- **E2E** (HS-8740) — `e2e/cross-project-drag.spec.ts` registers a real second
  project against a throwaway temp dir and synthesizes the drag (`dragstart` on
  the row → `dragover` + `drop` on the destination tab, `altKey` for move):
  copy lands a duplicate in B with the original kept in A; Alt-move removes the
  original from A and lands it in B; dropping onto the source's own tab is a
  no-op; and (HS-8739) a copy carries the ticket's attachment into B. The temp
  project is unregistered in `afterEach` (its data dir is left for the OS to
  reap — removing it mid-run panics PGLite's next checkpoint).
- **Attachment copy** (HS-8739) — `src/routes/attachmentCopyCrossProject.test.ts`
  drives the `copy-from` route across two project DBs (file copied into the
  target dir with content preserved, source untouched, dedup-suffix on duplicate
  names, draft attachments excluded, 400 on unknown source / malformed body);
  `ticketTransfer.test.ts` asserts the transfer calls `copyTicketAttachments`
  with the right ids + secrets (and skips it without a source secret);
  `api/attachments.test.ts` pins the typed caller's URL/body + the request
  schema.
- **Manual** — the real OS drag-and-drop gesture (native drag image), the
  Option-key copy↔move cursor badge, and the "+"-button-drop → folder-picker →
  transfer flow remain in the manual test plan (Playwright can't drive the
  native drag image / modifier cursor or the OS folder dialog).
