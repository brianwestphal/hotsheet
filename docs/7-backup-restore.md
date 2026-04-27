# 7. Backup & Restore

## Functional Requirements

### 7.1 Automatic Backups

The application runs a three-tier automatic backup system:

| Tier | Interval | Retention |
|------|----------|-----------|
| 5-minute | Every 5 minutes | 12 backups (~1 hour) |
| Hourly | Every 60 minutes | 12 backups (~12 hours) |
| Daily | Every 24 hours | 7 backups (~1 week) |

- Backups are PGLite database dumps stored as `backup-{ISO-TIMESTAMP}.tar.gz`.
- Stored in `.hotsheet/backups/{tier}/` by default, or in a custom directory specified via the `backupDir` file-based setting.
- Pruning uses both count-based (maxCount) and time-based (maxAge) criteria: backups that exceed the retention count OR are older than the tier's maximum age are deleted.

### 7.2 Manual Backup

- A "Backup Now" button in the settings dialog triggers an immediate 5-minute tier backup.
- Resets the 5-minute timer.
- Returns backup metadata: filename, size, and ticket count.

### 7.3 Backup Listing

- The settings dialog lists all available backups across all tiers.
- Each entry shows: tier, creation date, and file size.

### 7.4 Backup Preview

- Any backup can be loaded for read-only preview without modifying the current database.
- A banner appears indicating preview mode with the backup date.
- The preview shows tickets, stats (total, open, up next), and supports both list and column views.
- The detail panel is read-only during preview.
- Preview uses a temporary PGLite database instance.
- Canceling preview cleans up the temporary database and returns to the live view.

### 7.5 Restore

- Any backup (including from preview) can be restored.
- Before restoring, a safety backup of the current database is automatically created (preventing accidental data loss).
- The restore process:
  1. Creates a safety backup
  2. Closes the current database connection
  3. Removes the current database directory
  4. Loads the backup data into a new PGLite instance
  5. Adopts the new database connection
  6. Triggers a markdown sync

### 7.6 Custom Backup Directory

- The backup storage location can be changed via the `backupDir` setting in the settings dialog.
- When empty, defaults to `.hotsheet/backups/` inside the data directory.

## Non-Functional Requirements

### 7.7 Data Safety

- A safety backup is always created before restore, ensuring no data loss even if the restore process fails or the wrong backup is chosen.
- Backups are self-contained database dumps that can be restored independently.
- Before each `dumpDataDir()`, the backup writer issues `CHECKPOINT;` so the snapshot's `pg_control` and the captured data files agree on the current WAL position. Without this, freshly-modified databases could produce tarballs that fail to load with `PANIC: could not locate a valid checkpoint record` (HS-7891).
- On startup the scheduler catches up on overdue backups: any tier whose newest backup is older than the tier's interval (5min/hourly/daily) gets a fresh backup immediately. Without the catch-up, daily backups never fire for users who restart Hot Sheet within 24 hours of starting it (HS-7894).
- Open-failure recovery preserves the original data directory rather than deleting it. A stale `postmaster.pid` from an unclean shutdown is removed and reopened first; only if that retry also fails is the directory renamed to `db-corrupt-<timestamp>` and a new empty cluster created — and even then a rename failure aborts auto-recreate rather than rmSync'ing live data (HS-7888). The underlying error is also logged so the root cause is visible (HS-7889).
- The backup UI surfaces real API errors (e.g. PGLite PANIC text from a failed restore) instead of generic "Restore failed" / "Failed to load backup preview" labels (HS-7890).

### 7.8 Disaster-Recovery Runbook

When all recent tarballs fail to load with `PANIC: could not locate a valid checkpoint record` (the WAL-checkpoint-corruption pattern from HS-7891), recovery is still possible using a native `pg_resetwal`. Follow these steps once; the fixes above should make this unnecessary going forward, but the runbook stays here for catastrophic cases:

1. **Quit Hot Sheet** with `hotsheet --close` (or `⌘Q` in the desktop app). Confirm no `hotsheet` processes remain.
2. **Move `.hotsheet/db` aside** as `.hotsheet/db-bad-<date>` so the live directory is untouched if recovery fails.
3. **Locate a usable backup tarball.** Try the most recent tarball first via a short Node script:
   ```js
   import { PGlite } from '@electric-sql/pglite';
   const db = new PGlite('<extracted-tarball-dir>');
   await db.waitReady;
   const r = await db.query("SELECT COUNT(*) FROM tickets");
   console.log(r.rows[0]);
   ```
   If it opens, you can `loadDataDir` it via the normal Restore flow in Settings — skip to step 7.
4. **If all recent tarballs PANIC,** extract the tarball into a temp dir as raw files (`tar -xzf backup-….tar.gz -C /tmp/recovery`), then:
   ```bash
   rm -f /tmp/recovery/postmaster.pid
   pg_resetwal -f /tmp/recovery
   ```
   `pg_resetwal` rewrites `pg_control` to point at a fresh checkpoint, leaving the table data intact. Use the matching Postgres major version's binary — PGLite uses Postgres 17, so `brew install postgresql@17` and call `/opt/homebrew/opt/postgresql@17/bin/pg_resetwal`.
5. **Verify** the recovered directory opens with the script from step 3. The `tickets` count should match what you had before the corruption.
6. **Move the recovered directory into place** as `.hotsheet/db/`.
7. **Relaunch Hot Sheet.** All tickets should be back. The corrupt original under `.hotsheet/db-bad-<date>/` can be deleted once you've confirmed the recovery is good.

After recovery, take a manual backup immediately (Settings → Backups → Backup Now) to capture the known-good state with the new CHECKPOINT-before-dump guard.

### 7.9 Launch-Time Recovery Banner

When the open-failure recovery path falls all the way through to renaming the live `db/` directory aside as `db-corrupt-<TS>` and creating a fresh empty cluster (HS-7888 last-resort), the server writes `<dataDir>/.db-recovery-marker.json` recording `{ corruptPath, recoveredAt, errorMessage }`.

On the next launch (or any reload while the marker is still present), the client polls `GET /api/db/recovery-status`. If a marker exists, a red banner appears at the top of the window (HS-7899):

> **Database failed to load N minutes ago and was reset to empty (errorMessage). Restore from a backup to recover your tickets.**

The banner has two actions:

- **Restore from backup…** — opens Settings → Backups, where the user picks a tarball from any tier and clicks Restore.
- **Dismiss** — calls `POST /api/db/dismiss-recovery`, which removes the marker. Use this when the user has decided to start fresh or has already recovered out-of-band.

A successful restore via the Settings flow also clears the marker server-side, so the banner won't reappear on the next launch.

The marker file is intentionally persisted (rather than process-local) so the prompt survives subsequent restarts until the user explicitly responds — silently dropping the prompt across a restart was the failure mode the original 2026-04-27 incident exposed.
