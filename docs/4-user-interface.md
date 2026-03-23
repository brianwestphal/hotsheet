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
| Cmd/Ctrl+Z | Undo last change |
| Cmd/Ctrl+Shift+Z | Redo last undone change |
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
- Uses a tabbed layout with Lucide icons and labels for each section:
  - **General** (SlidersHorizontal icon) — App name, auto-clear trash/verified days.
  - **Categories** (Tag icon) — Category management with inline editing and preset selector (see [3-ticket-management.md](3-ticket-management.md) §3.1).
  - **Backups** (HardDrive icon) — Backup location, backup list (see [7-backup-restore.md](7-backup-restore.md)).
  - **Updates** (Download icon) — Software updates, shown only in the Tauri desktop app.
- Tabs persist their selection while the dialog is open; resets to General when reopened.
- Closed via X button, clicking the overlay, or pressing Escape.

### 4.13 Custom Views

- Users can create custom views with live-updating queries.
- Custom views appear in a "Custom Views" sidebar section below priorities.
- The "+" button in the section header opens the view editor.
- Right-click a custom view for Edit/Delete options.
- **View editor dialog:**
  - Name field for the view.
  - "All of" / "Any of" logic toggle (AND vs OR).
  - List of conditions, each with: field selector, operator selector, value input/selector.
  - Supported fields: Category, Priority, Status, Title, Details, Up Next, Tags.
  - Operators vary by field type: equals/not equals (select fields), contains/not contains (text fields).
  - Add/remove conditions dynamically.
- Custom views are stored as JSON in the settings table (key: `custom_views`).
- API: `POST /api/tickets/query` accepts `{ logic, conditions, sort_by, sort_dir }` and returns matching tickets via parameterized SQL.
- Custom views support both list and column layouts.

### 4.14 Dashboard

- **Sidebar widget**: Always-visible compact widget below the stats bar showing a 7-day throughput spark chart, weekly completion count with trend arrow, and WIP count. Clicking it opens the full dashboard.
- **Full dashboard view**: Replaces the ticket list with an analytics page containing:
  - **Time range toggle**: 7, 30, or 90 days
  - **KPI cards** (top row): Completed this week (with % change), Median cycle time, In progress (WIP), Completed/Created ratio
  - **Throughput chart**: Bar chart of completions per day over the selected period
  - **Created vs Completed**: Dual-line chart showing inflow vs outflow
  - **Cumulative Flow Diagram**: Stacked area chart by status (not_started, started, completed, verified) — the gold standard for continuous workflows
  - **Category Breakdown**: Donut chart of open tickets by category
  - **Cycle Time Scatter**: Dot plot with 50th/85th percentile lines
- Charts rendered as inline SVG (no external library).
- Historical data stored in `stats_snapshots` table (daily status counts). Backfilled from ticket history on server start.
- API: `GET /api/dashboard?days=30`

### 4.15 Live Updates

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

### 4.16 Undo / Redo

- **Cmd/Ctrl+Z** undoes the last change; **Cmd/Ctrl+Shift+Z** redoes.
- Works globally, including when focused in text input fields.
- **Supported operations**: field changes (category, priority, status, up_next, title, details), ticket deletion, trash restore, batch operations (bulk field changes, bulk delete), drag-and-drop (sidebar drops, column drops).
- **Not supported**: ticket creation, file attachments, settings changes.
- **Text field coalescing**: Rapid edits to the same text field (title or details) are merged into a single undo step. A new undo entry is created every 5 seconds of continuous editing (rate limit, not debounce).
- **Stack depth**: Maximum 1000 entries. Oldest entries are discarded when the limit is exceeded.
- **In-memory only**: The undo stack is not persisted across page reloads.
- Any new change clears the redo stack (standard undo/redo behavior).
- Pending debounced saves are cancelled when undo/redo is triggered.

### 4.17 Responsiveness

- Minimum window size: 800x500.
- Detail panel is resizable in both orientations.
- Column view scrolls horizontally when needed.
