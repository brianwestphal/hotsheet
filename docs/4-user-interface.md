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

### 4.2 Project Tabs

- A tab bar appears above the main content when 2 or more projects are registered in the instance. Hidden for a single project.
- Clicking a tab name switches the active project, reloading all data (tickets, settings, views).
- Each project has independent settings (detail position, sort, etc.) that are restored on switch.
- The active sidebar view (All, Up Next, category filter, custom view, etc.) is remembered per project and restored on switch. If a saved view references a custom view that doesn't exist in the target project, it falls back to "All".
- The segmented controls (layout toggle, detail position toggle) update to reflect the switched project's saved settings.
- Right-click on a tab shows a context menu with:
  - Close Tab, Close Other Tabs, Close Tabs to the Left, Close Tabs to the Right (disabled when not applicable).
  - A separator, then "Show in Finder" with a folder icon. Opens the project's root folder (parent of `.hotsheet/`) using the OS file manager.
- Keyboard shortcuts for tab management:
  - Cmd/Ctrl+Shift+[ or ] — Switch to previous/next tab (works even in text fields).
  - Cmd/Ctrl+Shift+Arrow Left/Right — Switch to previous/next tab (ignored when focus is in a text field, to preserve native text selection). When focus is inside an embedded terminal, this shortcut cycles terminal tabs instead — hold Alt/Option to force project-tab navigation. See [22-terminal.md §22.18](22-terminal.md).
  - Cmd/Ctrl+Alt+W — Close active tab.
- Tabs can be reordered by drag-and-drop. A drop indicator shows the insertion point. Order is persisted to the server.
- Tab order is preserved across restarts. New projects are appended to the end of the tab bar. Re-opening an existing project does not reorder tabs.

### 4.3 List View

- Default view: a flat bullet-list of tickets.
- Each row displays: checkbox, category badge (3-letter color-coded abbreviation), ticket number, status icon, sync icon (if synced), unread dot (if unread), title, priority icon, and up_next star.
- **Unread indicator**: A blue dot (6px, `#3b82f6`) appears before the title when a ticket has been updated since the user last read it (`updated_at > last_read_at`). Tickets are automatically marked as read when opened in the detail panel. Users can manually mark tickets as read/unread via the context menu.
- Clicking a ticket opens it in the detail panel.
- Completed and verified ticket titles are displayed with strikethrough styling and muted text color.
- Scroll position is preserved when the list re-renders (e.g., after data updates).

### 4.4 Column View (Kanban)

- Tickets displayed in status-based columns (Not Started, Started, Completed, Verified).
- Drag-and-drop cards between columns to change status.
- Column headers show ticket count. Clicking a column header selects all tickets in that column (or deselects all if every ticket is already selected).
- Cards display category badge, ticket number, priority, up_next star, title, and tags (if any, shown as small pills below the title).
- Completed and verified ticket titles are displayed with strikethrough styling and muted text color.
- Per-column scroll position is preserved across re-renders.
- Available for views: All, Up Next, Open, Non-Verified.
- Not available for: Completed, Verified, Trash, Backlog, Archive (single-status views).
- Tickets with unrecognized status values (e.g., from external tools or schema changes) are displayed in the first column rather than silently dropped.

### 4.5 Draft Row (Quick Entry)

- A quick-entry row at the top of the list view for creating new tickets.
- Visible in both list and column views (not in trash or backup preview).
- Press Enter to create the ticket and immediately focus a new draft row.
- Category and priority can be set inline via dropdown or keyboard shortcut.
- New tickets inherit sensible defaults from the current view context (e.g., creating in the Bug category view defaults to bug category).

### 4.6 Detail Panel

- Opens when a ticket is clicked; shows full ticket details.
- **Position**: Side (default) or bottom, toggled via header button. The segmented control shows bottom first, then side. Preference is persisted. Clicking the already-active position segment hides the panel; clicking a different segment shows it in that position. The `detail_visible` setting is persisted so the panel stays hidden across page reloads.
- **Resizable**: Drag the resize handle to adjust panel width (side) or height (bottom). Size is persisted.
- **Editable fields**:
  - Title (text input, auto-saves with 300ms debounce)
  - Details (textarea, auto-saves with 300ms debounce)
  - Category, Priority, Status (dropdowns, save immediately on change)
  - Up Next (checkbox, with smart re-opening logic for completed/verified tickets)
- **Notes display**: Timestamped entries rendered as Markdown via `marked`. Empty notes show muted placeholder text. Notes containing images from remote plugins (GitHub) are proxied through the server for private repo auth, and render clickable download links below the note content (web: blob download; Tauri: opens in system browser).
- **Metadata**: Created, updated, completed, and verified timestamps.
- **Attachments**: List of attached files with upload, reveal-in-finder, and delete actions.
- **Read-only mode**: During backup preview, all editing is disabled.

### 4.7 Sidebar Navigation

#### Status Views

Each built-in view has an icon to the left of the label:

- All Tickets (Lucide list icon) — Active tickets (excludes deleted, backlog, archive)
- Non-Verified (◔ half-circle icon) — Not started + started + completed
- Up Next (★ star icon) — Tickets flagged as priority items, sorted by priority
- Open (○ circle icon) — Not started + started
- Completed (✓ check icon) — Completed tickets only
- Verified (✓✓ double-check icon) — Verified tickets only
- (divider)
- Backlog (Lucide calendar icon) — Backlog tickets
- Archive (Lucide archive icon) — Archived tickets
- Trash (Lucide trash icon) — Deleted tickets with restore/empty options

#### Category Filters
- Six category items with color-coded dot indicators.
- Click to filter the list to a single category.

#### Priority Filters
- Five priority items, each with a colored Lucide icon: chevrons-up (red), chevron-up (orange), chevrons-up-down (gray), chevron-down (blue), chevrons-down (slate).
- Click to filter the list to a single priority level.

#### Drag-and-Drop Targets
- Sidebar items for status, category, and priority views accept dropped tickets.
- Dropping changes the ticket's corresponding property (e.g., dropping on "Bug" changes category to bug).
- Drop targets highlight visually on dragover.

#### Stats Bar
- Displays "X tickets, Y open, Z up next" at the bottom of the sidebar.

### 4.8 Search

- Pill-shaped search input with a Lucide search icon, right-aligned in the toolbar.
- Default width 200px; animates to 50vw on focus (0.3s ease transition), shrinks back on blur.
- Text search across ticket title, details, ticket number, tags, and notes/comments (case-insensitive). Notes (HS-7364) are stored as a JSON-serialized array in the `notes` column, so ILIKE matches against the serialized text inline — this means queries collide with JSON structural substrings (`text`, `id`, `created_at`, ISO timestamp fragments), but typical content searches work correctly.
- Input debounced at 200ms.
- Escape key blurs the field without clearing its value or deselecting tickets (HS-7393). Previously Esc cleared the query AND deselected tickets (because the Esc also bubbled to the global handler in `shortcuts.tsx`); both are now gone in favor of a plain blur, matching what users expect from browser Find bars. The explicit clear button (below) remains the single one-click-clear path.
- Cmd/Ctrl+F focuses the search input. **HS-7331:** when a terminal is focused, Cmd/Ctrl+F routes to the terminal's in-pane search widget instead — see [34-terminal-search.md](34-terminal-search.md) §34.4. Falls through to this input when no terminal is focused or no terminal search widget is mounted.
- **Clear button (HS-7360).** A Lucide `circle-x` button sits inside the pill's right padding; it is hidden until the query has content (`.search-box.has-value .search-clear-btn` reveals it). Click clears the input, clears `state.search`, reloads tickets, and returns focus to the input — same code path as pressing Escape.
- **Per-project state (HS-7360).** The input's text is remembered per project in an in-memory Map keyed by project secret (`projectSearches` in `state.tsx`; mirrors the existing `projectViews` Map). Switching projects saves the current project's query and restores the destination project's saved query (fresh projects start empty). `syncSearchInputFromState()` (exported from `sidebar.tsx`) is called from `reloadAppState()` to write the restored query back into the DOM input and toggle `.has-value` so the pill stays expanded while a query is live. Session-only — not persisted across app launches. `clearPerProjectSessionState(secret)` in `state.tsx` wipes both view and search when a project is removed.

### 4.9 Sort Controls

- Dropdown to sort by: Created (default), Priority, Category, Status.
- Sort direction: ascending or descending.
- Sort preference is persisted to settings.

### 4.10 Batch Toolbar

- Appears when one or more tickets are selected.
- Controls: category dropdown, priority dropdown, status dropdown, up_next toggle, delete button, more menu (Tags, Duplicate), select-all checkbox, selection count.
- Dropdowns and buttons are disabled until at least one ticket is selected.

### 4.11 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl+Z | Undo last change |
| Cmd/Ctrl+Shift+Z | Redo last undone change |
| N (or Cmd/Ctrl+N) | Focus draft input to create a new ticket |
| Cmd/Ctrl+F | Focus search input |
| Cmd/Ctrl+A | Select all visible tickets |
| Cmd/Ctrl+D | Toggle up_next for selected tickets |
| Cmd/Ctrl+C | Copy selected ticket(s) to clipboard (formatted text + internal structured data) |
| Cmd/Ctrl+X | Cut selected ticket(s) (copy + delete on paste) |
| Cmd/Ctrl+V | Paste tickets from internal clipboard (creates new tickets) |
| Cmd/Ctrl+Alt+C | Force ticket copy even when in a text field |
| Escape | Close settings dialog, or deselect all tickets |

### 4.12 Clipboard Copy, Cut & Paste

- **Cmd/Ctrl+C** copies selected tickets as formatted plain text to the system clipboard AND stores full structured ticket data in an internal clipboard for cross-project paste.
- Format: `HS-N: Title`, followed by details and notes (if present).
- Multiple tickets separated by blank lines.
- Respects native text selection in input fields (unless Alt/Option is held).
- **Cmd/Ctrl+X** cuts selected tickets: same as copy but marks tickets for deletion on paste. Originals are deleted only after a successful paste. Cut tickets are visually distinguished with reduced opacity; in column view, cut cards also use a dashed border.
- **Cmd/Ctrl+V** pastes tickets from the internal clipboard into the current project:
  - Creates new tickets with new ticket numbers.
  - Copies title, details, category, priority, status, up_next, tags, and notes.
  - Title deduplication: if a ticket with the same title exists, appends " (Copy)", " (Copy 2)", etc.
  - Deleted tickets are pasted as "not_started".
  - After paste, newly created tickets are selected.
  - Works across projects (copy in one project tab, paste in another).
  - Only activates when not focused on an input field and the internal clipboard has tickets.

### 4.13 Settings Dialog

- Opened via the gear icon in the header.
- Uses a tabbed layout with Lucide icons and labels for each section:
  - **General** (SlidersHorizontal icon) — Project name, auto-clear trash/verified days, "Hide Verified column" checkbox (hides the Verified column in column view; verified tickets appear in the Completed column instead).
  - **Categories** (Tag icon) — Category management with inline editing and preset selector (see [3-ticket-management.md](3-ticket-management.md) §3.1).
  - **Backups** (HardDrive icon) — Backup location, backup list (see [7-backup-restore.md](7-backup-restore.md)).
  - **Context** (FileText icon) — Auto-context configuration for categories and tags (see §4.18).
  - **Plugins** (Plug icon) — Plugin management, configuration, sync controls, and conflict resolution (see [18-plugins.md](18-plugins.md) §18.10).
  - **Experimental** (Flask icon) — Claude Channel integration and custom commands (see [12-claude-channel.md](12-claude-channel.md)).
  - **Updates** (Download icon) — Software updates, shown only in the Tauri desktop app.
- Tabs persist their selection while the dialog is open; resets to General when reopened.
- Closed via X button, clicking the overlay, or pressing Escape.

### 4.14 Custom Views

- Users can create custom views with live-updating queries.
- Custom views appear within the Views sidebar section, after the main status views (separated by a divider, before Backlog/Archive/Trash).
- The "+" button in the section header opens the view editor.
- Right-click a custom view for Edit/Delete options.
- **View editor dialog:**
  - Name field for the view.
  - Optional **Tag** field with autocomplete. An info button explains: associating a tag shows a tag icon in the sidebar and enables dropping tickets onto the view to add the tag.
  - **Include archived tickets** checkbox (unchecked by default). When checked, archived tickets are included in results and an "Archived" column appears in column view.
  - "All of" / "Any of" logic toggle (AND vs OR).
  - List of conditions, each with: field selector, operator selector, value input/selector.
  - Supported fields: Category, Priority, Status, Title, Details, Up Next, Tags.
  - Operators vary by field type: `select` fields use equals/not_equals; `ordinal` fields (Priority, Status) use equals/not_equals/lt/lte/gt/gte; `text` fields use contains/not_contains; `boolean` fields (Up Next) use equals only.
  - Tags field values in the rules editor have autocomplete from existing tags.
  - Add/remove conditions dynamically.
- **Tag views:** Custom views with an associated tag:
  - Show a tag icon (Lucide tag) before the name in the sidebar.
  - Implicitly filter by the associated tag (always AND'd, regardless of the view's all/any logic).
  - Support drag-and-drop: dropping tickets onto the view adds the associated tag.
  - Auto-tag on create: tickets created while viewing a tag view automatically receive the view's tag.
- Tag autocomplete fields show the first 100 tags alphabetically on focus (before typing), then filter as the user types.
- **Filtering behavior:** Deleted tickets are always excluded from custom view results. Archived tickets are excluded by default unless the view's "Include archived tickets" checkbox is enabled.
- Custom views are stored as JSON in `settings.json` (key: `custom_views`). The `tag` field is optional on the `CustomView` object.
- API: `POST /api/tickets/query` accepts `{ logic, conditions, sort_by, sort_dir, required_tag }` and returns matching tickets via parameterized SQL. The `required_tag` parameter is always AND'd with the query.
- Custom views support both list and column layouts.

### 4.15 Dashboard

- **Sidebar widget**: Always-visible compact widget below the stats bar showing a 7-day throughput spark chart, weekly completion count with trend arrow, and WIP count. Clicking it opens the full dashboard.
- **Full dashboard view**: Replaces the ticket list with an analytics page containing:
  - **Time range toggle**: 7, 30, or 90 days
  - **KPI cards** (top row): Completed this week (with % change), Median cycle time, In progress (WIP), Completed/Created ratio
  - **Throughput chart**: Bar chart of completions per day over the selected period
  - **Created vs Completed**: Dual-line chart showing inflow vs outflow
  - **Cumulative Flow Diagram**: Stacked area chart by status (not_started, started, completed, verified) — the gold standard for continuous workflows
  - **Category Breakdown**: Donut chart of open tickets by category
  - **Cycle Time Scatter**: Dot plot on a logarithmic Y-axis with 50th/85th percentile lines. Y-axis uses smart duration labels (e.g. "15m", "2.5h", "1.2d", "2w") for sub-day precision
- Charts rendered as inline SVG (no external library).
- Historical data stored in `stats_snapshots` table (daily status counts). Backfilled from ticket history on server start.
- API: `GET /api/dashboard?days=30`

### 4.16 Live Updates

- The UI uses long-polling to detect data changes.
- When a change is detected (from another tab, API call, or AI tool), the ticket list automatically refreshes.
- Poll timeout: 30 seconds; retry on connection error after 5 seconds.
- Polling pauses during backup preview.
- **Focus protection**: Text fields that currently have focus are never programmatically updated during a refresh to avoid cursor disruption. Specifically:
  - Detail panel title and details inputs are skipped if focused.
  - Notes are not re-rendered while a note textarea is being edited.
  - Ticket list title inputs preserve both their value and cursor position (selectionStart/selectionEnd) across re-renders.

### 4.17 Attention Notifications

Two events can request user attention, each independently configurable in Settings → General:

- **When Claude needs permission** — triggered when the permission overlay appears. Default: "Notify until focused".
- **When Claude finishes work** — triggered when Claude becomes idle after processing tickets. Default: "Notify once".

Each has three options:
| Option | Tauri (desktop) | Browser |
|--------|----------------|---------|
| Don't notify | No action | No action |
| Notify once | Single dock icon bounce (Informational) | Tab title flashes 3 times |
| Notify until focused | Continuous dock bounce until app is focused (Critical) | Tab title flashes 15 times |

- **Tauri implementation**: Two custom Rust commands (`request_attention` for Critical, `request_attention_once` for Informational) call `window.request_user_attention()` on the main window via `AppHandle`.
- **Browser implementation**: Alternates `document.title` between the original title and a warning message. Only triggers when `!document.hasFocus()`.
- **Settings storage**: `notify_permission` and `notify_completed` keys in `settings.json`. Values: `none`, `once`, `persistent`.

### 4.18 Auto-Context

- Users can configure automatic context that is prepended to ticket details in the worklist and open-tickets markdown files.
- **Settings tab**: "Context" tab (Lucide file-text icon) in the settings dialog.
  - "Add" button opens a dialog with a filterable list of categories and tags (excluding already-configured ones).
  - Each entry shows a badge (Category/Tag + name), an editable textarea for the context text, and a delete button.
  - Changes auto-save with 500ms debounce.
- **Storage**: JSON array in the `auto_context` settings key. Each entry: `{ type: 'category'|'tag', key: string, text: string }`.
- **Prepend order**: Category context appears first, then tag context entries sorted alphabetically by tag key.
- Only one entry per category or tag is allowed.

### 4.19 Error Handling

- Network errors display a popup notification to the user.
- API failures are surfaced (not silently swallowed) in the UI.

## Non-Functional Requirements

### 4.20 Performance

- Scroll position is preserved across data-driven re-renders in both list and column views.
- Input debouncing (200-800ms depending on field) prevents excessive API calls.
- Long-poll minimizes unnecessary network traffic compared to interval polling.

### 4.21 Undo / Redo

- **Cmd/Ctrl+Z** undoes the last change; **Cmd/Ctrl+Shift+Z** redoes.
- Works globally, including when focused in text input fields.
- **Supported operations**: field changes (category, priority, status, up_next, title, details), ticket deletion, trash restore, batch operations (bulk field changes, bulk delete), drag-and-drop (sidebar drops, column drops).
- **Not supported**: ticket creation, file attachments, settings changes.
- **Text field coalescing**: Rapid edits to the same text field (title or details) are merged into a single undo step. A new undo entry is created every 5 seconds of continuous editing (rate limit, not debounce).
- **Stack depth**: Maximum 1000 entries. Oldest entries are discarded when the limit is exceeded.
- **In-memory only**: The undo stack is not persisted across page reloads.
- Any new change clears the redo stack (standard undo/redo behavior).
- Pending debounced saves are cancelled when undo/redo is triggered.

### 4.22 Responsiveness

- Minimum window size: 800x500.
- Detail panel is resizable in both orientations.
- Column view scrolls horizontally when needed.
