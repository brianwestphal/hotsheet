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
| created_at | TIMESTAMP | When the event occurred |

Indexed on `created_at` for efficient newest-first queries.

## 14.3 Event Types

| Type | Direction | When |
|------|-----------|------|
| `trigger` | outgoing | Channel trigger sent to Claude (worklist or custom command) |
| `done` | incoming | Claude signals completion via /channel/done |
| `permission_request` | incoming | Claude requests permission for a tool (logged once per request_id) |
| `permission_response` | outgoing | User allows or denies a permission request |
| `custom_command` | outgoing | Custom command button clicked |
| `shell_command` | outgoing | Shell command executed (see [future] §14.8) |
| `shell_output` | incoming | Shell command stdout/stderr output |
| `error` | system | Error during command execution |

## 14.4 UI — Log Button

A terminal icon button in the footer toolbar (far right, before the channel status indicator). Shows a red badge with unread count when new entries arrive while the panel is closed. Badge resets when the panel is opened.

## 14.5 UI — Log Panel

A resizable panel at the bottom of the app:

- **Position**: Fixed at the bottom, full width, covers other UI elements (z-index above content)
- **Default height**: 300px, resizable via drag handle at the top (min 150px, max 600px)
- **Header bar**: Title "Commands Log", search input (debounced 300ms), event type filter dropdown, clear button (trash icon), close button (×)
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

When the panel is open, entries auto-refresh every 5 seconds. When closed, no polling occurs (only the badge count is updated periodically).
