# Database Testing

**Risk Level: High**

The database layer (`src/db/queries.ts`, `src/db/connection.ts`) contains the core business logic — status transitions with side effects, filtering with special-case statuses, notes parsing with dual formats, and batch operations. Bugs here can corrupt data or silently produce wrong results.

## Schema & Migrations

**What to test:** Schema initialization is idempotent and migrations add columns safely.

- Fresh `getDb()` creates all tables (tickets, attachments, settings) with correct columns and constraints.
- Calling `initSchema()` multiple times does not fail or duplicate data.
- `ALTER TABLE ADD COLUMN IF NOT EXISTS` migrations succeed on both fresh and existing databases.
- The `ticket_seq` sequence starts at 1 and increments correctly.
- Default settings rows are inserted on first init.
- Foreign key constraint on `attachments.ticket_id` is enforced.

## Ticket Number Generation

**What to test:** Sequence integrity — numbers never repeat, never collide.

- `nextTicketNumber()` returns `HS-1`, `HS-2`, etc. in sequence.
- Numbers are never reused, even after ticket deletion.
- Concurrent calls to `nextTicketNumber()` produce unique values.

## Ticket Creation

**What to test:** Default values and optional overrides.

- Creating a ticket with only a title produces correct defaults (category: issue, priority: default, status: not_started, up_next: false).
- Each optional default (category, priority, status, up_next, details) is applied when provided.
- Empty string values for category/priority/details are treated as "not provided" (use defaults).

## Status Transitions

**What to test:** Every status change triggers the correct side effects on timestamps and flags. This is the highest-risk area in the codebase.

| Transition | Expected Side Effects |
|------------|----------------------|
| → completed | Set `completed_at`, clear `verified_at`, clear `up_next` |
| → verified | Set `verified_at`, set `completed_at` if not already set, clear `up_next` |
| → deleted | Set `deleted_at` |
| → backlog | Clear `up_next`, `completed_at`, `verified_at`, `deleted_at` |
| → archive | Clear `up_next`, `completed_at`, `verified_at`, `deleted_at` |
| → not_started | Clear `completed_at`, `verified_at`, `deleted_at` |
| → started | Clear `completed_at`, `verified_at`, `deleted_at` |

- Transitioning from verified → completed should clear `verified_at` but preserve `completed_at`.
- Transitioning from completed → verified should set `verified_at` and keep existing `completed_at` (COALESCE).
- Every transition sets `updated_at` to current time.

## Notes Parsing & Appending

**What to test:** Dual-format handling — JSON arrays and legacy plain text.

- Appending a note to a ticket with no existing notes creates a JSON array with one entry.
- Appending a note to a ticket with existing JSON notes appends to the array.
- Appending a note to a ticket with legacy plain-text notes wraps the old text as the first entry, then appends the new note.
- Empty string notes are ignored (not appended).
- Each note entry has `text` and `created_at` fields.

## Filtering

**What to test:** All filter combinations, especially the special-case status values.

- `status: 'open'` returns only `not_started` and `started`.
- `status: 'non_verified'` returns `not_started`, `started`, and `completed`.
- `status: 'active'` excludes `deleted`, `backlog`, and `archive`.
- Default (no status filter) behaves like `'active'`.
- Category, priority, and up_next filters work in isolation and combined.
- Search is case-insensitive ILIKE on title, details, and ticket_number.
- Multiple filters combine with AND logic.

## Sorting

**What to test:** Custom sort orders match the expected business logic.

- Priority sort: highest → high → default → low → lowest.
- Status sort: started → not_started → completed → verified → backlog → archive.
- Created sort: uses `created_at` timestamp.
- Ticket number sort: uses `id` (numeric, not string).
- Default sort direction is DESC; ASC reverses correctly.
- Secondary sort is always `id DESC` (stable ordering).

## Batch Operations

**What to test:** All tickets in the batch are updated, and each update triggers correct side effects.

- `batchUpdateTickets` applies the update to every ticket in the ID list.
- `batchDeleteTickets` soft-deletes every ticket in the list.
- A batch status change to `completed` triggers the same side effects as an individual status change (timestamps, up_next clearing).
- If one ticket in a batch doesn't exist (bad ID), the others still succeed.

## Stats & Cleanup Queries

**What to test:** Aggregation accuracy and cleanup threshold logic.

- `getTicketStats()` returns correct counts for total, open, up_next, by_category, and by_status.
- Stats exclude deleted, backlog, and archive from `total`.
- `getTicketsForCleanup()` returns verified tickets older than N days and deleted tickets older than M days.
- Tickets exactly at the threshold boundary are not included (strict inequality).

## Trash Operations

**What to test:** Restore and empty-trash behavior.

- `restoreTicket()` sets status to `not_started` and clears deletion metadata.
- `batchRestoreTickets()` restores all tickets in the list.
- `emptyTrash()` hard-deletes all tickets with status `deleted` and returns their IDs.
- After empty trash, the tickets are gone from the database entirely.
