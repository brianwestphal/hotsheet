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
- When the retention limit is exceeded, the oldest backup in that tier is deleted.

### 7.2 Manual Backup

- A "Backup Now" button in the settings dialog triggers an immediate 5-minute tier backup.
- Resets the 5-minute timer.
- Returns backup metadata: filename, size, and ticket count.

### 7.3 Backup Listing

- The settings dialog lists all available backups across all tiers.
- Each entry shows: tier, filename, creation date, ticket count, and file size.

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
