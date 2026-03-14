# Client-Side Testing

**Risk Level: Medium**

Client-side logic lives in `src/client/`. While much of it is DOM manipulation (hard to unit test without a browser), several areas contain meaningful business logic worth testing.

## State Helpers

**What to test:** Display functions return correct values for all enum members.

- `getCategoryColor()` returns the correct hex color for each of the 6 categories.
- `getCategoryLabel()` returns the correct 3-letter abbreviation (ISS, BUG, FEA, REQ, TSK, INV).
- `getPriorityIcon()` returns the correct symbol for each of the 5 priorities.
- `getStatusIcon()` returns the correct symbol for each status.
- These are pure functions with no DOM dependency — straightforward to unit test.

## Keyboard Shortcuts

**What to test:** Shortcut actions produce the correct API calls and state changes.

- Cmd/Ctrl+A selects all visible tickets (populates `state.selectedIds`).
- Cmd/Ctrl+D on selected tickets toggles up_next with smart logic (any not up_next → set all true; all up_next → set all false).
- Cmd/Ctrl+D on completed/verified tickets re-opens them (status → not_started) before setting up_next.
- Cmd/Ctrl+C copies selected ticket(s) to clipboard in the expected format: `HS-N: Title\n\nDetails\n\n- Note 1\n- Note 2`.
- Cmd/Ctrl+C does not override native copy when text is selected or cursor is in an input field (unless Alt is held).
- Escape clears selection when tickets are selected.
- Escape closes the settings dialog when it is open.
- N (outside input fields) focuses the draft input.

## Batch Operations

**What to test:** Correct API calls and UI state updates.

- Batch category/priority/status changes call the batch API with the correct action and value.
- Batch up_next toggle uses the same smart logic as Cmd/Ctrl+D.
- Batch delete calls the batch API with action 'delete'.
- The select-all checkbox toggles all visible ticket IDs in `state.selectedIds`.
- After a batch operation, the ticket list is reloaded.

## Clipboard Formatting

**What to test:** `formatTicketForClipboard()` produces correct output.

- A ticket with only a title produces `HS-N: Title`.
- A ticket with details adds a blank line then the details.
- A ticket with notes adds a blank line then each note as `- Note text`.
- Multiple selected tickets are separated by blank lines.

## Long-Poll

**What to test:** Reconnection and version tracking behavior.

- When `pollVersion` is less than the server's version, tickets are reloaded immediately.
- When the server is unreachable, a 5-second delay is applied before retrying.
- Polling does not trigger reloads during backup preview mode.

## Ticket List Rendering

**What to test:** View switching and scroll preservation.

- `canUseColumnView()` returns false for single-status views (completed, verified, trash, backlog, archive).
- Scroll position in the list container is preserved across re-renders.
- Per-column scroll positions are preserved in column view.
- Draft row appears in list view but not in trash, backup preview, or column view.
- New tickets created in a category/priority view inherit defaults from that view context.

## Detail Panel

**What to test:** Editing behavior and read-only mode.

- Opening a ticket loads its full data including attachments and notes.
- Title and details auto-save on input with debounce.
- Dropdowns (category, priority, status) save immediately on change.
- Up Next checkbox triggers re-open logic for completed/verified tickets.
- During backup preview, all fields are read-only.
- Resize handles correctly constrain minimum and maximum panel dimensions.

## Drag-and-Drop

**What to test:** Drop targets and action mapping.

- Dragging tickets to sidebar status views applies the correct status change.
- Dragging to category views changes category.
- Dragging to priority views changes priority.
- Dragging to the Up Next view sets up_next to true.
- Dragging to Trash soft-deletes the tickets.
- The `draggedTicketIds` set contains the correct IDs (selected tickets, or just the dragged ticket if none selected).

## Testing Approach

Most client tests require a DOM. Options:

1. **Pure logic tests** (no DOM) — state helpers, clipboard formatting, `canUseColumnView()`. These can run in Vitest directly.
2. **DOM tests** — Use happy-dom or jsdom with Vitest for rendering tests. The custom JSX runtime (`toElement()`) works with any DOM implementation.
3. **E2E tests** (future) — Playwright against a running server for full integration testing of keyboard shortcuts, drag-drop, and visual behavior. This is lower priority than server-side tests.
