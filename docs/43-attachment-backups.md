# 43. Attachment Backups (Design)

HS-7900. Companion to [41. Backup JSON co-save](41-backup-json-cosave.md) and [7. Backup & Restore](7-backup-restore.md). Covers the binary blobs under `.hotsheet/attachments/<file>` that neither the PGLite tarball nor the HS-7893 JSON co-save touch — both formats only carry the `attachments` table rows, and `stored_path` in those rows points at live files that can disappear.

> **Status:** §43.6 backup-side capture, §43.7 manifest re-analysis, §43.8 daily GC, §43.9 restore re-hydration all **shipped** (HS-7929 + HS-7937). The design below describes the implemented system.

## 43.1 Goals

1. **Every attachment blob is captured at least once** in a place that survives the live `.hotsheet/attachments/` dir being deleted, replaced, or restored from an older tarball.
2. **Restore from any backup re-hydrates its attachments** — paths in restored DB rows resolve to real files even if the live dir is younger than the backup.
3. **Backup folder stays the source of truth.** Custom `backupDir` (e.g. a Google Drive folder per the HS-7891 incident) covers attachments too — no separate "attachment backup root" knob.
4. **Per-user direction (HS-7900 ticket notes):** centralised hash-addressed store, per-backup manifest, daily orphan GC. Disk size is not a concern.

Non-goals:
- Bandwidth optimisation when `backupDir` is a slow remote filesystem (Google Drive, OneDrive). The user accepted this trade-off explicitly: re-uploading the same blob multiple times to a remote drive is fine because the hash store dedups within the drive itself.
- Encryption-at-rest. Attachments live unencrypted today and the backup mirror inherits that property.
- Cross-machine sync of the hash store. Each machine's backup root is independent.

## 43.2 Decision: hash-addressed store + per-backup manifest

Of the four options laid out in HS-7900:

| Option | Verdict |
|--------|---------|
| 1. Mirror to `.hotsheet/attachments-backup/` write-once | Rejected — duplicates everything (no dedup), and lives outside the backup root so a custom `backupDir` (Google Drive) doesn't cover it |
| 2. Bundle into the existing tarball | Rejected — every 5-min backup re-bundles every blob; users with 100+ MB of attachments would hammer disk + Google Drive sync every 5 minutes |
| **3. Hash-addressed dedup keyed by content hash** | **Chosen.** Each blob is stored once under `<backupRoot>/attachments/<sha>`; per-backup manifest lists the blobs that backup needs |
| 4. Hard-link the live dir | Rejected — falls apart on cross-fs `backupDir` (Google Drive folder), and the live attachments naming is `<TICKET>_<basename><ext>` so the hard-link tree would mirror that mutable path scheme |

The user-supplied direction in HS-7900 maps cleanly onto Option 3.

## 43.3 File layout

```
<backupRoot>/                                # default `.hotsheet/backups/`, or custom `backupDir`
├── attachments/
│   ├── <sha256-hex>                          # raw blob, content-addressed
│   ├── <sha256-hex>
│   └── …
├── 5min/
│   ├── backup-2026-04-27T07-00-00Z.tar.gz    # PGLite dump (HS-7891)
│   ├── backup-2026-04-27T07-00-00Z.json.gz   # JSON co-save (HS-7893)
│   ├── backup-2026-04-27T07-00-00Z.attachments.json   # NEW: per-backup manifest
│   ├── backup-2026-04-27T07-05-00Z.tar.gz
│   ├── …
├── hourly/  (same shape)
└── daily/   (same shape)
```

**Why a single shared `attachments/` dir, not per-tier?** Hash-addressed dedup only pays off when every backup writes into the same pool. Splitting per tier would either (a) duplicate every blob across tiers or (b) require cross-tier lookups during restore — both worse than one pool.

**Why not under `<backupRoot>/<tier>/attachments/`?** Same reason: one pool maximises dedup, and the GC walks one location instead of three.

## 43.4 Hash function

`sha256` (Node `crypto.createHash('sha256')`, hex-encoded). Reasons:

- Sufficient length to make collisions astronomically unlikely with the largest plausible attachment counts (millions of blobs).
- Already a well-known content-addressing scheme; matches the convention in package managers, IPFS, and Git LFS.
- Node's built-in implementation is available on every supported platform without extra deps.

`sha1` would be smaller (40 hex chars vs. 64) but the collision-resistance margin is uncomfortable when the blob set is user-controlled. `blake3` is faster but requires a native dep; not worth the build-pipeline complexity here.

## 43.5 Manifest format

```jsonc
// backup-<TS>.attachments.json
{
  "schemaVersion": 1,
  "createdAt": "2026-04-27T07:00:00Z",                 // ISO timestamp of the backup
  "tarball": "backup-2026-04-27T07-00-00Z.tar.gz",     // sibling filename for cross-reference
  "entries": [
    {
      "attachmentId": 42,                              // attachments.id (DB row primary key at backup time)
      "ticketId": 1234,                                // attachments.ticket_id
      "originalName": "screenshot.png",                // attachments.original_name (the user-facing name)
      "storedName": "HS-1234_screenshot.png",          // basename of attachments.stored_path
      "sha": "9f2f3a…",                                // sha256 hex — also the filename under <backupRoot>/attachments/
      "size": 84129                                    // bytes (sanity check + future analytics)
    },
    …
  ]
}
```

**No nested objects beyond the entry array.** The manifest is read by both the GC + the restore flow, both of which only need the per-entry sha + filename pair. Keep it boring.

**`schemaVersion`** lives in `src/db/connection.ts` next to the existing `SCHEMA_VERSION` so the JSON co-save and the manifest stamp the same generation. Bump together when either format changes shape.

**Atomic write** mirrors HS-7893's `writeJsonExportAtomically`: tmp + `fsyncSync` + `renameSync`. A crash mid-write leaves either the previous manifest or no manifest at all — both recoverable per §43.7.

## 43.6 Backup flow

After the existing CHECKPOINT + `dumpDataDir` + JSON co-save sequence in `createBackup`:

1. Read every row from the `attachments` table (the dump captures these rows; we re-query the live DB for convenience and consistency).
2. For each row whose `stored_path` exists on disk:
   a. Stream the file through `crypto.createHash('sha256')` → hex digest.
   b. If `<backupRoot>/attachments/<sha>` does not exist, copy the file in (atomic: write `<sha>.tmp` + rename). Use `link()` first and fall back to `copyFile()` so same-filesystem copies are O(1).
   c. Append a manifest entry with `{attachmentId, ticketId, originalName, storedName, sha, size}`.
3. For rows whose `stored_path` does NOT exist on disk: log a warning, skip (the row is already pointing at a missing file; no manifest entry to add).
4. Write the manifest atomically as `backup-<TS>.attachments.json` next to the tarball + JSON.
5. `pruneBackups` is extended: when a tarball + JSON pair is deleted by retention/maxAge, its manifest sibling is deleted too. The orphan blobs (referenced only by the deleted manifest) are left behind; the daily GC sweeps them up.

**Cost.** First backup of N attachments writes N copies. Subsequent backups only write the diff (new files + truly-new content); identical re-uploads are no-ops. Per the user direction, disk size is not a concern.

**Failure mode.** Like the JSON co-save, manifest+blob writes are best-effort: a failure logs and continues. The tarball is still written. If the manifest is missing, the next §43.7 re-analysis pass rebuilds it.

## 43.7 Manifest re-analysis (when missing)

Per the user direction: *"re-analyze and recreate if the manifest is ever missing"*. On startup (and at the head of each backup cycle), the scheduler walks every tarball and:

1. If `backup-<TS>.attachments.json` exists, skip.
2. If the tarball is younger than 24 hours, skip — assume the manifest will be written by the next backup or by the explicit failure path. (Avoids hashing every live attachment on every boot.)
3. Otherwise: re-hydrate the manifest by:
   a. Loading the `.json.gz` co-save sibling (cheaper than extracting the tarball). Extract the `attachments` rows.
   b. For each row, hash the file at `stored_path` if it still exists, and add a manifest entry.
   c. For rows whose live file is missing, scan `<backupRoot>/attachments/` for any blob whose name matches a hash already recorded for that `attachmentId` in another manifest — recover the entry. Otherwise, drop the entry with a warning.
   d. Write the rebuilt manifest atomically.

Re-analysis is best-effort. A backup whose attachments dir was already swept by GC before the manifest got rebuilt will lose those entries — same outcome as the user deleting them manually. The warning surfaces in the server log; surfacing it in the Settings → Backups UI is a future enhancement.

## 43.8 Daily GC

Per the user direction: *"once daily, go through backup manifests and check if there are attachments that are no longer needed. remove no longer referenced attachments"*.

**Schedule.** A new daily timer in `src/backup.ts` parallel to the existing daily-tier timer, but independent of the backup cadence. Runs at startup (catch-up) and every 24h thereafter.

**Algorithm.**
1. Scan `<backupRoot>/{5min,hourly,daily}/*.attachments.json`.
2. Union every manifest's `entries[].sha` into a `Set<string>`.
3. List every file under `<backupRoot>/attachments/`.
4. Delete any file whose name is not in the Set.

**Safety rails.**
- If ANY manifest fails to parse, the GC aborts (don't delete blobs based on a partial reference set).
- If `<backupRoot>/attachments/` doesn't exist, the GC is a no-op.
- The GC logs the count of deletions + the count of bytes reclaimed; surfaced in the server log only for v1.

**Why daily and not on every backup?** Hashing + filesystem walk is cheap but stat()ing thousands of files on a slow remote drive (Google Drive) every 5 minutes adds up. Daily is the cadence the user asked for and it keeps the orphan window bounded to 24h.

## 43.9 Restore flow

The existing `POST /api/backups/restore` flow is extended to:

1. Open the tarball as today.
2. Look for the sibling manifest (`backup-<TS>.attachments.json`). If absent, restore proceeds without copying attachments — paths in the restored DB rows may dangle.
3. For each manifest entry: copy `<backupRoot>/attachments/<sha>` to `<dataDir>/attachments/<storedName>`. Update the corresponding `attachments` row's `stored_path` to the new location (handles `dataDir` differing from the time of backup, e.g. machine moves).
4. If a target `<dataDir>/attachments/<storedName>` already exists with a different content hash, append `-restored-<TS>` to the storedName so we don't trample a live file the user might still be using.

The Settings → Backups Preview flow does NOT copy attachments — preview is read-only and short-lived. Preview UI continues to ignore attachment paths (matching today's behavior).

## 43.10 Open questions / explicit follow-ups for the implementation ticket

These are intentionally NOT decided here so HS-7929 (implementation) can revisit with code in front of it:

1. **Multi-window race.** Two Hot Sheet windows on the same project both kicking the GC simultaneously. Cheap fix: a `<backupRoot>/.gc.lock` advisory file with a stale-lock timeout (mirrors `hotsheet.lock`).
2. **Transient blobs from preview.** Preview loads a backup into a temp PGLite — should those attachment row inserts trigger a re-hash? No: preview never writes through the live DB and the manifest re-analysis won't pick up `_preview/` files.
3. **Settings UI surfacing.** The Settings → Backups dashboard could grow a "Last GC: 2 hours ago, reclaimed 12 MB" line. Out of scope for v1 implementation; punt to a follow-up if the user wants visibility.
4. **Big-blob streaming.** `crypto.createHash` accepts a stream; the implementation should `pipeline(createReadStream(path), hash, …)` not `readFileSync` so a 200 MB attachment doesn't blow up the heap.

## 43.11 Cross-references

- §7 — backup tier semantics + retention; this design re-uses `pruneBackups` and the tier dirs.
- §41 — JSON co-save; same atomic-write pattern, same `SCHEMA_VERSION` stamping discipline.
- §42 — Database Repair; restore flow integration point if a repaired DB also needs its attachments re-hydrated.
- HS-7891 incident retro — motivation for the "every backup tier writes into a shared backupDir that may be remote" constraint.
