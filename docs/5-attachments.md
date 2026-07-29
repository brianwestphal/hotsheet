# 5. Attachments

## Functional Requirements

### 5.1 File Upload

- Files can be attached to any ticket via the detail panel.
- Multiple files can be selected at once in the file picker dialog.
- Uploaded files are copied to `.hotsheet/attachments/` with a filename of `{ticket_number}_{original_name}.{ext}` (e.g., `HS-42_screenshot.png`).
- The original filename is preserved in the database for display purposes.

### 5.2 Drag-and-Drop Upload

- Files can be dropped onto the detail panel body to add attachments to the active ticket.
- Standard drop target feedback is shown: a dashed accent-colored outline and subtle background tint appear when files are dragged over the detail body.
- Multiple files can be dropped at once — each is uploaded sequentially.
- A nested `dragenter`/`dragleave` counter prevents flicker when dragging over child elements.
- Only activates when `Files` are present in the drag data (ignores text drags, etc.).
- After upload, the detail panel refreshes to show the new attachments.

### 5.2.1 Drag-and-Drop onto a ticket row (HS-7492)

- Files dragged over a ticket in the list view (`.ticket-row[data-id]`) or a card in the column view (`.column-card[data-id]`) highlight that row / card as the drop target via the `.file-drop-target` class — same accent-tinted dashed outline as the detail-body drop style, so the two drop surfaces read as one affordance.
- Dropping one or more files on a ticket row / card attaches them to THAT ticket, regardless of which ticket (if any) is currently selected. Row / card drop target takes precedence over the selection because the user's intent is explicit: they dropped on a specific ticket.
- If the drop lands outside any row / card, the pre-existing behavior applies — attach to the single selected ticket, else create a new "Attachment" ticket (or use the draft-input value as the title if set) and attach to it. When a new ticket is created this way, it is auto-selected and its detail panel auto-opens (HS-8742) so the user can immediately retitle it and see the attachment — matching the clipboard paste flow (§77).
- Trashed rows (`.trash-row`) are deliberately excluded as drop targets — attachments on trashed tickets would be silently removed by the next auto-cleanup sweep.
- Only activates when `Files` are present in the drag data. The column-view ticket-reorder drag carries `text/plain` instead of `Files`, so its own `.column-drop-target` highlight (reorder-by-status) and the HS-7492 file-drop highlight are mutually exclusive — a reorder drag never lights up a file-drop target, and a file drag never lights up the whole column.
- Playwright e2e coverage in `e2e/ticket-row-drop.spec.ts`: (1) select ticket B, dispatch a synthetic file drop on ticket A's row, assert the attachment lands on A and NOT on B; (2) drop outside any row with no selection creates a new "Attachment" ticket with the file (fallback regression).

### 5.2.2 Files with no readable bytes (HS-9465)

- Dropped files are screened for readable content **before** anything is created or uploaded (`src/client/dropFiles.ts::screenDroppedFiles`). Each file's first byte is read (`file.slice(0, 1).arrayBuffer()`); a file that throws — or reports size 0 — is treated as unreadable. Slicing rather than a full `arrayBuffer()` keeps a large attachment out of memory.
- **Why this is needed:** on macOS a fresh screen capture floats in the corner for a few seconds before being written to disk, and can be dragged during that window. The drag carries an `NSFilePromise`, so the browser hands over a `File` with a name, a type and a plausible size but **no backing store**. Nothing about it looks wrong until something reads it — and `fetch` discovered that mid-flight, after the multipart headers were sent, producing a truncated body and a `400 Malformed upload body` (§5.1 / HS-9227). The drop listener was `async` with no `catch`, so the rejection escaped as an unhandled promise rejection and surfaced as the generic §HS-9455 "Something went wrong" crash popup — naming neither the file nor anything the user could do.
- Now: unreadable files produce a named, actionable message ("… has no readable content yet. A screen capture can be dragged from the corner preview before macOS has written it to disk — wait for it to appear on your desktop and drag it again, or press ⌘V to paste it directly"). The ⌘V route (§77) genuinely works for this case, including a capture taken with Ctrl held that never becomes a file at all.
- **Partial success:** a drop mixing saved and unsaved files attaches the saved ones and reports only what was skipped. A drop with nothing readable creates **no ticket** — the check runs before `resolveDropTicketId`, so a failed drag leaves no empty "Attachment" ticket behind.
- The drop listener is wrapped in `try`/`catch`, so any other failure (a failed upload, a failed ticket create) reports as "Could not attach the file" instead of the generic crash popup.
- **Not fixed here:** the unsaved capture still cannot actually be attached by dragging. Resolving an `NSFilePromise` requires native `NSFilePromiseReceiver` work and is possible only in the Tauri build — tracked as HS-9466, gated on first checking whether the drag exposes any readable representation at all.
- Coverage: `src/client/dropFiles.test.ts` (10 unit cases incl. a promised-file fake whose `size` lies) + `e2e/drop-unreadable-file.spec.ts` (3 cases: actionable message not the crash popup, no litter ticket, mixed drop still attaches the good file).

### 5.2.1 Cross-project copy (HS-8739)

- `POST /api/tickets/:id/attachments/copy-from` copies all of a source ticket's non-draft attachments into target ticket `:id`. The target ticket is in the request's (active) project; the body names the source project + ticket: `{ sourceSecret, sourceTicketId }`.
- The server resolves the source project via `getProjectBySecret`, reads its attachment rows from the source DB (`runWithDataDir`), and copies each file (by its absolute `stored_path`) into the target project's `attachments/` dir — bytes never round-trip through the browser. Duplicate target filenames are suffixed; missing source files and draft attachments are skipped.
- Used by cross-project ticket copy/move: the §76 drag (`transferTicketsToProject`) and the §3 clipboard copy/cut/paste (`clipboard.ts::pasteTickets`), via the typed caller `copyTicketAttachments`.

### 5.3 File Serving

- Attached files are served via the API with correct MIME types.
- Supported MIME types: PNG, JPEG, GIF, SVG, WebP, PDF, plain text, markdown, JSON, ZIP, HTML, CSS, JS. All other types are served as `application/octet-stream`.

### 5.4 Reveal in File Manager

- Each attachment has a "Show in Finder" (or equivalent) button.
- Platform-specific behavior:
  - macOS: `open -R` (reveals the file in Finder with selection)
  - Windows: `explorer /select,` (opens Explorer with the file selected)
  - Linux: `xdg-open` on the containing directory
- Uses `execFile` (not `exec`) to prevent command injection.

### 5.5 Attachment Deletion

- Individual attachments can be deleted from the detail panel.
- Deleting an attachment removes both the database record and the file from disk.
- When a ticket is hard-deleted or trash is emptied, all associated attachment files are also removed from disk.

### 5.6 Attachment Cleanup

- The auto-cleanup process (see [3-ticket-management.md](3-ticket-management.md) §3.7) removes attachment files for tickets that are hard-deleted during cleanup.
- **Orphaned-file self-heal (HS-8783).** When an attachment row's `stored_path` file is removed out-of-band (deleted/pruned while the DB row lingers), the startup cleanup sweep (`cleanupOrphanedAttachments` in `src/cleanup.ts`) drops the row — but **only** when its content is also **unrecoverable from the backup store** (no cross-ref blob in any backup manifest), mirroring the manual-reanalyze guard (§43 / `attachmentBackup.ts`). A row whose file is gone but is still captured in a backup is kept. The sweep **skips entirely when the backup root is absent** (e.g. a temporarily-unmounted custom `backupDir`): without a readable store it can't prove non-recoverability, so it never risks a wrongful delete. Relatedly, `buildAttachmentManifest` now emits **one aggregated** "N attachment(s) missing on disk" warning per backup instead of one line per row (HS-8783 — the recurring-noise origin from HS-8778). Tests: `src/cleanup.test.ts` (prune-unrecoverable / keep-recoverable / keep-present-file / skip-when-no-backup-root).

## Non-Functional Requirements

### 5.7 Security

- File paths are never interpolated into shell commands; `execFile` is used with argument arrays to prevent injection.
