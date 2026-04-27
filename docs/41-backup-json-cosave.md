# 41. Backup JSON Co-Save

Companion to [7. Backup & Restore](7-backup-restore.md). Each scheduled backup writes a versioned, gzipped JSON snapshot of every row in every Hot Sheet table alongside its PGLite tarball.

## Functional Requirements

### 41.1 Co-Save On Every Backup

- Each call to `createBackup(dataDir, tier)` writes two files into the tier directory:
  - `backup-<TS>.tar.gz` — the existing PGLite `dumpDataDir('gzip')` tarball (primary).
  - `backup-<TS>.json.gz` — a gzipped JSON snapshot of every row in every Hot Sheet table (escape hatch).
- The two files share the same timestamp so they can be paired by name.
- A failure writing the JSON sibling logs an error but does **not** fail the backup. The tarball is the primary artifact; the JSON is a defense-in-depth rescue file.

### 41.2 JSON Format

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-04-27T12:00:00.000Z",
  "tables": {
    "tickets": [ /* every row from `SELECT * FROM tickets` */ ],
    "attachments": [ /* every row including stored_path; blobs are NOT included */ ],
    "settings": [ ... ],
    "stats_snapshots": [ ... ],
    "command_log": [ ... ],
    "ticket_sync": [ ... ],
    "sync_outbox": [ ... ],
    "note_sync": [ ... ],
    "feedback_drafts": [ ... ]
  }
}
```

- `schemaVersion`: integer constant (`SCHEMA_VERSION` in `src/db/connection.ts`). Bumped manually whenever `initSchema` changes a table's shape (added/removed/renamed/retyped column, new table). Any reader can compare the saved value to the current code's value to decide whether the rows are still loadable as-is.
- `exportedAt`: ISO 8601 timestamp at the moment the export was built. Distinct from the filename timestamp because the filename is fixed when the tarball write begins.
- `tables`: hard-coded list — every table created by `initSchema` in `src/db/connection.ts`. Hard-coding (not `information_schema.tables`) keeps the export deterministic across PGLite versions and avoids picking up internal tables. When a new table is added in `initSchema`, append it to the `TABLES` constant in `src/dbJsonExport.ts` AND bump `SCHEMA_VERSION`.
- A missing table (e.g. mid-migration) yields `[]` rather than throwing, so the rescue path stays available even when the schema is in flux.

### 41.3 Atomic Write

JSON is written atomically using POSIX rename:

1. Serialise the export to UTF-8 JSON.
2. `gzipSync` the bytes.
3. `openSync` `<path>.tmp`, `writeSync` the gzipped buffer, `fsyncSync` to flush to disk, `closeSync`.
4. `renameSync` `<path>.tmp` to `<path>`.

A crash mid-write leaves either the previous file (or nothing) at `<path>` — never a partial file. If the rename fails, `<path>.tmp` is unlinked so it doesn't leak.

### 41.4 Pruning

- `pruneBackups()` deletes the `.tar.gz` AND the matching `.json.gz` sibling whenever it prunes a backup, so the two files stay in lockstep across the same retention/maxAge policy as the tarball.
- Orphan `.json.gz` files (e.g. from a tarball that was deleted out-of-band) are tolerated but eventually cleaned out the next time the corresponding timestamp would be pruned.

### 41.5 Restore

- The JSON sibling is **not** wired into the Settings → Backups restore UI in this iteration. Restore continues to load the tarball via `loadDataDir`.
- The JSON is a manual rescue path: when every recent tarball PANICs (per the HS-7891 incident pattern), a developer / future-Claude can read the JSON, rebuild the schema from `initSchema`, and `INSERT` the rows table-by-table. See [7-backup-restore.md §7.8](7-backup-restore.md#78-disaster-recovery-runbook).

## Non-Functional Requirements

### 41.6 Disk Footprint

The JSON sibling roughly equals the tarball size for typical Hot Sheet data — both compress similarly because the payload is dominated by ticket text. Combined cost is ~2× the previous backup-only footprint per timestamp; worth it for the rescue capability since 5min/hourly tiers prune aggressively (12-deep) and only daily holds 7 copies.

### 41.7 Attachment Blobs (Out of Scope)

Attachment rows are exported, but the binary blobs under `.hotsheet/attachments/<sha>` are **not** copied into either the tarball or the JSON. Tracked separately for an attachment-backup investigation (HS-7900) so the rescue path actually round-trips attached files.

## Implementation

- `src/dbJsonExport.ts` — `buildJsonExport()`, `writeJsonExportAtomically()`, `jsonSiblingFilename()`, `JsonDbExport` interface.
- `src/db/connection.ts` — `SCHEMA_VERSION` constant.
- `src/backup.ts` — `createBackup()` calls `buildJsonExport` + `writeJsonExportAtomically` after the tarball write; `pruneBackups()` deletes the JSON sibling when it deletes the tarball.

## Tests

- `src/dbJsonExport.test.ts` — pins the export shape, gzip round-trip, atomic-write contract, and sibling filename mapping.
- `src/backup.test.ts` — integration test that creates a real backup and asserts both `.tar.gz` and `.json.gz` files exist, with the JSON containing the expected ticket rows + current `schemaVersion`.
