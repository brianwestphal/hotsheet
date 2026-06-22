# 88. Scheduled Periodic Plugin Sync

**Status: SHIPPED** (HS-8933, 2026-06-22). Generic in the sync engine; first
adopter is the GitHub Issues plugin.

## 88.0 Goal

Keep a project's tickets in sync with a remote backend (GitHub, etc.)
**automatically in the background**, without the user having to click the "Sync"
button. Builds on the manual-sync full-reconcile fix (HS-8931, see
[18-plugins.md](18-plugins.md)).

## 88.1 Configuration

A plugin opts in by declaring a `sync_interval_minutes` preference in its
manifest. The GitHub Issues plugin ships it as a **select** in the
Synchronization group:

| Value | Label |
| --- | --- |
| `0` | Off |
| `1` | 1 minute |
| `5` | 5 minutes |
| `15` | 15 minutes (**default**) |
| `30` | 30 minutes |
| `60` | 1 hour |

- **Default: 15 minutes — on by default** for a configured + enabled GitHub
  plugin (the manifest default is `"15"`, applied when the setting is unset).
- **Minimum: 1 minute** (`MIN_SYNC_INTERVAL_MINUTES`). `0` / empty / invalid =
  off.
- The interval is a **per-project** setting (`plugin:<id>:sync_interval_minutes`
  in the project DB), so each project schedules independently.

## 88.2 Incremental vs. full reconcile

Each scheduled run normally does an **incremental** pull (`since =
max(last_synced_at)`) for efficiency. To self-heal the HS-8931 "stranded issue"
class — a remote item with no local sync record that is older than the
incremental watermark, which incremental pulls can never reach — every timer
does a **full reconcile**:

- on its **first run** after (re)start, and
- roughly **once an hour** thereafter.

The full-reconcile cadence (`fullEvery`) is derived from the interval so it's
~hourly regardless: 15 min → every 4th run; 1 min → every 60th; 60 min → every
run. (`runSync(pluginId, { fullPull })`, see
[18-plugins.md](18-plugins.md) §Pull.)

## 88.3 Engine (`src/plugins/syncEngine.ts`)

- Timers are keyed **per `(plugin, project)`** (`${pluginId}::${dataDir}`) so a
  second project never clobbers the first's schedule. `syncRunCounts` tracks each
  timer's run number for the full-reconcile decision.
- `startScheduledSync(pluginId, intervalMs, dataDir)` / `stopScheduledSync(
  pluginId, dataDir?)` (without `dataDir`, stops every project's timer for the
  plugin) / `stopAllScheduledSyncs()` (shutdown) / `isSyncScheduled(pluginId,
  dataDir?)`.
- `applyScheduledSyncFromConfig(pluginId, dataDir)` reads the project's interval
  setting (falling back to the manifest default), checks the plugin is enabled
  for the project, and starts/stops the timer accordingly. Idempotent.

## 88.4 Lifecycle wiring

- **Boot:** after `loadAllPlugins()` resolves, `scheduleSyncsForAllProjects()`
  (`cli.ts`) starts schedules for every registered project — so auto-sync runs
  **server-side**, independent of whether a client is connected.
- **Project open:** `registerProject` / `registerExistingProject`
  (`src/projects.ts`) call `scheduleSyncsForProject(dataDir)` (fire-and-forget)
  so projects opened after boot get scheduled too.
- **Config / enablement change:** the `enable` / `disable` / `reactivate` plugin
  routes (`src/routes/plugins.ts`) call `applyScheduledSyncFromConfig` /
  `stopScheduledSync` so editing the interval or toggling the plugin takes effect
  immediately.
- **Shutdown:** `stopAllScheduledSyncs()` clears every timer.
- The pre-existing manual `POST /api/plugins/:id/sync/schedule` route still works
  for explicit scheduling and now stops per-project.

## 88.5 Tests

`src/plugins/syncEngine.test.ts`:
- the first scheduled run does a full pull (reconciles a stranded issue);
- `stopScheduledSync` targets only the given project (per-`(plugin,dataDir)`
  keying);
- `applyScheduledSyncFromConfig` schedules when enabled with a valid interval,
  falls back to the manifest default when unset, doesn't schedule when disabled,
  stops when set to Off, and ignores plugins without the preference.

## 88.6 Out of scope / follow-ups

- The badge showing how out-of-sync a project is (incoming + outgoing pending)
  is tracked separately (HS-8791).
- Scheduling currently covers loaded plugins that declare the preference; no
  global "pause all background sync" switch yet.
