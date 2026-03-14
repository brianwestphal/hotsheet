# API Testing

**Risk Level: High**

The API layer (`src/routes/api.ts`) is the boundary between the client and the database. It handles input parsing, delegates to query functions, triggers markdown sync and change notifications, and manages file I/O for attachments. Incorrect input handling or missing side effects here affect every consumer (UI, AI tools, direct API callers).

## Approach

API tests should use Hono's built-in test client (or direct `app.request()`) against a real PGLite database in a temp directory. This validates the full stack from HTTP request to database response without needing a running server.

## Ticket CRUD

**What to test:** The full lifecycle from creation through deletion and restoration.

- `POST /api/tickets` creates a ticket with an auto-assigned `HS-N` number and returns 201.
- Provided defaults (category, priority, status, up_next, details) are applied.
- `GET /api/tickets/:id` returns the ticket with its attachments array.
- `GET /api/tickets/:id` returns 404 for non-existent tickets.
- `PATCH /api/tickets/:id` updates individual fields (title, details, notes, category, priority, status, up_next).
- `PATCH /api/tickets/:id` returns 404 for non-existent tickets.
- `DELETE /api/tickets/:id` soft-deletes (sets status to deleted).
- `DELETE /api/tickets/:id/hard` permanently removes the ticket and cleans up attachment files from disk.
- `POST /api/tickets/:id/restore` restores a deleted ticket to not_started.

## Filtering & Sorting

**What to test:** Query parameter parsing and correct delegation to the database layer.

- All query parameters are optional; omitting them returns the default filtered/sorted list.
- `status` parameter accepts both standard values (not_started, completed, etc.) and special values (open, non_verified, active).
- `up_next=true` and `up_next=false` are parsed as booleans correctly.
- `search` parameter triggers case-insensitive search.
- `sort_by` and `sort_dir` are passed through correctly.
- Empty string parameters are treated as "not provided."

## Batch Operations

**What to test:** All batch action types with correct dispatch.

- `POST /api/tickets/batch` with `action: 'delete'` soft-deletes all listed IDs.
- `action: 'restore'` restores all listed IDs.
- `action: 'category'` updates category for all IDs to the provided value.
- `action: 'priority'` updates priority for all IDs.
- `action: 'status'` updates status for all IDs (with correct transition side effects).
- `action: 'up_next'` updates up_next flag for all IDs.
- Every batch action triggers markdown sync and change notification.

## Up Next Toggle

**What to test:** Toggle behavior and state correctness.

- `POST /api/tickets/:id/up-next` toggles the up_next flag.
- A ticket that is up_next becomes not up_next, and vice versa.
- Returns the updated ticket.
- Returns 404 for non-existent tickets.

## Attachments

**What to test:** Upload, serving, reveal, and deletion.

- `POST /api/tickets/:id/attachments` accepts a file upload and stores it in the attachments directory.
- The stored filename is `{ticket_number}_{original_name}.{ext}`.
- The response includes the attachment metadata (id, original_filename, stored_path).
- Returns 404 if the ticket doesn't exist.
- `GET /api/attachments/file/*` serves the file with the correct MIME type (png → image/png, etc.).
- Returns 404 for missing files.
- `DELETE /api/attachments/:id` removes the database record and the file from disk.
- `POST /api/attachments/:id/reveal` triggers the OS-specific reveal command.

## Trash

**What to test:** Empty trash with file cleanup.

- `POST /api/trash/empty` hard-deletes all trashed tickets.
- Attachment files for trashed tickets are removed from disk before hard delete.

## Stats

**What to test:** Correct aggregation.

- `GET /api/stats` returns total, open, up_next counts and by_category/by_status breakdowns.
- Counts match the actual database state.

## Settings

**What to test:** Both database and file-based settings.

- `GET /api/settings` returns all key-value pairs from the database.
- `PATCH /api/settings` upserts key-value pairs.
- `GET /api/file-settings` returns the contents of `settings.json` (or empty object if missing).
- `PATCH /api/file-settings` merges into the existing `settings.json`.

## Long-Poll

**What to test:** Version tracking and timeout behavior.

- `GET /api/poll?version=0` returns immediately if changes have occurred (changeVersion > 0).
- `GET /api/poll?version=N` where N equals the current changeVersion waits for a change or times out after 30 seconds.
- A mutation endpoint (create, update, delete) increments changeVersion and resolves waiting pollers.

## Change Notification

**What to test:** Every mutation endpoint triggers both `scheduleAllSync()` and `notifyChange()`.

- This is a cross-cutting concern: any endpoint that modifies data must call both.
- Can be tested by verifying that the poll version increments after each mutation.
