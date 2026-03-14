# 4. User Interface

## Functional Requirements

### 4.1 Layout

The interface is divided into:

- **Header** — App title, search, layout toggle, sort controls, detail position toggle, settings button.
- **Sidebar** — Navigation with status views, category filters, priority filters, stats.
- **Main Content** — Ticket list or column view.
- **Detail Panel** — Side or bottom panel showing full ticket details.
- **Footer** — Keyboard shortcut hints and status bar.
- **Banners** — Contextual banners for skills notifications, update availability, and backup previews.

### 4.2 List View

- Default view: a flat bullet-list of tickets.
- Each row displays: checkbox, category badge (3-letter color-coded abbreviation), ticket number, priority icon, status icon, up_next star, and title.
- Clicking a ticket opens it in the detail panel.
- Scroll position is preserved when the list re-renders (e.g., after data updates).

### 4.3 Column View (Kanban)

- Tickets displayed in status-based columns (Not Started, Started, Completed, Verified).
- Drag-and-drop cards between columns to change status.
- Column headers show ticket count.
- Cards display category badge, ticket number, priority, up_next star, and title.
- Per-column scroll position is preserved across re-renders.
- Available for views: All, Up Next, Open, Non-Verified.
- Not available for: Completed, Verified, Trash, Backlog, Archive (single-status views).

### 4.4 Draft Row (Quick Entry)

- A quick-entry row at the top of the list view for creating new tickets.
- Visible in list view only (not in trash, backup preview, or column view).
- Press Enter to create the ticket and immediately focus a new draft row.
- Category and priority can be set inline via dropdown or keyboard shortcut.
- New tickets inherit sensible defaults from the current view context (e.g., creating in the Bug category view defaults to bug category).

### 4.5 Detail Panel

- Opens when a ticket is clicked; shows full ticket details.
- **Position**: Side (default) or bottom, toggled via header button. Preference is persisted.
- **Resizable**: Drag the resize handle to adjust panel width (side) or height (bottom). Size is persisted.
- **Editable fields**:
  - Title (text input, auto-saves with 300ms debounce)
  - Details (textarea, auto-saves with 300ms debounce)
  - Category, Priority, Status (dropdowns, save immediately on change)
  - Up Next (checkbox, with smart re-opening logic for completed/verified tickets)
- **Notes display**: Timestamped entries in reverse chronological order, formatted per user locale.
- **Metadata**: Created, updated, completed, and verified timestamps.
- **Attachments**: List of attached files with upload, reveal-in-finder, and delete actions.
- **Read-only mode**: During backup preview, all editing is disabled.

### 4.6 Sidebar Navigation

#### Status Views
- All Tickets — Active tickets (excludes deleted, backlog, archive)
- Non-Verified — Not started + started + completed
- Up Next — Tickets flagged as priority items, sorted by priority
- Open — Not started + started
- Completed — Completed tickets only
- Verified — Verified tickets only
- (divider)
- Backlog — Backlog tickets
- Archive — Archived tickets
- Trash — Deleted tickets with restore/empty options

#### Category Filters
- Six category items with color-coded dot indicators.
- Click to filter the list to a single category.

#### Priority Filters
- Five priority items.
- Click to filter the list to a single priority level.

#### Drag-and-Drop Targets
- Sidebar items for status, category, and priority views accept dropped tickets.
- Dropping changes the ticket's corresponding property (e.g., dropping on "Bug" changes category to bug).
- Drop targets highlight visually on dragover.

#### Stats Bar
- Displays "X tickets, Y open, Z up next" at the bottom of the sidebar.

### 4.7 Search

- Text search across ticket title, details, and ticket number (case-insensitive).
- Input debounced at 200ms.
- Escape key clears the search field.
- Cmd/Ctrl+F focuses the search input.

### 4.8 Sort Controls

- Dropdown to sort by: Created (default), Priority, Category, Status.
- Sort direction: ascending or descending.
- Sort preference is persisted to settings.

### 4.9 Batch Toolbar

- Appears when one or more tickets are selected.
- Controls: category dropdown, priority dropdown, status dropdown, up_next toggle, delete button, select-all checkbox, selection count.
- Dropdowns and buttons are disabled until at least one ticket is selected.

### 4.10 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| N (or Cmd/Ctrl+N) | Focus draft input to create a new ticket |
| Cmd/Ctrl+F | Focus search input |
| Cmd/Ctrl+A | Select all visible tickets |
| Cmd/Ctrl+D | Toggle up_next for selected tickets |
| Cmd/Ctrl+C | Copy selected ticket(s) to clipboard (formatted text) |
| Cmd/Ctrl+Alt+C | Force ticket copy even when in a text field |
| Escape | Close settings dialog, or deselect all tickets |

#### Draft Row Shortcuts (when focused)
| Key | Action |
|-----|--------|
| I | Set category to Issue |
| B | Set category to Bug |
| F | Set category to Feature |
| R | Set category to Requirement Change |
| K | Set category to Task |
| G | Set category to Investigation |
| Alt+1 | Set priority to Highest |
| Alt+2 | Set priority to High |
| Alt+3 | Set priority to Default |
| Alt+4 | Set priority to Low |
| Alt+5 | Set priority to Lowest |

### 4.11 Clipboard Copy

- Cmd/Ctrl+C copies selected tickets as formatted plain text.
- Format: `HS-N: Title`, followed by details and notes (if present).
- Multiple tickets separated by blank lines.
- Respects native text selection in input fields (unless Alt/Option is held).

### 4.12 Settings Dialog

- Opened via the gear icon in the header.
- Fields:
  - App name (file-based setting, updates title bar and document title)
  - Auto-clear trash after N days (default: 3)
  - Auto-clear verified after N days (default: 30)
- Backup section (see [7-backup-restore.md](7-backup-restore.md))
- Software Updates section (Tauri desktop app only): "Check for Updates" button with status feedback.
- Closed via X button, clicking the overlay, or pressing Escape.

### 4.13 Live Updates

- The UI uses long-polling to detect data changes.
- When a change is detected (from another tab, API call, or AI tool), the ticket list automatically refreshes.
- Poll timeout: 30 seconds; retry on connection error after 5 seconds.
- Polling pauses during backup preview.

### 4.14 Error Handling

- Network errors display a popup notification to the user.
- API failures are surfaced (not silently swallowed) in the UI.

## Non-Functional Requirements

### 4.15 Performance

- Scroll position is preserved across data-driven re-renders in both list and column views.
- Input debouncing (200-800ms depending on field) prevents excessive API calls.
- Long-poll minimizes unnecessary network traffic compared to interval polling.

### 4.16 Responsiveness

- Minimum window size: 800x500.
- Detail panel is resizable in both orientations.
- Column view scrolls horizontally when needed.
