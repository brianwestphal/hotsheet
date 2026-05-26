# 9. REST API

> **MCP tool equivalents.** Every mutation endpoint in this document has an equivalent MCP tool when accessed by an AI agent through the Claude Channel. See [63-mcp-tools.md](63-mcp-tools.md) for the tool surface. The REST API documented below is the universal interface and the source of truth for input validation; MCP tools are an additional access path that proxies into the same REST endpoints (`src/channel.tools.ts`, HS-8346).

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

### 9.0.1 Read Tracking Header

Mutation requests (POST, PATCH, PUT, DELETE) can include an `X-Hotsheet-User-Action: true` header to indicate the change was made by the user through the UI (as opposed to an AI tool or external API client). When this header is present:

- The server bumps `last_read_at` alongside `updated_at` for tickets that are currently read (`last_read_at >= updated_at`), preventing user-initiated changes from making tickets appear unread.
- Tickets that are currently unread (explicitly marked via "Mark as Unread") retain their unread state.
- The browser client automatically adds this header to all mutation requests.

### 9.0.2 Project Selection (multi-project instances)

A single Hot Sheet server can host multiple projects. EVERY request — including read-only `GET` calls — must identify which project's data it's reading or it falls back to the default project (the one Hot Sheet was first launched against this process). For an external caller, that fallback is almost never what you want.

Two equivalent ways to identify the project, both checked by the request middleware in `src/server.ts`:

- **`X-Hotsheet-Secret: <secret>` header.** Preferred for `POST` / `PATCH` / `PUT` / `DELETE` (also serves the CSRF check). Use the project's secret from `<dataDir>/.hotsheet/settings.json::secret` or read it from `GET /api/projects`'s `secret` field.
- **`?project=<secret>` query param.** The Hot Sheet browser client uses this for `GET` requests (since browsers can't trivially add custom headers to `<a href>` / `<img src>` requests, the query-param shape keeps the server-side code path uniform).

If BOTH are present, the header takes precedence. If NEITHER is present, the server falls back to the default project — which for an external caller hitting a multi-project Hot Sheet is almost certainly the wrong project's data.

**Anti-pattern (HS-8340):** authing the `GET /api/tickets/:id` per-id endpoint and the `POST /api/tickets` create endpoint but forgetting to auth `GET /api/tickets` (the LIST endpoint). The LIST endpoint resolves the same way as every other endpoint: no auth → default project. Per-id and POST happen to "work" because the caller authed them; the LIST silently returns the default project's data. Always add the auth (`X-Hotsheet-Secret` header OR `?project=<secret>` query param) to EVERY request that touches per-project data. See `src/routes/multiProjectIsolation.test.ts` for the regression-guard test suite that pins this contract.

### 9.0.3 Typed API Layer (`src/api/`) — single source of truth (HS-8522)

The request / response **wire shapes** for each endpoint are defined once as zod schemas in per-resource modules under `src/api/<resource>.ts`, and shared by BOTH the client callers and the server handlers. This replaces two anti-patterns: inline `api<{ … }>(path)` type literals at the call site (the type travelled with the call, never reused) and hand-duplicated `interface` declarations kept in sync by hand across client and server files.

Each `src/api/<resource>.ts` module exports:

- **Schemas** (`XReqSchema` / `XRespSchema`) + their inferred types (`type X = z.infer<typeof XSchema>`). The server imports the request schema to validate the incoming body (`parseBody`/`safeParse`); the client validates the response against the response schema at runtime.
- **Typed caller functions** (e.g. `getGitStatus()`, `gitReveal({ path })`) that wrap `apiCall(schema, path, opts)` so callers never construct raw URLs or restate the response type.

`src/api/index.ts` aggregates every module into named re-exports plus a flat `apis` namespace (`apis.getGitStatus()`). The runtime helper `src/api/_runner.ts` is **server-safe** (imports only `zod`): the actual fetch is performed by a transport the client injects at boot via `setApiTransport`, so a server route file can import a schema from `src/api/*` without dragging the DOM-bound client `api()` runtime into the Node bundle.

Migration is **per-domain** (HS-8522 sub-tickets); **git** (`src/api/git.ts` ↔ `routes/git.ts` ↔ `gitStatusChip.tsx` / `gitStatusPopover.tsx`) is the shipped reference implementation. Migrated so far: **git**, **tickets** (`src/api/tickets.ts`, HS-8629 + HS-8642 stragglers — incl. the `GET /tickets/:id` detail response via `TicketDetailSchema`, the `updateTicketField` dynamic-key helper, and routing `undo/actions.ts` through the typed callers), **feedback-drafts** (`src/api/feedbackDrafts.ts`, HS-8642 — the §21 draft endpoints, with `FeedbackDraftSchema` as the wire SSOT consumed by both `src/db/feedbackDrafts.ts` and the client `noteRenderer.tsx`), **terminal** (`src/api/terminal.ts`, HS-8630 — the 10 JSON endpoints; `TerminalConfig` / `TerminalState` / `TerminalStatus` reclaimed here as the SSOT, re-exported by `src/terminals/config.ts` + `registry/types.ts`; the WebSocket attach handler stays bespoke), **telemetry** (`src/api/telemetry.ts`, HS-8632 — the 9 read-only `GET`s + the retention `DELETE`; the cross-project `/dashboard` read forwards `skipProjectScope`; the deeply-nested dashboard payloads are the wire SSOT here while `src/db/otelQueries.ts` keeps its structurally-identical server-internal query types, to bound the blast radius on that module), **backups + db** (`src/api/backups.ts` + `src/api/db.ts`, HS-8636 — backup list/create/now/preview/cleanup/restore + the §42/§73 recovery / snapshot-status / pg_resetwal-repair endpoints; binary tarball download stays bespoke), and **channel** (`src/api/channel.ts`, HS-8631 — claude-check / status / trigger / permission-respond / enable / disable / heartbeat-status; reuses the existing `PendingPermissionSchema` / `PermissionResultBodySchema`; the permission + heartbeat long-polls keep their server-side semantics, and `/channel/{notify,permission/notify,heartbeat}` stay server-to-server), and **projects** (`src/api/projects.ts`, HS-8634 — list / register / delete / reorder / channel-status / feedback-state / reveal + the `/permissions` + `/bell-state` long-polls + the §37 `/quit-summary` aggregator; the permission entry's `request_id` / `tool_name` / `description` use `z.string().catch('')` so a partial entry validates with `''` defaults instead of dropping a real pending request on the long-poll, reconciling the server's all-optional `PendingPermissionEntrySchema` with the popup's required `PermissionData`), and **plugins** (`src/api/plugins.ts`, HS-8637 — list / detail / UI-elements / bundled-catalog / install / enable-disable (per-project + everywhere) / uninstall / reveal / action / validate / config-labels / global-config + the `/backends`, `/sync/tickets`, `/sync/conflicts` reads and conflict-resolve write; this module is the SSOT for the plugin data shapes — `PluginInfo` / `PluginPreference` / `ConfigLayoutItem` / `ConfigLabelColor` / `SyncConflict` / `PluginUIElement` / `BundledPluginInfo` — which `src/client/pluginTypes.tsx` re-exports; one `PluginInfoSchema` covers both the list + detail responses via optional `author` / `configLayout` / `path`). Cross-project callers take an optional `secret` that forwards to `apiCall`'s `opts.secret`. **When adding a new endpoint:** add its schema + typed caller in `src/api/<resource>.ts`, validate the request server-side against that schema, and call the typed function from the client — do not reintroduce inline `api<{…}>(path)` type literals.

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
| `include_backlog` | `true` / `1` — mix backlog rows into the result set (HS-7756) |
| `include_archive` | `true` / `1` — mix archive rows into the result set (HS-7756) |
| `limit` | Positive integer, max 10000 (HS-8337). Empty string treated as not provided. Invalid values return 400. |
| `offset` | Non-negative integer (HS-8337). Empty string treated as not provided. Invalid values return 400. |

Special status filter values:
- `open` — not_started + started
- `non_verified` — not_started + started + completed
- `active` — excludes deleted, backlog, archive (default behavior)

**Pagination (HS-8337).** The browser client uses `limit` to render at most `N` rows in list layout — default page size 100, growable via a "Load More" button at the bottom of the list. The client requests `limit + 1` rows and trims to detect whether more rows exist without a second round-trip; `offset` is exposed for completeness but the Load More flow re-fetches with a growing `limit` and `offset: 0` so the rendered list is always a contiguous prefix. Column layout and custom views ignore both params (column view groups by status and would orphan columns under a partial fetch; custom views go through the separate `POST /api/tickets/query` endpoint which doesn't currently paginate).

### 9.2 Batch Endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tickets/batch` | Batch action on multiple tickets |

Request body: `{ ids: number[], action: string, value?: string | boolean }`

Supported actions: `delete`, `restore`, `category`, `priority`, `status`, `up_next`, `mark_read`, `mark_unread`.

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
| POST | `/api/tickets/query` | Query tickets with custom view conditions (`{ logic, conditions, sort_by, sort_dir, required_tag?, include_archived? }`). `required_tag` is always AND'd regardless of logic. `include_archived` (boolean, default false) includes archived tickets in results when true. |

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
| POST | `/api/channel/heartbeat` | Receive busy/idle/heartbeat state from Claude Code hooks (`{ projectDir, state }`) |
| GET | `/channel/heartbeat-status` | Return and clear pending heartbeat updates (`{ updates: [{ secret, state }] }`) |

The heartbeat endpoint accepts `{ projectDir: string, state: "busy" | "idle" | "heartbeat" }` and does not require auth (skipped in middleware). The heartbeat-status endpoint returns accumulated updates and clears them.

### 9.14 Project Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all registered projects with ticket counts |
| POST | `/api/projects/register` | Register a project (`{ dataDir }`) |
| DELETE | `/api/projects/:secret` | Remove a registered project by its secret |
| POST | `/api/projects/:secret/reveal` | Open the project's root folder in the OS file manager |
| GET | `/api/projects/channel-status` | Returns channel alive/dead status for all registered projects |
| GET | `/api/projects/feedback-state` | HS-8378 — returns per-project boolean indicating whether any non-deleted ticket has a `FEEDBACK NEEDED:` / `IMMEDIATE FEEDBACK NEEDED:` prompt as its most recent note. Drives the cross-project tab purple dot. |
| POST | `/api/projects/reorder` | Reorder the project list (`{ secrets: string[] }`) |
| GET | `/api/projects/permissions` | Long-poll for pending permissions across all projects (versioned, 3s timeout) |

### 9.15 Change Notification

- All ticket-mutating endpoints (create, update, delete, batch, attachment) increment an internal change version counter.
- The `/api/poll` endpoint returns when the change version exceeds the client's known version, enabling long-poll live updates.

## Non-Functional Requirements

### 9.16 Consistency

- All ticket-mutating endpoints trigger markdown sync and change notification. Settings updates trigger change notification but not markdown sync.
- The API is the single source of truth; the UI and markdown exports are derived views.
