# 18. Plugins

## Overview

Hot Sheet supports plugins that integrate with external ticketing systems (GitHub Issues, Linear, Jira, etc.) via a bidirectional sync engine, and non-ticketing plugins that add custom UI and functionality. Plugins are loaded at server startup from a global directory and configured per-project.

Plugin support is enabled by default. It can be disabled at build time by setting `PLUGINS_ENABLED=false`. The feature flag (`PLUGINS_ENABLED`) controls route mounting, UI elements, and plugin loading.

## Functional Requirements

### 18.1 Plugin Format

Plugins are directories containing either:
- A `manifest.json` with required fields (`id`, `name`, `version`) and an entry point JS file.
- A `package.json` with a `hotsheet` field containing plugin metadata, plus a JS entry point.

**Manifest schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique plugin identifier (e.g. `github-issues`) |
| `name` | string | Yes | Human-readable name |
| `version` | string | Yes | Semver version |
| `description` | string | No | Short description |
| `author` | string | No | Author name |
| `entry` | string | No | Entry point relative to plugin dir (default: `index.js`) |
| `icon` | string | No | Inline SVG string (14x14 recommended, shown on synced tickets) |
| `preferences` | array | No | Configurable preferences schema (see §18.5) |
| `configLayout` | array | No | Config dialog layout structure (see §18.6) |

### 18.2 Plugin Location and Bundling

- **Global directory**: `~/.hotsheet/plugins/` — all plugins live here.
- Each plugin is a subdirectory (e.g. `~/.hotsheet/plugins/github-issues/`).
- Plugin configuration is per-project, stored in the project's `settings` table with keys prefixed by `plugin:<id>:`.
- **Bundled plugins**: Official plugins ship in `dist/plugins/`. On startup, `installBundledPlugins()` copies them to `~/.hotsheet/plugins/` if not present or outdated (version comparison).
- **Dismissed plugins**: When a bundled plugin is uninstalled, its ID is saved to `~/.hotsheet/dismissed-plugins.json`. The auto-installer skips dismissed plugins. Re-installing via "Find Plugins" clears the dismiss flag.
- **Symlinks**: The install-from-disk flow creates symlinks. The discovery engine follows symlinks via `statSync()`.

### 18.3 Plugin Lifecycle

- **Discovery**: On server startup, scan `~/.hotsheet/plugins/` for directories with valid manifests (including symlinks).
- **Loading**: Import each plugin's entry point and call `activate(context)`. If the plugin returns a `TicketingBackend`, it is registered as a sync backend. If it exports `onAction`, `validateField`, those are also registered.
- **Enable/Disable**: Per-project. Stored in the project's settings table as `plugin_enabled:{id}`. Default: enabled. Disabling cleans up `ticket_sync` and `sync_outbox` records for that project. Context menu includes "Enable on All Projects" and "Disable on All Projects" (affects open projects only).
- **Reactivation**: The `reactivatePlugin()` function deactivates and re-activates a plugin to pick up config changes. Called automatically by the status check, sync, action, and push-ticket endpoints — so after the user edits a setting, the next operation always sees the new value without requiring a manual reload.
- **Uninstall**: Removes from disk, removes from in-memory registry, dismisses bundled plugins. Right-click context menu shows inline confirmation.
- **Unloading**: On server shutdown, all plugins are deactivated.

The `PluginContext` provided to `activate()` includes:
- `config` — the plugin's resolved configuration values.
- `log(level, message)` — attributed logging.
- `getSetting(key)` / `setSetting(key, value)` — per-plugin persistent storage (respects scope: global vs project).
- `registerUI(elements)` — register custom UI elements (toolbar buttons, etc.).
- `updateConfigLabel(labelId, text)` — dynamically update a label in the config dialog.

### 18.4 TicketingBackend Interface

Plugins that integrate with external ticketing systems return a `TicketingBackend` from `activate()`. The interface includes:

**Identity:**
- `id` — matches the plugin ID.
- `name` — display name (e.g. "GitHub Issues").

**Capabilities:**
- `create`, `update`, `delete` — whether the backend supports each CRUD operation.
- `incrementalPull` — whether `pullChanges(since)` supports filtering by date.
- `syncableFields` — which ticket fields the backend can sync.
- `comments` — whether the backend supports comment/note sync.

**CRUD:**
- `createRemote(ticket)` — create a ticket remotely, returns the remote ID.
- `updateRemote(remoteId, changes)` — update fields on a remote ticket.
- `deleteRemote(remoteId)` — delete or close a remote ticket.

**Sync:**
- `pullChanges(since)` — fetch remote changes since a date.
- `getRemoteTicket(remoteId)` — (optional) fetch a single remote ticket.

**Status:**
- `checkConnection()` — verify the backend is connected and authenticated.
- `getRemoteUrl(remoteId)` — (optional) return a clickable URL to view the ticket remotely.
- `shouldAutoSync(ticket)` — (optional) return true to auto-push new tickets.

**Comments:**
- `getComments(remoteId)` — fetch comments for a remote ticket.
- `createComment(remoteId, text)` — create a comment, returns the comment ID.
- `updateComment(remoteId, commentId, text)` — update a comment.
- `deleteComment(remoteId, commentId)` — delete a comment.

**Attachments:**
- `uploadAttachment(filename, content, mimeType)` — upload a file, returns a public URL. Returns null if uploads not configured.

**Field validation:**
- `validateField(key, value)` — (optional, exported from module) validate a config field value. Returns `{ status: 'error'|'warning'|'success', message }` or null.

### 18.5 Plugin Preferences

Plugins declare configurable preferences in their manifest. Each preference has:

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Setting key |
| `label` | string | Display label |
| `type` | string | `string`, `boolean`, `number`, `select`, `dropdown`, `combo` |
| `default` | any | Default value |
| `description` | string | Help text |
| `required` | boolean | Whether the preference must be set |
| `secret` | boolean | Whether the value should be masked in UI |
| `scope` | string | `global` or `project` (default: `project`) |
| `options` | array | For `select`/`dropdown`/`combo` types: `{ value, label }` pairs |

**Types:**
- `string` — text input (password if `secret: true`)
- `boolean` — checkbox
- `number` — numeric input
- `select` / `dropdown` — dropdown with predefined choices
- `combo` — dropdown with predefined choices AND free-text entry (uses HTML `<datalist>`)

**Scope:**
- **Global** settings are stored in `~/.hotsheet/plugin-config.json` and shared across all projects. They show a "Global" badge in the UI.
- **Project** settings are stored in the project's settings table and are independent per project.

**Validation:** After each field save, the client calls `POST /api/plugins/validate/:id` with `{ key, value }`. The plugin's `validateField` handler returns inline feedback displayed below the field (color-coded: red error, amber warning, green success).

### 18.6 Config Dialog Layout

The `configLayout` array in the manifest controls how the config dialog is structured. If omitted, preferences are shown in a flat list.

**Layout item types:**

| Type | Fields | Description |
|------|--------|-------------|
| `preference` | `key` | Renders the preference input for the given key |
| `divider` | | Horizontal line separator |
| `spacer` | | Vertical gap (12px) |
| `label` | `id`, `text`, `color?` | Dynamic text label (can be updated via `context.updateConfigLabel`) |
| `button` | `id`, `label`, `action`, `icon?`, `style?` | Clickable button that triggers `onAction` |
| `group` | `title`, `collapsed?`, `items` | Collapsible group containing other layout items |

Groups are collapsible with a chevron toggle. The `collapsed` field sets the default state (resets on dialog reopen).

Dynamic labels are updated via `context.updateConfigLabel(labelId, text, color?)` from the plugin's `onAction` handler. The client fetches updates via `GET /api/plugins/config-labels/:id`.

**Label colors** — `color` is one of `default` (regular text), `success` (green), `error` (red), `warning` (orange), or `transient` (light gray, for "pending" / "not tested" placeholder states). Plugins should set the color tone semantically; the host maps each tone to the actual UI color so labels stay consistent across plugins.

### 18.7 Field Mappings

Each backend provides `fieldMappings` that translate between local and remote field values:

- **Category**: Maps local category IDs (e.g. `bug`) to remote values (e.g. `label:bug`).
- **Priority**: Maps local priorities to remote equivalents.
- **Status**: Maps local statuses to remote statuses.

Mappings include both `toRemote` and `toLocal` directions.

### 18.8 Sync Database Tables

**`ticket_sync`** — maps local tickets to remote counterparts:

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial | Primary key |
| `ticket_id` | integer | FK to tickets table |
| `plugin_id` | text | Which plugin owns this mapping |
| `remote_id` | text | ID in the remote system |
| `last_synced_at` | timestamptz | When last successfully synced |
| `remote_updated_at` | timestamptz | Remote modification time |
| `local_updated_at` | timestamptz | Local ticket's `updated_at` at last sync (for change detection) |
| `sync_status` | text | `synced`, `pending_push`, `pending_pull`, `conflict`, `error` |
| `conflict_data` | text | JSON describing the conflict (when status is `conflict`) |

Unique constraint on `(ticket_id, plugin_id)`.

**`sync_outbox`** — queue for create/delete operations:

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial | Primary key |
| `ticket_id` | integer | FK to tickets table |
| `plugin_id` | text | Target backend |
| `action` | text | `create` or `delete` |
| `field_changes` | text | JSON (unused for direct-comparison push) |
| `created_at` | timestamptz | When queued |
| `attempts` | integer | Push attempt count |
| `last_error` | text | Last error message |

Entries with 5+ failed attempts are permanently removed.

**`note_sync`** — maps local notes to remote comments:

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial | Primary key |
| `ticket_id` | integer | FK to tickets table |
| `note_id` | text | Local note ID |
| `plugin_id` | text | Which plugin owns this mapping |
| `remote_comment_id` | text | Remote comment ID |
| `last_synced_at` | timestamptz | When last synced |
| `last_synced_text` | text | Note text at last sync (enables three-way edit detection) |

Unique constraint on `(ticket_id, note_id, plugin_id)`. Also used for attachment tracking with `att_` prefixed note IDs.

### 18.9 Sync Engine

The sync engine orchestrates bidirectional synchronization between the local database and remote backends.

**Push (local → remote):**
- Uses direct comparison: for each synced ticket, compares `ticket.updated_at` with `ticket_sync.local_updated_at`.
- If the local ticket was modified since last sync, pushes ALL current field values via `updateRemote()`.
- After push, `local_updated_at` is updated to the ticket's current `updated_at`.
- Create/delete operations use the `sync_outbox` queue. Outbox create entries are skipped if the ticket already has a sync record (prevents duplicates when push-ticket and auto-create race).
- Stale outbox entries (5+ failures) are permanently removed.

**Pull (remote → local):**
- Calls `pullChanges(since)` to fetch remote modifications.
- For each remote change:
  - If no sync record exists, creates a new local ticket (with title-based dedup to prevent duplicates).
  - If a sync record exists: compares timestamps to detect conflicts.
  - If only remote modified → applies remote changes.
  - If both modified → creates a conflict record.
- Stale sync records (404/410 from remote) are automatically cleaned up — both via push errors (updateRemote throws 404) and via comment sync (getComments throws 404).

**Conflict resolution:**
- When a conflict is detected, `sync_status` is set to `conflict` and both local and remote field snapshots are stored in `conflict_data`.
- `keep_local`: sets status to `synced` first, then calls `pushToRemote()` so the direct-comparison loop immediately pushes the local values to the remote.
- `keep_remote`: applies remote values to the local ticket, then re-baselines the sync record's `local_updated_at` to the ticket's new `updated_at` so the next sync doesn't pointlessly re-push the same values back (no churn).

**Comments/Notes sync:**
- Runs after pull/push for backends with `capabilities.comments`.
- Uses three-way merge via `last_synced_text` in the `note_sync` table:
  - For each existing mapping: compares local note text and remote comment text against the `last_synced_text` baseline.
  - Only local changed → pushes edit to remote via `updateComment()`.
  - Only remote changed → pulls edit into local note.
  - Both changed → push-wins (local overwrites remote).
  - Local note deleted (mapping exists, note gone) → calls `deleteComment()` on remote.
  - Remote comment deleted (mapping exists, comment gone) → removes the local note.
- New unmapped remote comments → create local notes (text-based dedup prevents duplicates).
- New unmapped local notes → create remote comments (text-based dedup).
- Attachment mappings (note IDs with `att_` prefix) are skipped by the comment sync — managed separately by attachment sync.
- Notes rendered as Markdown in the UI via `marked` library.

**Attachment sync:**
- Runs after comment sync for backends with `uploadAttachment`.
- Reads local attachments, uploads via the backend's `uploadAttachment` method.
- Posts a markdown comment with the file link (image syntax for images).
- Attachment URLs should be permanent (not short-lived tokens). The GitHub plugin uses the raw URL format (`raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`) instead of GitHub's `download_url` which contains expiring `?token=` parameters.
- Tracked via `note_sync` with `att_` prefixed IDs to avoid re-uploading.

**First-push of a single ticket:**
- The "Push to remote" context-menu action and the create-outbox flow both call `createRemote()` to push core fields, then immediately push notes and attachments for that ticket via `syncSingleTicketContent()` — otherwise notes and attachments would be silently dropped on the first push and only catch up on the next full sync.

**Image proxy:**
- `GET /api/plugins/:id/image-proxy?url=&project=` proxies images from private GitHub repos using the plugin's stored PAT.
- For `raw.githubusercontent.com` URLs: fetches directly with Bearer auth (handles expired `?token=` parameters in old URLs).
- For `github.com/user-attachments/assets/UUID` URLs: resolves the UUID by fetching the relevant comment with `Accept: application/vnd.github.v3.html+json` to obtain a JWT-signed `private-user-images.githubusercontent.com` URL, then fetches that.
- The client rewrites `<img>` tags in rendered note markdown to go through the proxy, including the `project` query param for multi-project routing (since `<img>` tags can't send custom headers).
- Notes containing images also render download links below the content (web: blob download via programmatic `<a download>`; Tauri: opens in system browser via `invoke('open_url')`).

**Sync triggers:**
- **Manual**: Toolbar sync button (registered by plugin via UI extensions) or API.
- **Scheduled**: Configurable interval via `POST /plugins/:id/sync/schedule`. Runs in the correct project context via `runWithDataDir`.
- **Per-project isolation**: All sync operations check `isPluginEnabledForProject`. The sync, status, action, and push-ticket endpoints re-activate the plugin before operating to read the current project's config.

**Auto-sync new tickets:**
- Backends can implement `shouldAutoSync(ticket)` to auto-push new local tickets.
- Tickets already synced (have sync records) are not re-pushed.
- Configurable via a plugin preference (e.g. `auto_sync_new` toggle).

### 18.10 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/plugins` | List all loaded plugins with per-project status |
| `GET` | `/api/plugins/bundled` | List bundled (official) plugins with install status |
| `POST` | `/api/plugins/bundled/:id/install` | Install a bundled plugin |
| `GET` | `/api/plugins/ui` | Get registered UI elements for enabled plugins |
| `POST` | `/api/plugins/validate/:id` | Validate a config field value |
| `GET` | `/api/plugins/config-labels/:id` | Get dynamic config label overrides |
| `POST` | `/api/plugins/reveal/:id` | Show plugin directory in file manager |
| `GET` | `/api/plugins/:id` | Get plugin details |
| `POST` | `/api/plugins/:id/enable` | Enable for current project |
| `POST` | `/api/plugins/:id/disable` | Disable for current project (cleans up sync records) |
| `POST` | `/api/plugins/:id/enable-all` | Enable on all open projects |
| `POST` | `/api/plugins/:id/disable-all` | Disable on all open projects |
| `POST` | `/api/plugins/:id/reactivate` | Re-activate (picks up config changes) |
| `GET` | `/api/plugins/:id/status` | Check connection (always re-activates first) |
| `GET` | `/api/plugins/:id/sync` | Get sync records |
| `POST` | `/api/plugins/:id/sync` | Trigger sync (re-activates, checks per-project enabled) |
| `POST` | `/api/plugins/:id/sync/schedule` | Set sync schedule |
| `POST` | `/api/plugins/:id/push-ticket/:ticketId` | Push a local ticket to remote |
| `POST` | `/api/plugins/:id/action` | Trigger a plugin UI action (re-activates first) |
| `GET` | `/api/plugins/:id/image-proxy` | Proxy a GitHub image URL using stored PAT (`url` + `project` query params) |
| `POST` | `/api/plugins/:id/uninstall` | Uninstall (removes from disk + registry) |
| `GET` | `/api/plugins/:id/global-config/:key` | Get a global setting |
| `POST` | `/api/plugins/:id/global-config` | Set a global setting |
| `POST` | `/api/plugins/install` | Install from local path (symlink) |
| `GET` | `/api/backends` | List active backends with icons |
| `GET` | `/api/sync/tickets` | Get synced ticket map (for UI indicators) |
| `GET` | `/api/sync/conflicts` | List sync conflicts |
| `POST` | `/api/sync/conflicts/:ticketId/resolve` | Resolve a conflict |

### 18.11 Plugin Management UI

A **Plugins** tab in the settings dialog (Lucide plug icon) provides:

- **Plugin list**: Each installed plugin shows name, version, status dot (connected=green, disconnected=gray, error=red, needs-config=amber), and a gear button for configuration. Disabled plugins render at reduced opacity.
- **"Needs Configuration"** label shown when required preferences are missing.
- **"Find Plugins..." button** opens a dialog with two tabs:
  - **Official Plugins**: Lists bundled plugins with Install/Reinstall buttons. No restart needed.
  - **From Disk**: Path input with Browse button (Tauri folder picker) and green "Install Plugin" button.
- **Plugin configuration dialog**: Opens via gear button or "Configure..." in context menu. Title shows project name (e.g. "GitHub Issues — Small Tale Configuration"). Content driven by the plugin's `configLayout` (groups, dividers, labels, buttons) or flat preferences fallback.
- **Right-click context menu**: Configure, Enable/Disable, separator, Enable on All Projects, Disable on All Projects, separator, Uninstall (inline confirmation), separator, Show in Finder.
- **Conflict resolution**: When conflicts exist, shown in the Plugins settings panel with Keep Local / Keep Remote buttons per conflict.

### 18.12 Plugin UI Extensions

Plugins can register custom UI elements rendered at predefined locations.

**Locations:**

| Location | Scope | Description |
|----------|-------|-------------|
| `toolbar` | Project | Header toolbar (before Glassbox button) |
| `status_bar` | Project | Footer status bar (before command log button) |
| `sidebar_actions_top` | Project | Sidebar, before first action |
| `sidebar_actions_bottom` | Project | Sidebar, after last action |
| `detail_top` | Ticket | Detail panel, above fields |
| `detail_bottom` | Ticket | Detail panel, below attachments |
| `batch_menu` | Selection | Batch toolbar "..." menu |
| `context_menu` | Selection | Right-click ticket context menu |

All 8 locations are wired up in the client: toolbar buttons render in the header, status_bar and sidebar elements render via `refreshPluginUI()` on init and enable/disable, detail_top/detail_bottom render per-ticket in `loadDetail()`, context_menu items are injected into the right-click menu, batch_menu items appear in the batch "..." dropdown when tickets are selected. Toolbar buttons show icon only; all other locations show icon + label.

**Element types:** `button` and `link` are rendered. `toggle`, `switch`, and `segmented_control` are declared in the type system but not yet rendered by the client.

**Registration:** `context.registerUI(elements)` during `activate()`. Served via `GET /api/plugins/ui` filtered by per-project enabled state.

**Actions:** `POST /api/plugins/:id/action` with `{ actionId, ticketIds?, value? }`. Return `{ redirect: 'sync' }` to trigger a sync. Return `{ message: '...' }` to show a toast notification to the user.

**Busy indicator:** When a plugin action triggers sync, a "GitHub Working" label with spinner appears in the footer status bar. The toolbar button is disabled during sync. Multiple busy labels combine (e.g. "GitHub and Claude Working").

### 18.13 Synced Ticket Display

- **List view**: Synced tickets show the plugin's icon (from manifest `icon` field) before the title, between the status button and title input.
- **Column view**: Plugin icon appears inline with the title text in cards.
- **Detail panel**: Sync info in the metadata section shows the plugin icon + "Plugin Name #remoteId" as a clickable link to the remote system. Only shown for plugins enabled on the current project.
- **Context menu**: "Push to [PluginName]" option (with plugin icon) for unsynced tickets, fetched from `/api/backends`.

### 18.14 Feature Flag

Plugin functionality is controlled by the `PLUGINS_ENABLED` build-time flag, **enabled by default**:

- **Build**: Plugins enabled automatically. Disable with `PLUGINS_ENABLED=false npm run build` or `PLUGINS_ENABLED=false npm run dev`
- **Default**: Plugins enabled — routes mounted, UI tab visible, sync hooks active, toolbar buttons shown
- **Implementation**: `src/feature-flags.ts` exports `PLUGINS_ENABLED` constant. Uses `__PLUGINS_ENABLED__` define token (replaced at build time). Falls back to `process.env.PLUGINS_ENABLED` in tsx dev mode (enabled unless explicitly set to `'false'`). Safe in browser (no `process` reference).
- **Guards**: `api.ts` (route mounting), `cli.ts` (plugin loading), `pages.tsx` (settings tab/panel, busy indicator), `settingsDialog.tsx` (bind plugin settings), `app.tsx` (toolbar buttons), E2E tests (skip when disabled).

## Non-Functional Requirements

### 18.15 Security

- Plugin entry points are loaded via dynamic `import()`. Plugins run in the same Node.js process with full access.
- Secret preferences (API tokens) are stored in the OS keychain as the primary store (macOS Keychain / Linux Secret Service), with fallback to the global config file or project settings table when the keychain is unavailable. See [20-secure-storage.md](20-secure-storage.md) for details. The UI masks secret values.
- Plugin configuration is per-project — a plugin enabled for one project doesn't automatically have access to another project's data.

### 18.16 Error Handling

- Plugin load failures don't prevent the server from starting. Failed plugins are listed with error status.
- Sync failures are logged per-ticket. Stale outbox entries (5+ failures) are permanently removed.
- Remote 404/410 errors auto-clean stale sync records.
- Backend connection errors are surfaced via the config dialog's connection test.

### 18.17 Performance

- Plugin loading happens once at startup (no hot-reloading). Reactivation re-runs `activate()`.
- Sync operations run in the request context (not blocking the event loop).
- Push uses direct comparison (not outbox) for field updates — compares timestamps, pushes all fields when modified.
- Comment and attachment sync use text-based deduplication to prevent exponential growth.

### 18.18 Documentation

- `docs/plugin-development-guide.md` — AI-focused guide for building plugins. Must be kept up to date with any plugin system changes.
