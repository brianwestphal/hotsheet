# 135. Empty-Cluster Surfacing

**Status:** Shipped (HS-9576)

Tells the user when their project's database has come up empty over data it used
to hold — the state [45-pglite-robustness.md](45-pglite-robustness.md)'s guard
already detects and refuses to overwrite, but until now only ever wrote to
stderr.

Related: [7-backup-restore.md](7-backup-restore.md) (the artifacts being
protected), [73-snapshot-protection.md](73-snapshot-protection.md) (the
canonical snapshot), [42-repair-database.md](42-repair-database.md) (the
preserved-directory picker this banner points at), and
[2-data-storage.md](2-data-storage.md) §"DB recovery marker" (the surface it
reuses).

---

## 135.1 The problem this exists for

On 2026-08-04 a corrupt-open recovery crashed mid-flight: `db/` had been renamed
aside, the restore had not happened, and the process died. The next start found
no `db/` at all, so PGLite did the only thing it can — created a fresh, empty
cluster. **Nothing was corrupt**, so no recovery path ran, no corrupt-open marker
was written, and no banner appeared. The project simply came up with zero
tickets and looked healthy.

The durability machinery then did its job perfectly, on an empty database: the
snapshot was overwritten and the backup tiers rotated the good tarballs out. The
incident was invisible for a day.

HS-9573 shipped the server-side guard that stops the second half of that — a
cluster **created empty this process**, holding **zero tickets**, over a project
whose content marker says it **used to hold some**, is refused as a source for
snapshots and backups. That preserves the artifacts. It does not preserve the
user's understanding: the guard logs and does nothing else, and an empty project
still looks like a working one.

**The guard buys time; §135 spends it.** A guard the user cannot see is a timer
running down in silence — the existing artifacts survive only until someone
notices and acts, and nothing prompts them to notice.

## 135.2 Requirements

### 135.2.1 The signal

When the guard blocks a durability write, the server MUST record the state in
`.hotsheet/.db-recovery-marker.json` — the same file `GET /api/db/recovery-status`
already serves and the launch-time banner already reads. A record carries:

| field | meaning |
|---|---|
| `kind: 'empty-cluster'` | distinguishes it from the HS-7899 `corrupt-open` record |
| `priorTicketCount` | how many tickets this project's artifacts last captured — i.e. how much is waiting |
| `corruptPath: ''` | no cluster was renamed aside **in this process** |
| `recoveredAt` | when the block was first observed this session |

`kind` is optional on the wire and defaults to `corrupt-open` when absent, so a
marker written by an older server still parses (§135.5).

**`corruptPath` is empty on purpose.** The preserved directory that likely holds
the data was left by an *earlier* process, and this record cannot honestly name
one. Enumerating the candidates is §42's job, and §135 points the user there
rather than guessing.

### 135.2.2 Reusing the HS-7899 surface, not inventing one

The empty-cluster state and the corrupt-open state are different causes with the
same meaning to a user: *your data is not here, and it is recoverable*. They MUST
therefore share the banner, its "Restore from Backup…" / "Dismiss" actions, the
status endpoint, and the dismissal route. Only the copy differs.

### 135.2.3 Copy

The banner MUST say three things the corrupt-open wording does not:

1. **Nothing is broken right now.** "Database failed to load" would send the user
   hunting for a failure that never happened. The empty-cluster copy leads with
   the observable fact — the database is empty — and the count that contradicts
   it.
2. **The existing copies are being actively protected**, not merely available.
   Snapshots and backups are *paused*. Without this the banner reads as a second
   loss rather than a held position.
3. **Check Repair Database first.** A preserved `db-corrupt-*` directory may hold
   **more recent** data than the newest backup. HS-9575 made those selectable; a
   user who does not know they exist restores an older backup and silently loses
   the difference.

### 135.2.4 Not becoming noise

- **Once per project per session.** A blocked project trips the guard on every
  backup tick (5 min) and every snapshot tick. Without a session gate the
  "Dismiss" button would work for a few minutes at a time. The gate is
  process-scoped and keyed by `dataDir`, so one blocked project never banners
  another.
- **Dismissible**, via the existing `POST /api/db/dismiss-recovery`.
- **Self-retracting.** The moment the cluster has rows again — a restore landed,
  or the user simply started working — the guard clears its own created-empty
  flag, and it MUST clear this marker and the session gate at the same point. The
  user should not have to dismiss a warning about a solved problem.
- **Clearing is kind-scoped.** A `corrupt-open` marker MUST survive rows coming
  back: it records that a cluster was renamed aside, which stays true (and still
  worth telling the user) however many tickets exist now.

### 135.2.5 Both writers feed it

Snapshots and backups run on different cadences, and a blocked project will
usually trip both. Rather than designating one writer as the reporting one, the
guard itself reports — **whichever tick fires first tells the user, and the
once-per-session gate dedupes**. This is deliberate: picking a single writer
would make the user's warning depend on which subsystem happened to be enabled.

### 135.2.6 Honest refusal on the manual path

`POST /api/backups/now` and `POST /api/backups/create` return `null` from
`createBackup` for two unrelated reasons, and both used to be reported as
`"Backup already in progress"`. When the guard is what refused, that message is a
lie told to a user who just clicked "Back up now" on a project whose data is
missing — precisely the moment they need the truth. Both routes MUST report the
guard's reason when an `empty-cluster` marker is present.

## 135.3 Implementation

| concern | location |
|---|---|
| Marker read/write/clear + `clearEmptyClusterMarker` | `src/db/recoveryMarker.ts` |
| Guard, session gate, `surfaceEmptyCluster` | `src/db/emptyClusterGuard.ts` |
| Wire schema (`kind`, `priorTicketCount`) | `src/api/db.ts::RecoveryMarkerSchema` |
| Status + dismiss routes (unchanged) | `src/routes/db.ts` |
| Honest 409 reason | `src/routes/backups.ts::noBackupReason` |
| Banner copy | `src/client/dbRecoveryBanner.tsx::formatEmptyClusterBannerLabel` |

**`recoveryMarker.ts` is an extraction, not a new format.** The marker's I/O used
to live in `src/db/connection.ts`, which imports the guard — so a guard that
wrote a marker would have closed an import cycle. `connection.ts` re-exports the
reader and clearer, so every existing caller is untouched.

## 135.4 Testing

- `src/db/emptyClusterGuard.test.ts` — the predicate, the marker write, the
  session gate surviving a dismissal, both-writers dedup, self-retraction,
  kind-scoped clearing, per-project isolation, and the two silence cases (a
  brand-new project, and a cluster whose schema does not exist yet).
- `src/db/emptyClusterSurfacing.e2e.test.ts` — the incident as a **real process
  sequence**: healthy project → backup (which writes the content marker) →
  SIGKILL → `db/` removed → relaunch → the manual backup is refused with the real
  reason and `/api/db/recovery-status` reports `empty-cluster` with the right
  count. Nothing is mocked.
- `e2e/db-recovery-banner.spec.ts` — the browser half: the copy, the restore
  button opening Settings, dismissal hiding the banner and clearing the marker,
  a `corrupt-open` marker still getting the original copy, and a healthy project
  showing nothing. Only `/api/db/recovery-status` is stubbed, in the real wire
  shape.

## 135.5 Compatibility

A marker on disk written before HS-9576 has no `kind`. The reader defaults it to
`corrupt-open` rather than rejecting the file, so an in-flight recovery banner
survives the upgrade.

## 135.6 Known gap

**The guard disarms on the next restart.** `noteClusterCreatedEmpty` fires only
when the open path finds no `PG_VERSION`, so it describes what happened at *this*
open. After a restart the empty cluster exists on disk and is *opened*, not
created — the guard is no longer armed, and the durability writers resume over
the good artifacts. The banner persists (the marker is on disk), but the
protection does not. Tracked as HS-9585.
