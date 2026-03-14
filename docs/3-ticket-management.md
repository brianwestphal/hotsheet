# 3. Ticket Management

## Functional Requirements

### 3.1 Ticket Properties

Each ticket has the following properties:

- **Ticket number** — Auto-assigned, sequential, prefixed with `HS-` (e.g., HS-1). Never reused.
- **Title** — Short summary (required at creation).
- **Details** — Longer description (optional).
- **Category** — One of six types:
  - Issue (grey) — General issues that need attention
  - Bug (red) — Bugs that should be fixed in the codebase
  - Feature (green) — New features to be implemented
  - Requirement Change (orange) — Changes to existing requirements
  - Task (blue) — General tasks to complete
  - Investigation (purple) — Items requiring research or analysis
- **Priority** — One of five levels: Highest, High, Default, Low, Lowest.
- **Status** — One of seven states (see 2.3).
- **Up Next** — Boolean flag marking the ticket as a priority work item.
- **Notes** — Append-only timestamped entries stored as a JSON array.
- **Timestamps** — created_at, updated_at, completed_at, verified_at, deleted_at.

### 3.2 CRUD Operations

- **Create** — Provide a title; category, priority, status, up_next, and details are optional with sensible defaults (category: issue, priority: default, status: not_started, up_next: false).
- **Read** — Retrieve a single ticket (with attachments) or a filtered list.
- **Update** — Any property can be updated individually or in combination. Updates set `updated_at` to the current time.
- **Soft Delete** — Sets status to `deleted` and records `deleted_at`. The ticket remains in the database and can be restored.
- **Hard Delete** — Permanently removes the ticket record and cleans up associated attachment files from disk.
- **Restore** — Returns a deleted ticket to `not_started` status, clearing deletion metadata.

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
- **→ Backlog or Archive**: Clears `up_next`, `completed_at`, `verified_at`, `deleted_at`.
- **→ Not Started or Started**: Clears `completed_at`, `verified_at`, `deleted_at`.

### 3.4 Up Next

- Tickets flagged as `up_next` appear in the Up Next view and are exported to `worklist.md` for AI tool consumption.
- Toggling up_next on a completed or verified ticket automatically reopens it (sets status to `not_started`).
- Moving a ticket to completed, verified, backlog, or archive automatically clears `up_next`.

### 3.5 Notes

- Notes are append-only: each note is a timestamped `{ text, created_at }` entry added to a JSON array.
- Legacy plain-text notes (from before the JSON format) are transparently wrapped as a single entry.
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
