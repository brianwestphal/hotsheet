# 3. Ticket Management

## Functional Requirements

### 3.1 Ticket Properties

Each ticket has the following properties:

- **Ticket number** — Auto-assigned, sequential, prefixed with `HS-` (e.g., HS-1). Never reused.
- **Title** — Short summary (required at creation).
- **Details** — Longer description (optional).
- **Category** — Configurable categories. Each has an id, display label, short label (badge), color, keyboard shortcut, and description. Defaults to a Software Development set (Issue, Bug, Feature, Req Change, Task, Investigation). Users can customize categories or load from presets (Design/Creative, Product Management, Marketing, Personal) via Settings.
  - Categories are stored as JSON in the `settings` table (key: `categories`).
  - API: `GET /api/categories`, `PUT /api/categories`, `GET /api/category-presets`.
- **Priority** — One of five levels: Highest, High, Default, Low, Lowest.
- **Status** — One of seven states (see §3.3).
- **Up Next** — Boolean flag marking the ticket as a priority work item.
- **Tags** — User-defined tags stored as a JSON array of normalized strings in the `tags` column (default `[]`). The full list of available tags is derived from all non-deleted tickets.
  - **Normalization**: All tags are normalized on input — non-alphanumeric character runs are collapsed to a single space, leading/trailing whitespace is trimmed, and the result is stored in lowercase. Example: `"  This  is --- a TAG  "` → `"this is a tag"`.
  - **Display**: Tags are rendered in Title Case everywhere (chips, autocomplete, markdown sync). Example: `"this is a tag"` → `"This Is A Tag"`.
  - **Deduplication**: Case-insensitive — `"Admin"` and `"admin"` are treated as the same tag.
  - **Bracket syntax**: Ticket titles can include `[tag]` patterns during creation. Tags are extracted, normalized, and removed from the title. Example: `"[admin] fix the dashboard [urgent]"` creates a ticket with title `"fix the dashboard"` and tags `["admin", "urgent"]`. Multiple brackets and spacing around brackets are handled.
  - Detail panel: displays tags as removable chips with an input to add new tags by pressing Enter. Autocomplete shows first 100 tags on focus, filters as the user types.
  - Batch toolbar "..." menu: "Tags..." opens a dialog with check/uncheck/mixed-state checkboxes for all known tags. Mixed state means some selected tickets have the tag and others don't — mixed tags are left unchanged on save.
  - API: `GET /api/tags` returns all unique normalized tags, ticket PATCH accepts `tags` (JSON string), ticket POST accepts `tags` in defaults.
- **Notes** — Timestamped entries stored as a JSON array. Each note has a unique ID, text, and created_at timestamp. Notes can be added, edited, and deleted.
- **Timestamps** — created_at, updated_at, completed_at, verified_at, deleted_at.

### 3.2 CRUD Operations

- **Create** — Provide a title; category, priority, status, up_next, and details are optional with sensible defaults (category: issue, priority: default, status: not_started, up_next: false).
- **Read** — Retrieve a single ticket (with attachments) or a filtered list.
- **Update** — Any property can be updated individually or in combination. Updates set `updated_at` to the current time.
- **Soft Delete** — Sets status to `deleted` and records `deleted_at`. The ticket remains in the database and can be restored.
- **Hard Delete** — Permanently removes the ticket record and cleans up associated attachment files from disk.
- **Restore** — Returns a deleted ticket to `not_started` status, clearing deletion metadata.
- **Copy / Cut / Paste** — Tickets can be copied or cut and pasted within or across projects. Paste creates new tickets with new numbers, copying title, details, category, priority, status, up_next, tags, and notes. Title deduplication appends " (Copy)", " (Copy 2)", etc. when a matching title exists. Cut deletes the originals after a successful paste. See [4-user-interface.md](4-user-interface.md) §4.12 for full details.

### 3.3 Status Lifecycle

Tickets progress through these statuses:

| Status | Icon | Description |
|--------|------|-------------|
| Not Started | ○ | Initial state |
| Started | ◔ | Work in progress |
| Completed | ✓ | Work finished, awaiting verification |
| Verified | ✓✓ | Verified by a human |
| Backlog | □ | Parked for later — excluded from main views, never auto-cleared |
| Archive | ■ | Archived — excluded from main views, never auto-cleared |
| Deleted | — | Soft-deleted, in trash |

#### Status Transition Rules

- **→ Completed**: Sets `completed_at`, clears `verified_at`, clears `up_next`.
- **→ Verified**: Sets `verified_at`, sets `completed_at` if not already set, clears `up_next`.
- **→ Deleted**: Sets `deleted_at`.
- **→ Backlog or Archive**: Clears `up_next` and `deleted_at`. Preserves `completed_at` and `verified_at` (the ticket's completion history is retained).
- **→ Not Started or Started**: Clears `completed_at`, `verified_at`, `deleted_at`.

### 3.4 Up Next

- Tickets flagged as `up_next` appear in the Up Next view and are exported to `worklist.md` for AI tool consumption.
- Toggling up_next on a completed or verified ticket automatically reopens it (sets status to `not_started`).
- Moving a ticket to completed, verified, backlog, or archive automatically clears `up_next`.

### 3.5 Notes

- Each note is a `{ id, text, created_at }` entry stored in a JSON array in the `notes` column.
- Note IDs are auto-generated server-side (`n_<timestamp>_<counter>`). Legacy notes without IDs get auto-assigned on read.
- **Add**: Via the + button in the detail panel — appends an empty note, scrolls it into view, and immediately puts it into edit mode with the textarea focused. Empty/unfocused notes render with muted placeholder text. Tickets can also be appended to via the ticket PATCH `notes` field (append-only, for AI tool compatibility).
- **Edit**: Click a note in the detail panel to inline-edit. Saves on blur or Cmd+Enter. API: `PATCH /api/tickets/:id/notes/:noteId`.
- **Delete**: Right-click a note for "Delete Note" context menu. API: `DELETE /api/tickets/:id/notes/:noteId`.
- **Bulk replace**: `PUT /api/tickets/:id/notes-bulk` replaces the entire notes array (used by undo system).
- All note operations are tracked in the undo stack.
- Notes are displayed in the detail panel and included in markdown exports.

### 3.6 Batch Operations

- Multiple tickets can be selected and acted on simultaneously.
- Supported batch actions: change category, change priority, change status, toggle up_next, delete.
- Batch restore of deleted tickets.
- Batch up_next toggle uses smart logic: if any selected ticket is NOT up_next, set all to true; otherwise set all to false.
- Batch up_next on completed/verified tickets re-opens them first.

### 3.7 Auto-Cleanup

- On startup, the application runs cleanup for stale tickets:
  - Tickets in `deleted` status older than a configurable threshold (default: 3 days) are hard-deleted.
  - Tickets in `verified` status older than a configurable threshold (default: 30 days) are hard-deleted.
- Cleanup also removes orphaned attachment files from disk.
- Cleanup thresholds are configurable via settings.

### 3.8 Trash Management

- Deleted tickets appear in a Trash view.
- Individual tickets can be restored from trash.
- "Empty Trash" hard-deletes all trashed tickets and their attachment files.
