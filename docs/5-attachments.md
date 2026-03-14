# 5. Attachments

## Functional Requirements

### 5.1 File Upload

- Files can be attached to any ticket via the detail panel.
- Uploaded files are copied to `.hotsheet/attachments/` with a filename of `{ticket_number}_{original_name}.{ext}` (e.g., `HS-42_screenshot.png`).
- The original filename is preserved in the database for display purposes.

### 5.2 File Serving

- Attached files are served via the API with correct MIME types.
- Supported MIME types: PNG, JPEG, GIF, SVG, PDF, plain text, markdown, JSON. All other types are served as `application/octet-stream`.

### 5.3 Reveal in File Manager

- Each attachment has a "Show in Finder" (or equivalent) button.
- Platform-specific behavior:
  - macOS: `open -R` (reveals the file in Finder with selection)
  - Windows: `explorer /select,` (opens Explorer with the file selected)
  - Linux: `xdg-open` on the containing directory
- Uses `execFile` (not `exec`) to prevent command injection.

### 5.4 Attachment Deletion

- Individual attachments can be deleted from the detail panel.
- Deleting an attachment removes both the database record and the file from disk.
- When a ticket is hard-deleted or trash is emptied, all associated attachment files are also removed from disk.

### 5.5 Attachment Cleanup

- The auto-cleanup process (see [3-ticket-management.md](3-ticket-management.md) §3.7) removes attachment files for tickets that are hard-deleted during cleanup.

## Non-Functional Requirements

### 5.6 Security

- File paths are never interpolated into shell commands; `execFile` is used with argument arrays to prevent injection.
