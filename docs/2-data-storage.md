# 2. Data Storage

## Functional Requirements

### 2.1 Embedded Database

- The application uses an embedded PostgreSQL database (PGLite, PostgreSQL 17.5) requiring no external database server.
- All data is stored locally in a `.hotsheet/` directory within the project root (or a custom path via `--data-dir`).
- Database schema is managed through inline SQL migrations that run automatically on startup.
- **Database name is `template1` (HS-8585).** PGLite 0.3.x used `template1` as its default database, so all clusters + backup/snapshot tarballs hold our tables there. PGLite 0.4.0 changed the default to `postgres`; to keep existing data readable after the 0.4.x upgrade, every connection is pinned to `template1` via the single `createPglite()` helper (`src/db/pglite.ts`) — never construct `PGlite` directly. Without the pin, 0.4.x would open an existing cluster but connect to an empty `postgres` DB (data still on disk in `template1` but invisible).

### 2.2 Database Tables

#### Tickets Table
- Stores ticket records with fields: id, ticket_number, title, details, category, priority, status, up_next, notes, tags, last_read_at, created_at, updated_at, completed_at, verified_at, deleted_at.
- Ticket numbers are auto-generated from a PostgreSQL sequence (`ticket_seq`) and prefixed with `HS-` (e.g., HS-1, HS-42). Numbers are never reused.
- Notes are stored as a JSON-encoded text array of `{ id, text, created_at }` entries, with legacy plain-text support.

#### Attachments Table
- Stores file attachment metadata: id, ticket_id, original_filename, stored_path, created_at.
- Linked to tickets via foreign key.

#### Stats Snapshots Table
- Stores periodic ticket count snapshots for dashboard charts.

#### Command Log Table
- Stores channel commands and shell command execution entries.

#### Settings Table
- Key-value store for **plugin settings only** (`plugin:*:*` and `plugin_enabled:*` keys). All other project settings have been migrated to file-based storage (see §2.3).

### 2.3 File-Based Settings

- A `settings.json` file in the data directory stores all **shareable** project configuration. This makes settings easy to copy between projects, inspect, and back up, and (per §2.8) it is the one file under `.hotsheet/` that is intentionally **committed to git** so a team can version it. Fields:
  - `appName` — Display name for the project (shown in UI title bar and tabs).
  - `appIcon` — Selected app icon variant (e.g., default, dark, colorful).
  - `ticketPrefix` — Custom prefix for ticket numbers (default: `HS`). The dash separator is added automatically.
  - `authoritativeDataDir` — git-worktree follower pointer (HS-8934, §89.1); structural, stays in `settings.json`.
  - All shareable UI and behavior settings are stored as flat keys at the root level (e.g., `layout`, `sort_by`, `sort_dir`, `categories`, `custom_views`, `custom_commands`, `terminals`, `trash_cleanup_days`, `verified_cleanup_days`, `auto_order`, etc.).
- `secret` / `secretPathHash` moved to the gitignored `secret.json` sidecar (HS-8999, §20 / `src/secret-file.ts`) — never in `settings.json`.

### 2.3.1 Shared vs Local Settings (HS-9002)

- **Problem.** `settings.json` is committed, but historically also held machine/user-specific values — notably `backupDir` (an absolute path that often embeds the user's home directory + email), `port`, the per-device permission/terminal allow-rules, the Announcer's personal-key reference + last-listened timestamp, browser notification permission, and per-screen layout state. These leaked local paths into commits and caused churn.
- **The split (mirrors Claude's `settings.json` / `settings.local.json`).** A second, **gitignored** `settings.local.json` holds machine-local values:
  - **Read = merged, local wins.** The effective settings the app runs on are `{ ...settings.json, ...settings.local.json }` (`readFileSettings` in `src/file-settings.ts`). Layer-specific reads use `readSharedSettings` / `readLocalSettings`.
  - **Write = routed by a per-key default scope** (`defaultScope(key)`). Local-scoped keys: `backupDir`, `port`, `permission_allow_rules`, `terminal_prompt_allow_rules`, `announcer_ai_key_id`, `announcer_last_listened_at`, `notify_permission`, the `detail_*` / `drawer_*` layout keys, and any `*_nudge_dismissed` key. Everything else defaults to shared. `writeFileSettings` auto-routes; `writeSettingsLayer(dataDir, layer, …)` forces a specific layer; `clearLocalOverrides(dataDir, keys)` removes a local override so the shared value re-applies.
- **Migration.** On startup, for every registered project, `migrateLocalScopedKeys` relocates local-scoped keys out of a committed `settings.json` into `settings.local.json` and strips them from the shared file (the HS-8999 secret-sidecar pattern). Idempotent; never clobbers an existing local override (local wins). This auto-cleans an already-committed `settings.json` so `backupDir` et al. stop being tracked.
- **UI (shipped — HS-9004).** A **dialog-wide scope toolbar** sits under the Settings tab strip — an Xcode-build-settings-style segmented control: **Shared** (edit `settings.json`) | **Local overrides** (edit `settings.local.json`) | **Resolved** (the effective view, default). Settings stay in their own tabs; the toolbar re-skins each file-settings field *in place* (mode persists across tab switches, resets to Resolved on each open). Per mode: Resolved shows an origin tag (*from Shared* / *from Local* / *default*) and edits route to each key's default layer (today's behavior); Shared shows the literal `settings.json` value — **even when locally overridden** — plus an "overridden locally" tag; Local shows the override editable with *Reset to shared*, or the inherited value read-only behind *+ Override*. Machine-global settings keep their "Global Setting" badge and are untouched; project-level surfaces that aren't file-settings (plugin toggles, complex list editors — categories, terminals, allow-rules, custom commands, snapshot/repair) are tagged `data-scope-complex` and go read-only ("not locally overridable") outside Resolved — per-layer editing of those is a follow-up. Backed by the layered API (§9): `GET /api/file-settings/layered`, `PATCH /api/file-settings/layer` (`{ layer, settings }`), `POST /api/file-settings/clear-local` (`{ keys }`). Pure layer logic in `src/client/settingsSharing.ts` (`resolveFieldScope`, `scopedDisplayValue`); DOM controller in `settingsScope.tsx`; scalar field writes route through `persistScopedSetting` in `settingsDialog.tsx`.

### 2.4 Settings Migration

- On startup, project settings are automatically migrated from the database settings table to `settings.json`.
- The migration is idempotent and safe to run multiple times.
- Values already in `settings.json` are never overridden by the migration (file values take precedence).
- After migration, the project keys are deleted from the database. Only plugin keys remain.
- This migration runs for both the primary project and all secondary projects registered via tabs.

### 2.5 Lock File

- A `hotsheet.lock` file prevents multiple instances from using the same database simultaneously.
- Contains JSON with `pid`, `startedAt`, and `pidStartTime` (HS-8596 — the lock-writer's process start time from `ps -o lstart`).
- On startup, checks if the lock holder PID is still alive (signal 0). Stale locks from dead processes are automatically removed.
- **Recycled-PID guard (HS-8596).** After a hard crash (SIGKILL / power loss) the lock is left behind with the dead instance's PID; if the OS later reassigns that PID to an unrelated live process, the bare signal-0 check would falsely report "another instance is running" and refuse to launch. So when the recorded PID *is* alive, `acquireLock()` also compares its current start time against the lock's recorded `pidStartTime` — a mismatch proves the PID was recycled, so the lock is treated as stale and removed. A *positive* start-time match is the only case treated as a genuinely live second writer. The disposition logic is the pure, unit-tested `classifyExistingLock()`.
- **Orphaned-lock reclaim (HS-8706).** The HS-8596 guard still fell back to "conservatively live" (refuse to launch) when it could *not* confirm the alive PID was the original writer — an old lock with no `pidStartTime`, or no readable `ps` start time. On a GUI launch (Dock / Spotlight, no terminal) that would mean `acquireLock()` silently `process.exit(1)`-ed the sidecar before the server started, and the Tauri shell would spin on the "Starting Hot Sheet…" splash forever. (This was originally fingered as the HS-8704 hang, but the captured `startup.log` later showed the actual cause was a cwd-relative skill-install crash on the primary launch path — `mkdirSync('/.claude')` → `ENOENT` → FATAL; see §6 / HS-8706. The lock-reclaim here remains valid latent hardening for the recycled-PID case.) Because the boot path has *already* established that no live Hot Sheet instance exists before it ever acquires a lock (a real instance always holds the responsive global `instance.json`, and finding one makes the new process *join* it and exit), the primary-startup and project-restore call sites pass `acquireLock(dataDir, { reclaimUnverified: true })`. With that hint, an alive-but-unverifiable PID is reclaimed as the recycled orphan it must be, instead of wedging the launch. The surviving fatal exit (a *positive* start-time match) is now recorded to the durable startup log (`~/.hotsheet/startup.log`, §8) so it is diagnosable on a GUI launch.
- **Shutdown-drain lock-wait (HS-8706).** This was the actual cause of the installed-app launch hang (visible as "every other launch works"). Quitting Hot Sheet runs `gracefulShutdown` (§45.3), whose §73 snapshot (CHECKPOINT + gzip dump) and DB-close phases can block the process for *seconds* and which only releases `hotsheet.lock` at the very end (after the DB is fully closed — releasing earlier would risk two processes opening the same PGLite cluster). During that window the old process is alive, its HTTP port is wedged (so a relaunch can't *join* it), and the lock is still held (so a relaunch can't *acquire* it). The old `acquireLock` FATAL-exited instantly → splash hang; whether a relaunch landed inside or outside the shutdown window produced the alternation. The primary boot path (`cli.ts::initializeProject`) now calls `acquireLockWaitingForShutdown(dataDir, { reclaimUnverified: true })`, which — on seeing a genuinely-live holder that is *not* serving its port — polls (every 250 ms, up to 15 s) for the holder to release the lock, then acquires. Each poll re-classifies, so a holder SIGKILL'd mid-shutdown (pid dies, lock left behind) is reclaimed as stale rather than waited on. Only if the holder is genuinely wedged past the deadline does it FATAL — no worse than the old instant exit, but only after giving the common case time to resolve.
- If the lock file belongs to the current process (same PID), `acquireLock()` returns immediately instead of terminating. This allows a project to be re-registered after being removed from a tab without the server killing itself.
- Lock is cleaned up on process exit.

### 2.6 Instance File

- An `instance.json` file is written to `~/.hotsheet/` on server startup and removed on exit.
- Contains `port` and `pid` of the running server.
- Used by the CLI for `--list` and `--close` commands, and for detecting whether a running instance can be joined instead of starting a new one.
- **A process only ever removes its OWN instance file.** `removeInstanceFile` is gated on a PID match, and `cleanupStaleInstance` (run by every new launch) deletes the file **only when the owning PID is dead** (both `!pidAlive`). **Live-owner preservation (HS-8706):** when the owning PID is still alive but its HTTP port doesn't answer the 2s probe — the owner is mid-startup, transiently busy (event loop blocked), or draining during a `--replace` handoff — `cleanupStaleInstance` returns "not cleaned up" and leaves the file untouched. Deleting a live owner's file would let the new launch read `null`, conclude no instance is running, start its own server for the restored project, and collide on the `hotsheet.lock` the live process still holds → the launch hang. (See §2.5 for the lock-wait that makes that collision recoverable rather than fatal.)

### 2.7 Projects Registry

- A `projects.json` file in `~/.hotsheet/` persists the list of registered project `dataDir` paths across server restarts.
- On startup, previously registered projects whose directories still exist are automatically re-registered.
- When a project is added or removed via the API, the file is updated immediately.

### 2.8 Gitignore Management

- On startup and whenever a project is opened/registered, detects if the project is a git repository (`src/gitignore.ts`).
- **HS-8989** — automatically maintains the canonical rules in the project's `.gitignore`:
  ```
  /.hotsheet/*
  !/.hotsheet/settings.json
  ```
  This ignores everything in `.hotsheet/` (the DB, worklists, backups, the
  `secret.json` sidecar where the per-project secret lives per HS-8999, and the
  `settings.local.json` machine-local settings per HS-9002 §2.3.1) **except**
  `settings.json` — the shareable project config (categories, custom views,
  commands, terminals) — so a team can version it. Any older / hand-written
  `.hotsheet` ignore line (e.g. `.hotsheet/`, `/.hotsheet/`) is replaced with the
  canonical block; it's a no-op when the rules are already exactly present.
- **Opt-out (rarely needed):** if the user leaves a **commented-out** matching rule
  in `.gitignore` (e.g. `# /.hotsheet/*`), Hot Sheet treats that as "the user manages
  this themselves" and leaves the file untouched.
- Provides API endpoints to check status and trigger the update from the UI.

## Non-Functional Requirements

### 2.9 Data Locality

- All data remains on the local machine. There is no cloud sync, external API dependency, or remote storage.

### 2.10 Zero Configuration

- The database initializes automatically on first run with no manual setup, provisioning, or configuration required.

### 2.11 Data Integrity

- Only one application instance may access the database at a time, enforced by the lock file mechanism.
- Soft-delete is the default for ticket removal; hard delete is a separate, explicit operation.
