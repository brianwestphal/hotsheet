# 14. Commands Log

## 14.1 Overview

A log viewer that records all communication with Claude (channel triggers, completions, permission requests/responses, custom commands) and shell command execution. Persisted in the database, capped at 1000 entries.

## 14.2 Data Model

The `command_log` table stores log entries:

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| event_type | TEXT | Type of event (see §14.3) |
| direction | TEXT | `outgoing` (to Claude), `incoming` (from Claude), `system` |
| summary | TEXT | Short description (first line displayed) |
| detail | TEXT | Full content (expandable) |
| created_at | TIMESTAMPTZ | When the event occurred |

Indexed on `created_at` for efficient newest-first queries.

## 14.3 Event Types

| Type | Direction | When |
|------|-----------|------|
| `trigger` | outgoing | Channel trigger sent to Claude (worklist or custom command) |
| `done` | incoming | Claude signals completion via /channel/done |
| `permission_request` | incoming | Claude requests permission for a tool. Updated in-place when user responds (summary changes to "Permission: {tool} — Allowed/Denied"). Logged once per request_id. |
| `shell_command` | outgoing | Shell command executed. Updated in-place with output when command completes (detail gets separator + stdout/stderr). |

## 14.4 UI — Log Button

A panel icon button in the footer toolbar (far right, before the channel status indicator) is the single toggle for the drawer — clicking it opens the drawer when closed, and closes it when open. Shows an accent-colored dot indicator when new entries arrive while the panel is closed; the dot resets when the panel is opened. When the drawer is open the icon rotates 180° to indicate "close / push down", and the tooltip changes to "Close Commands Log".

## 14.5 UI — Log Panel

A resizable panel at the bottom of the app:

- **Position**: In-flow between the main content area and the footer — opening the panel shrinks the main content (ticket list / column view / detail panel) to make room. The panel never overlays the ticket list.
- **Stacking with bottom-docked detail panel**: When the detail panel is docked to the bottom (`detail_position = "bottom"`), the stack from top to bottom is: main ticket area → detail panel → commands log panel → footer. None of these overlap.
- **Default height**: 300px, resizable via drag handle at the top (min 150px, max 600px). The main content area has `min-height: 0` / `overflow: hidden` so it remains scrollable at all drawer heights.
- **Tab strip**: The drawer hosts two tabs (see [22-terminal.md](22-terminal.md)) — Commands Log (always shown) and Terminal (shown only when `terminal_enabled` is true in `.hotsheet/settings.json`). Inactive tab content is hidden via `display:none` but stays mounted: the Commands Log keeps auto-refreshing, and the Terminal keeps its WebSocket + xterm instance alive. Tab state persists across drawer close/open within a session.
- **Header bar** (Commands Log tab): search input (debounced 300ms), multi-select filter dropdown with checkboxes and Select All/Deselect All toggle (client-side filtering), clear button (trash icon). No separate close button inside the drawer — see §14.4.
- **Entry list**: Scrollable, newest first

### Log Entry Display

Each entry shows:
- Direction indicator (→ outgoing blue, ← incoming green, ● system gray)
- Event type badge (colored chip)
- Summary text (bold, single line with ellipsis)
- Relative timestamp ("2m ago", "1h ago")
- First 3 lines of detail text (truncated)
- Click to expand/collapse the full detail text (monospace, pre-wrap)

## 14.6 Filtering

- **Search**: Filters by summary or detail content (case-insensitive, ILIKE)
- **Event type**: Dropdown filter for specific event types (e.g., hide permission checks)
- Both filters are combined (AND logic)

## 14.7 Data Management

- **Cap**: Maximum 1000 entries. Oldest entries pruned on server startup.
- **Clear**: "Clear log" button deletes all entries via `DELETE /api/command-log`.
- **Persistence**: Entries survive server restarts (stored in PGLite database).

## 14.8 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/command-log` | GET | List entries. Query params: `limit`, `offset`, `event_type`, `search` |
| `/api/command-log` | DELETE | Clear all entries |
| `/api/command-log/count` | GET | Total count. Query params: `event_type`, `search` |

## 14.9 Auto-Refresh

When the panel is open, entries auto-refresh every 5 seconds. When closed, no polling occurs (the badge count is updated when channel or shell events occur).
