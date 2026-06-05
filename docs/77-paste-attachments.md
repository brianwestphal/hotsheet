# 77. Paste Files / Images as Attachments

Paste files or images from the OS clipboard (e.g. a screenshot, or a file
copied in the file manager) to create attachments — the clipboard counterpart
to the drag-and-drop file attach in [5-attachments.md](5-attachments.md).
Introduced in HS-8662.

## 77.1 Target resolution (by current selection)

A single document-level `paste` listener (`src/client/pasteAttachments.ts`,
wired from `app.tsx::init`) routes pasted files to a ticket based on the
current selection (`state.selectedIds`):

- **1 ticket selected** → the files attach to that ticket.
- **0 selected** → the files attach to a **new ticket** titled `Attachment`
  (single file) or `Attachments` (multiple). Mirrors the dropped-image
  fallback in `app.tsx::resolveDropTicketId`.
- **2+ selected** → **no-op**, with a toast: *"Pasting attachments to multiple
  tickets at once isn't supported."* Nothing is uploaded and no ticket is
  created.

After a successful paste the ticket list reloads and a toast confirms
*"Attached N file(s)."* Each file is uploaded via the same
`uploadAttachment(ticketId, file)` path the file input and drag-drop use
([5-attachments.md](5-attachments.md)).

## 77.2 Focus handling — when does a paste become an attachment?

- A **file** paste is hijacked regardless of which plain text input / textarea
  has focus — a text field can't accept a file, so a screenshot pasted while
  the new-ticket draft input (or a title / search field) is focused still
  becomes an attachment.
- A **text-only** paste carries no files, so the handler returns early and the
  browser's native paste runs normally (text lands in the focused input; the
  internal ticket clipboard's Cmd/Ctrl+V paste, [3-ticket-management.md](3-ticket-management.md),
  is unaffected — it is keydown-driven and sees no OS files).
- Rich **`contenteditable`** surfaces are left entirely alone (a note editor
  may want to handle an inline image paste itself).

## 77.3 Clipboard extraction

`extractClipboardFiles(clipboardData)` prefers `clipboardData.files` and falls
back to file-kind `clipboardData.items` (some browsers populate only the latter
for a pasted screenshot).

## 77.4 Known gap — same as drag/drop fallback

The 0-selected path creates a bare `Attachment` ticket exactly like the
dropped-image fallback; it is not auto-opened or auto-titled beyond
"Attachment(s)". A follow-up may improve discoverability (auto-select / open the
new ticket so the user can title it).

## 77.5 Testing

- **Unit** — `pasteAttachments.test.ts`: `handlePastedFiles` target resolution
  (1 selected → that ticket; 0 → new singular/plural ticket; 2+ → toast no-op;
  empty list → no-op) + `extractClipboardFiles` (`.files`, `.items` fallback,
  null).
- **E2E** — `e2e/paste-attachment.spec.ts`: synthetic `paste` with a `File` →
  0-selected creates an "Attachment" ticket with the file; 1-selected attaches
  to it (no stray ticket); 2+-selected shows the toast and creates nothing.
