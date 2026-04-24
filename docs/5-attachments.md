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
- If the drop lands outside any row / card, the pre-existing behaviour applies — attach to the single selected ticket, else create a new "Attachment" ticket (or use the draft-input value as the title if set) and attach to it.
- Trashed rows (`.trash-row`) are deliberately excluded as drop targets — attachments on trashed tickets would be silently removed by the next auto-cleanup sweep.
- Only activates when `Files` are present in the drag data. The column-view ticket-reorder drag carries `text/plain` instead of `Files`, so its own `.column-drop-target` highlight (reorder-by-status) and the HS-7492 file-drop highlight are mutually exclusive — a reorder drag never lights up a file-drop target, and a file drag never lights up the whole column.
- Playwright e2e coverage in `e2e/ticket-row-drop.spec.ts`: (1) select ticket B, dispatch a synthetic file drop on ticket A's row, assert the attachment lands on A and NOT on B; (2) drop outside any row with no selection creates a new "Attachment" ticket with the file (fallback regression).

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

## Non-Functional Requirements

### 5.7 Security

- File paths are never interpolated into shell commands; `execFile` is used with argument arrays to prevent injection.
