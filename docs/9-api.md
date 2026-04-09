# 9. REST API

## Functional Requirements

### 9.0 Input Validation

All API endpoints validate request bodies using [Zod](https://zod.dev/) schemas defined in `src/routes/validation.ts`. Invalid requests receive a `400` response with a descriptive `error` field listing the validation failures.

Validated fields include:
- **Ticket mutations**: `status` must be a valid `TicketStatus` enum value, `priority` must be a valid `TicketPriority`, category must be a non-empty string
- **Batch operations**: `ids` must be an array of integers, `action` must be a valid enum, and `value` is validated per action type
- **Custom view queries**: `logic`, `conditions[].field`, `conditions[].operator` are validated against known enums
- **Shell commands**: `command` must be a non-empty string
- **Settings**: key-value pairs must be `Record<string, string>`
- **Backups**: `tier` must be one of `5min`, `hourly`, `daily`
- **Projects**: `dataDir` must be a non-empty string

### 9.1 Ticket Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tickets` | List tickets with optional filters |
| POST | `/api/tickets` | Create a new ticket |
| GET | `/api/tickets/:id` | Get a ticket with its attachments |
| PATCH | `/api/tickets/:id` | Update ticket properties |
| DELETE | `/api/tickets/:id` | Soft-delete a ticket |
| DELETE | `/api/tickets/:id/hard` | Hard-delete a ticket and its attachments |
| POST | `/api/tickets/:id/restore` | Restore a deleted ticket |
| POST | `/api/tickets/:id/up-next` | Toggle the up_next flag |

#### Query Filters (GET `/api/tickets`)

| Parameter | Values |
|-----------|--------|
| `category` | issue, bug, feature, requirement_change, task, investigation |
| `priority` | highest, high, default, low, lowest |
| `status` | not_started, started, completed, verified, backlog, archive, deleted, open, non_verified, active |
| `up_next` | true, false |
| `search` | Free-text search (ILIKE on title, details, ticket_number, tags) |
| `sort_by` | created, priority, category, status |
| `sort_dir` | asc, desc |

Special status filter values:
- `open` — not_started + started
- `non_verified` — not_started + started + completed
- `active` — excludes deleted, backlog, archive (default behavior)

### 9.2 Batch Endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tickets/batch` | Batch action on multiple tickets |

Request body: `{ ids: number[], action: string, value?: string | boolean }`

Supported actions: `delete`, `restore`, `category`, `priority`, `status`, `up_next`.

### 9.3 Note Endpoints

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/api/tickets/:id/notes/:noteId` | Edit an individual note's text |
| DELETE | `/api/tickets/:id/notes/:noteId` | Delete an individual note |
| PUT | `/api/tickets/:id/notes-bulk` | Replace the entire notes array (used by undo) |

Notes can also be appended via the ticket PATCH endpoint's `notes` field (append-only, for AI tool compatibility).

### 9.4 Duplicate Endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tickets/duplicate` | Duplicate selected tickets (`{ ids: number[] }`) |

Copies are created with " - Copy" suffix (incrementing if conflicts exist). The following fields are copied: `category`, `priority`, `details`, `up_next`. Fields that are NOT copied: `tags` (derived from title), `status` (reset to not_started), `notes`.

### 9.5 Attachment Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tickets/:id/attachments` | Upload a file attachment |
| DELETE | `/api/attachments/:id` | Delete an attachment |
| POST | `/api/attachments/:id/reveal` | Reveal file in OS file manager |
| GET | `/api/attachments/file/*` | Serve an attachment file |

### 9.6 Trash Endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/trash/empty` | Hard-delete all trashed tickets |

### 9.7 Stats & Dashboard Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Ticket counts: total, open, up_next, by_category, by_status |
| GET | `/api/dashboard?days=N` | Dashboard data: throughput, cycle time, CFD snapshots, category breakdown, KPIs |

### 9.8 Tags & Categories Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tags` | List all unique tags across tickets |
| GET | `/api/categories` | Get current category definitions |
| PUT | `/api/categories` | Replace category definitions |
| GET | `/api/category-presets` | List available category presets |

### 9.9 Custom View Query

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tickets/query` | Query tickets with custom view conditions (`{ logic, conditions, sort_by, sort_dir, required_tag? }`). `required_tag` is always AND'd regardless of logic. |

### 9.10 Settings Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Get database settings |
| PATCH | `/api/settings` | Update database settings |
| GET | `/api/file-settings` | Get file-based settings (appName, backupDir) |
| PATCH | `/api/file-settings` | Update file-based settings |

### 9.11 Backup Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/backups` | List all backups |
| POST | `/api/backups/create` | Create a backup (specify tier) |
| POST | `/api/backups/now` | Trigger an immediate manual backup |
| GET | `/api/backups/preview/:tier/:filename` | Load a backup for read-only preview |
| POST | `/api/backups/preview/cleanup` | Clean up preview database |
| POST | `/api/backups/restore` | Restore from a backup |

### 9.12 Utility Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/poll?version=N` | Long-poll for changes (30s timeout) |
| GET | `/api/worklist-info` | Get AI prompt text and skillCreated flag |
| GET | `/api/gitignore/status` | Check if .hotsheet is in .gitignore |
| POST | `/api/gitignore/add` | Add .hotsheet to .gitignore |
| POST | `/api/print` | Generate a print HTML file and open in browser |
| POST | `/api/ensure-skills` | Check and update AI tool skill files (`{ updated: boolean }`) |
| GET | `/api/browse` | Browse filesystem directories for project registration |
| GET | `/api/global-config` | Read global cross-project configuration |
| PATCH | `/api/global-config` | Update global config fields (share timing, channel enabled, etc.) |
| GET | `/api/glassbox/status` | Check if Glassbox CLI is available |
| POST | `/api/glassbox/launch` | Launch Glassbox for current project |

See also [14-commands-log.md](14-commands-log.md) §14.8 for command log endpoints and [15-shell-commands.md](15-shell-commands.md) §15.4 for shell execution endpoints.

### 9.13 Claude Channel Endpoints

See [12-claude-channel.md](12-claude-channel.md) §12.13 for the full channel API reference.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channel/claude-check` | Check Claude CLI availability and version |
| GET | `/api/channel/status` | Channel state, port, and done flag |
| POST | `/api/channel/trigger` | Send event to Claude via channel |
| POST | `/api/channel/done` | Claude signals completion |
| POST | `/api/channel/enable` | Enable channel, register in `.mcp.json` |
| POST | `/api/channel/disable` | Disable channel, remove from `.mcp.json` |
| GET | `/api/channel/permission` | Long-poll for pending permission requests (3s timeout) |
| POST | `/api/channel/permission/respond` | Respond to a permission request |
| POST | `/api/channel/permission/dismiss` | Dismiss permission overlay |
| POST | `/api/channel/notify` | Notify long-poll of channel state changes (used internally by channel server) |
| POST | `/api/channel/permission/notify` | Wake the permission long-poll (used internally by channel server) |

### 9.14 Project Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all registered projects with ticket counts |
| POST | `/api/projects/register` | Register a project (`{ dataDir }`) |
| DELETE | `/api/projects/:secret` | Remove a registered project by its secret |
| POST | `/api/projects/:secret/reveal` | Open the project's root folder in the OS file manager |
| GET | `/api/projects/channel-status` | Returns channel alive/dead status for all registered projects |
| POST | `/api/projects/reorder` | Reorder the project list (`{ secrets: string[] }`) |
| GET | `/api/projects/permissions` | Long-poll for pending permissions across all projects (versioned, 3s timeout) |

### 9.15 Change Notification

- All ticket-mutating endpoints (create, update, delete, batch, attachment) increment an internal change version counter.
- The `/api/poll` endpoint returns when the change version exceeds the client's known version, enabling long-poll live updates.

## Non-Functional Requirements

### 9.16 Consistency

- All ticket-mutating endpoints trigger markdown sync and change notification. Settings updates trigger change notification but not markdown sync.
- The API is the single source of truth; the UI and markdown exports are derived views.
