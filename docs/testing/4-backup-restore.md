# Backup & Restore Testing

**Risk Level: High**

Backup and restore directly affects data safety. Bugs here can cause data loss, corrupted backups, or failed restores. The backup system involves database dumps, file compression, directory management, and database lifecycle operations (close, replace, reopen).

## Backup Creation

**What to test:** Backups produce valid, restorable archives.

- `createBackup()` produces a `.tar.gz` file in the correct tier directory.
- The backup filename uses the expected timestamp format and is parseable back to a date.
- Backup metadata (ticket count, file size) is accurate.
- Concurrent backup attempts are blocked — a second call while one is in progress returns null.
- After the first backup completes, subsequent calls succeed.

## Three-Tier Rotation

**What to test:** Each tier enforces its retention limits.

- 5-minute tier: keeps at most 12 backups.
- Hourly tier: keeps at most 12 backups.
- Daily tier: keeps at most 7 backups.
- When the limit is exceeded, the oldest backup in that tier is deleted.
- Backups in other tiers are unaffected.

## Backup Listing

**What to test:** All backups are discovered and sorted correctly.

- `listBackups()` returns backups from all three tier directories.
- Each entry includes tier, filename, creation date, ticket count, and file size.
- Results are sorted by creation date (newest first).

## Preview

**What to test:** Preview loads data without modifying the live database.

- `loadBackupForPreview()` opens the backup in a separate PGLite instance.
- The preview database contains the tickets from the backup, not the current live data.
- The live database is unaffected during preview.
- Preview cleanup closes the temporary database and removes the preview directory.
- Previewing one backup while another preview is open cleans up the previous one first.

## Restore

**What to test:** Restore replaces the database atomically and safely.

- Before restoring, a safety backup is automatically created.
- The current database is closed before the directory is replaced.
- After restore, the database contains the tickets from the backup.
- The previous live data is no longer accessible (replaced).
- The safety backup contains the pre-restore data (verifiable by listing backups afterward).
- Markdown sync is triggered after restore.
- The application continues to function normally after restore (new tickets can be created, etc.).

## Custom Backup Directory

**What to test:** Backups go to the right place when a custom directory is configured.

- When `backupDir` is set in file-based settings, backups are created in that directory instead of the default.
- Listing backups reads from the custom directory.
- Tier subdirectories are created inside the custom directory.

## Edge Cases

- Restoring from a backup that has a different schema version (older migrations) — schema should be re-applied.
- Backup of an empty database produces a valid (small) archive.
- Restore with no existing database (first run after data directory deletion).
