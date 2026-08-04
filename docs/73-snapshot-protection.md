# 73. Snapshot Protection — NodeFS live + atomic snapshot + auto-restore

HS-8583. The low-RAM, ship-first robustness feature that came out of the HS-8575
investigation (`docs/72-snapshot-persistence.md`, esp. §72.6 — "Option D"). Greenlit
for implementation; this doc is the design of record. Three shaping decisions were
confirmed with the user up front (see §73.2).

> **Status: Shipped (fully implemented).** The phased follow-ups in §73.10 (HS-8586 / HS-8587 / HS-8594 / HS-8588) all landed. Unlike §72 (which proposes moving the *live*
> store into memory), Option D keeps today's on-disk `nodefs` cluster exactly as-is and
> adds an atomic snapshot + automatic recovery around it. It is independently shippable
> and does **not** require adopting `memoryfs`.

## 73.1 Why this exists

The HS-8575 investigation established two facts:

1. Our PGLite cluster (`nodefs`, write-through to `<dataDir>/db/`) corrupts because it's
   a **multi-file format that must stay mutually consistent on disk**, and a crash mid-
   update (or the HS-7932 fsync-no-op window) leaves it inconsistent. No amount of
   defensive patching (HS-7888 / 7889 / 7931 / 7935) removes that class.
2. **`nodefs` is already the low-RAM mode** — Postgres pages data in/out of the real
   files, so the whole DB is *not* held in RAM. Moving fully in-memory (§72) would
   *raise* RAM, which the user flagged as a non-starter for everyday use.

Option D threads that needle: **keep the low-RAM live cluster, but stop trusting it as
the source of truth.** Maintain one atomically-written snapshot of the whole DB and
*automatically restore from it* whenever the live cluster comes up broken. Corruption
stops being a data-loss event and becomes a transparent, bounded-loss self-heal — at
**zero extra RAM**.

The honest limitation, stated up front: this does **not** make corruption *impossible*
(the live files remain the fragile format). It makes it **non-fatal and self-healing**,
with loss bounded to "writes since the last snapshot" (seconds, given §73.3's debounce).
The corruption-proof guarantee is what the §72 `memoryfs` approaches buy; Option D is the
cheaper, RAM-free 80%.

## 73.2 The model + the three confirmed decisions

```
<dataDir>/.hotsheet/
  db/                 ← live nodefs cluster (unchanged, low-RAM, fragile)
  snapshot.tar.gz     ← canonical trusted snapshot (atomic, debounced ~2s)
  snapshot.tar.gz.tmp ← write staging (tmp + fsync + rename)

backupDir/{5min,hourly,daily}/backup-<TS>.tar.gz   ← §7 tiers (deeper fallback)
```

Three decisions confirmed with the user before writing this doc:

- **D1 — Snapshot source = a dedicated fresh local snapshot.** A single
  `<dataDir>/.hotsheet/snapshot.tar.gz`, rewritten on a ~2 s post-write debounce + on
  graceful shutdown. It lives on **fast local disk inside the dataDir** — deliberately
  **not** the §7 `backupDir`, which may be a slow Google-Drive-synced folder (HS-8174).
  The §7 backup tiers remain the *deeper* fallback if the canonical snapshot is itself
  missing/unreadable. Auto-restore loss window: **≤ a few seconds.**
- **D2 — Recovery UX = auto-restore + notify.** On detecting a broken live cluster,
  preserve the corrupt `db/` aside (today's HS-7889 rename), `loadDataDir` the newest
  good snapshot into a fresh `db/`, and surface a **toast + command-log line** (no
  blocking banner, no clicks). The user does nothing; the app just works. The corrupt
  dir is kept on disk for manual rescue, exactly as today.
- **D3 — On by default.** Shipped enabled for every project
  (`db_snapshot_protection: true`); a Settings toggle turns it **off** for anyone who
  wants the pre-Option-D behavior. Justification: robustness is the entire point, it
  costs no RAM, and it writes to fast local disk.

## 73.3 The snapshot writer

A new module (`src/db/snapshot.ts`) owns the canonical snapshot. Producing it reuses
machinery we already trust — the same path that restored 639/639 tickets on 2026-04-27:

1. `CHECKPOINT` (flush WAL into the data files so the dump is internally consistent —
   the HS-7891 guard, mandatory before any `dumpDataDir`).
2. `db.dumpDataDir('gzip')` → one gzipped tarball blob. `dumpTar` works in `nodefs`
   (backups already prove it).
3. Write atomically with the **exact** `writeJsonExportAtomically` pattern
   (`src/dbJsonExport.ts:71`): open `snapshot.tar.gz.tmp`, write, `handle.sync()`
   (fsync on libuv's threadpool — HS-8178), close, then `rename` over
   `snapshot.tar.gz`. POSIX `rename` is atomic, so a crash mid-write leaves either the
   complete previous snapshot or the complete new one — never a partial file.

**Triggers (all gated on `db_snapshot_protection === true`):**

- **Debounced post-write (~2 s).** Hang a debounce off the existing mutation signal —
  `scheduleAllSync(dir)` in `src/sync/markdown.ts` already fires on every ticket
  mutation; the snapshot scheduler subscribes to the same "something changed" moment so
  bursts (batch ops, plugin sync) coalesce into one dump. Reuse `src/limits.ts` for the
  interval constant (the markdown sync already centralizes its debounces there).
- **Graceful shutdown (final snapshot).** Add a `snapshotAllDirty()` step to
  `gracefulShutdown` (`src/lifecycle.ts`, §45.3) *before* `closeDatabases()` so a clean
  exit always leaves an up-to-the-moment snapshot → **zero loss on clean shutdown.**
- **Periodic safety floor.** A low-frequency timer (default 120 s, only when the DB is
  dirty since the last snapshot) bounds loss on a hard crash even if the debounce never
  fired. Off when nothing changed — no idle disk churn.

Per-project: each registered project keeps its own `snapshot.tar.gz`, mirroring the
per-`dataDir` instance map in `src/db/connection.ts`. Snapshot writes serialize per
project (a dirty flag + in-progress guard), the same shape as `BackupState`.

## 73.4 The startup recovery flow

Today `getDbByPath` → `openAndCacheDb` → on throw → `recoverFromOpenFailure`
(`src/db/connection.ts`). Option D inserts a snapshot-restore step into that path and
adds an integrity probe so we catch *silent* corruption (cluster opens but the catalog
is wrong), not just hard open failures:

```
open db/  ──ok──►  integrity probe (§73.5) ──pass──►  use live cluster (normal)
   │                      │
 throw                  fail
   ▼                      ▼
 isRecoverableOpenError? ──── both land here ────►  restoreFromSnapshot()
   │ no                                                  │
   ▼                                                     ▼
 rethrow (ENOSPC/EACCES — unchanged)         1. preserve corrupt db/ aside (HS-7889 rename)
                                             2. pick newest good source, in order:
                                                  a. <dataDir>/.hotsheet/snapshot.tar.gz
                                                  b. §7 5min → hourly → daily tarball that loadDataDir-validates
                                             3. new PGlite(db/, { loadDataDir: blob }) into a fresh dir
                                             4. write recovery marker (HS-7899) + emit toast/log (D2)
                                             5. if NO good source exists → today's empty-recreate + marker (unchanged)
```

Key points:
- **The §7 fallback chain** reuses the existing "find a working backup" iterator
  (`src/routes/db.ts`) — newest-first, first one whose `loadDataDir` succeeds + has a
  readable `tickets` table wins.
- **Marker + toast.** The HS-7899 `.db-recovery-marker.json` is still written (so the
  event is durable + inspectable), but with D2 the client turns it into a *toast* —
  "Recovered from snapshot (HH:MM) — N tickets restored" — rather than the blocking
  restore banner. The banner code stays for the no-good-source case (truly empty DB).
- **Preserve-aside always runs first**, so even an auto-restore never destroys the
  corrupt cluster — it's renamed to `db-corrupt-<ts>` for out-of-band rescue, exactly
  as today.
- **Windows deferred recovery (HS-8717).** On Windows a just-failed PGLite open holds
  file handles on `db/` for the *process lifetime*, so the preserve-aside `renameSync`
  can't run in-process (it `EPERM`s, and no close/retry releases the handles). Instead of
  aborting (the server would FATAL with no self-heal), recovery writes a
  `.db-pending-recovery.json` marker and lets the process exit; the **next** startup —
  a fresh process with no handles — runs `completeDeferredRecovery` *before* opening,
  performs the preserve-aside + restore (now the rename succeeds), then proceeds. A
  boot-loop guard (`MAX_DEFERRED_RECOVERY_ATTEMPTS`) bails to the blocking banner if it
  can't heal after a few tries. Net effect: Windows self-heals one restart later than
  POSIX (which heals in-process on the first launch). Validated end-to-end against the
  real server on Windows; the unit-test suite for this path is POSIX-only (a vitest
  process can't model a real process exit — the PGLite WASM module stays resident, so
  the in-test "fresh process" still contends with the prior handles).

## 73.5 The integrity probe

A cheap, read-only check run once at open (not per query) to distinguish "healthy" from
"opened but corrupt." Pure-ish; lives next to `isRecoverableOpenError`:

- `SELECT 1` (smoke).
- `SELECT count(*) FROM tickets` (catalog + the one table whose loss is unacceptable).
- Catch PG catalog-corruption errors (`catalog is missing …`, already enumerated in
  `isRecoverableOpenError`) → treat as fail → restore.

A pass means the live cluster is trusted and used directly (the common path — no restore,
no snapshot read). The probe deliberately does **not** validate every table; the goal is
to catch the corruption class we actually see, not to run a full `amcheck`.

### 73.5.1 Storage-level (WAL) corruption (HS-9458)

A third corruption class, distinct from both the WASM open failure and the catalog
inconsistency above: the cluster opens fine and the catalog is intact, but its data pages
were written **ahead of the WAL**, so Postgres refuses every subsequent write:

```
xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0
code: 'XX000', file: 'xlog.c', routine: 'XLogFlush',
where: 'writing block 5 of relation base/1/461145'
```

That's the signature of a cluster killed mid-write — plausibly the
[docs/128](128-cluster-cache-bounding.md) OOM crash loop, which this doc's recovery path
is the backstop for. It is not repairable in place; the cluster has to be replaced from a
snapshot/backup, which is exactly what §73.4 does.

Two things had to change for it to get there, and both were silent failures:

1. **`isRecoverableOpenError` didn't match it.** The class hit none of the four patterns
   in §73.4, so recovery never ran — the error propagated out of `getDb` untouched and
   the server returned a raw **500 on every request, across restarts**. The user got a
   stack trace and no restore prompt, because the prompt is gated on the recovery marker
   that only the recovery path writes. `isClusterStorageFailure` (`src/db/connection.ts`)
   now recognizes it and feeds `isRecoverableOpenError`. It matches by message substring
   (`xlog flush request`, plus the page-level `invalid page in block` / `could not read
   block` in the same family) and deliberately **not** on `XX000` alone — that's
   Postgres's generic internal-error code and would preserve-aside healthy clusters.
2. **`initSchema` swallowed it, twice, before anything threw.** Each idempotent migration
   step has a `.catch()` that ignores the benign "already exists" of an
   already-applied step — but the filter swallowed *everything* it didn't recognize,
   logging it as a routine `Migration error (…)` and carrying on. So the first two
   symptoms of an unwritable cluster were reduced to log noise, and only the next step
   that happened to lack a `.catch()` failed for real. All seven sites now route through
   `ignoreBenignMigrationError`, which rethrows a storage failure so it reaches the
   recovery path; a unit test pins that no eighth hand-rolled swallow can appear.

### 73.5.2 The same class MID-SESSION (HS-9460)

§73.5.1 fires at **open**. But the fault can appear while the server is already running:
the cluster opened healthy, then something (plausibly the [docs/128](128-cluster-cache-bounding.md)
OOM crash loop) killed it mid-write, and from that moment every write fails. Nothing reopens,
so none of the machinery above ran — the server just 500'd until a human noticed, and
restarting landed on the same corrupt cluster.

**Detection** is at the live query choke point: the `instrumentDbQueries` proxy (the same one
docs/128 uses for in-flight tracking) tests each rejection with `isClusterStorageFailure`. The
predicate moved to its own `src/db/storageFailure.ts` so both the open path and the query proxy
can use it — `connection.ts` imports the proxy, so importing it back would be a cycle.
`connection.ts` re-exports it, so existing importers are unchanged.

**Response is restart-scoped, deliberately.** `handleLiveStorageFailure` writes the
**pending-recovery marker** (`.db-pending-recovery.json`) and logs one actionable line. On the
next start, `completeDeferredRecovery` — already in the `getDbByPath` path, and already tested,
since it is the HS-8717 Windows handle-lock mechanism — preserves the corrupt `db/` aside,
restores from the newest snapshot/backup, and writes the §73.4 recovery marker that prompts the
user. The marker now carries a `reason` (`handle-lock` | `live-storage-failure`) so the
user-facing text names the real cause; markers written before this default to `handle-lock`.

**Not an in-place self-heal.** Recovering live would mean closing and swapping the cluster out
from under in-flight requests — against docs/128's hard invariant that a cluster with an
in-flight query is never closed — in order to recover from a state where every subsequent write
fails anyway. The restart path reuses tested machinery and cannot tear a live request.

**Reporting is deduped per dataDir** (`storageFailureReported`): the class fails *every* write,
so an un-deduped handler would rewrite the marker and spam the log in a tight loop for as long
as the server ran.

**And this session's errors say so.** `apiErrorHandler` maps the class to
`code: 'database_needs_recovery'` with a plain-language message, instead of returning
`xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0` on every action.
Since the cluster is already marked, "restart Hot Sheet" is not a suggestion — it heals.

## 73.6 Settings

- **`db_snapshot_protection: boolean`** (per-project file-setting, **default `true`** —
  D3). Master switch. Off ⇒ no snapshot writes, and the recovery flow falls back to
  today's behavior (no snapshot source, §7-tier-and-empty-recreate only).
- **`db_snapshot_debounce_ms`** / **`db_snapshot_safety_interval_ms`** — optional
  advanced overrides (defaults 2 000 / 120 000). Documented but not surfaced in the
  Settings UI v1; live in `settings.json` for power users / benchmarking.

Settings → Backups gains a "Snapshot protection" subsection (sits naturally beside the
§42 Database Repair subsection): the toggle + a status line ("Last snapshot: HH:MM ·
N KB"). **Shipped (HS-8594).** The checkbox (`#settings-snapshot-protection`) is bound to
`db_snapshot_protection` and PATCHes `/api/file-settings` on change (default-on hydration
reads the same key back, treating only an explicit stored `false` as off). The status line
(`#settings-snapshot-status`) is fed by `GET /api/db/snapshot-status`, which returns
`getSnapshotStatus(dataDir)` (`{ lastSnapshotAt, lastSnapshotStartedAt, lastSizeBytes }` —
HS-9361 added `lastSnapshotStartedAt`, the **content-cutoff bound**: a snapshot contains
everything committed before its START; `lastSnapshotAt` is only when the write finished,
so a slow dump can complete long after mutations it never captured. Anything waiting for
"a snapshot that captures mutation X" — e.g. the crash-recovery e2e's
`waitForSnapshotAfter` — must compare against the start time); before the session's
first snapshot both are null and the line says so rather than rendering a bogus
"00:00 · 0 B". Client lives in `src/client/snapshotProtectionUI.tsx` (sibling of
`dbRepairUI.tsx`), wired from `bindBackupsUI` / `loadBackupList` in `backups.tsx`.

## 73.7 Relationship to the existing stack

- **§7 backups** — unchanged as the deeper fallback. The canonical snapshot is fresher
  (seconds vs. 5 min) and local (fast vs. possibly-Google-Drive), so it's tried first;
  the tiers catch the case where the canonical snapshot is itself missing/corrupt.
- **§41 JSON co-save / §43 attachment store** — unchanged.
- **§42 Database Repair** — complementary. Most corruption now self-heals before the
  user ever opens Repair; Repair stays for the residual manual cases.
- **§45 graceful shutdown** — the final-snapshot trigger is a new pipeline step
  (§73.3); the rest of the pipeline is untouched.
- **§72 snapshot-persistence** — Option D is the low-RAM sibling. If §72's `memoryfs`
  end-state (or the §72.6 "Option B′" telemetry-split) is ever adopted, Option D's
  snapshot writer + atomic-write code is directly reusable, and its auto-restore flow
  becomes the recovery path there too. Shipping Option D first de-risks §72.

## 73.7a The empty-cluster guard (HS-9573)

Snapshot Protection's one job is that the canonical snapshot is *better* than the live
cluster. On **2026-08-04** it did the opposite: it replaced 432 tickets with nothing, on
schedule, and reported success.

**The sequence.** A corrupt-open recovery crashed mid-flight (HS-9572) *after* renaming
`db/` aside and *before* restoring. The next start found no `db/`, so PGLite created a
fresh empty cluster — no corruption, so no recovery path, no marker, no banner. Then the
snapshot writer dumped that empty cluster over `snapshot.tar.gz`. (The backup tiers did the
same thing on their own cadence; see [7-backup-restore.md](7-backup-restore.md) §7.11.)

**Why the existing guard missed it.** `writeSnapshotNow` already refused to write when
`db/` was **missing** — it anticipated "a reopen would mkdir an empty cluster and overwrite
the snapshot with nothing" and guarded the case where the directory vanished. Here `db/`
existed; it was seconds old. **Presence was never the right question — content is.**

**The rule** (`src/db/emptyClusterGuard.ts`). Refuse the write on the conjunction of three
facts, because each alone is routine:

1. **The cluster was created fresh this process**, not opened from existing files. The one
   place that can tell is the open path in `connection.ts`, which checks for `PG_VERSION`
   *before* PGLite writes it.
2. **It currently holds zero tickets.**
3. **The project is known to have held tickets before** — `.hotsheet/.db-content-marker.json`,
   a local high-water mark updated after every successful snapshot/backup.

The conjunction is what makes the guard safe to leave on. A **brand-new project** satisfies
(1) and (2) and fails (3), so its first snapshot is written normally. A user who
**deletes every ticket by hand** satisfies (2) and (3) but not (1) — their empty state is
real and gets captured. Only the incident satisfies all three.

The marker lives in `dataDir`, never `backupDir`: it is read on the artifact-write path,
and `backupDir` may be a cloud File Provider where a read blocks unboundedly
([7-backup-restore.md](7-backup-restore.md) §7.10 / HS-9527). It also fails **open** — an
absent or corrupt marker reads as "no prior data", so a marker problem can never stop a
healthy project from being snapshotted.

**One retained generation.** `writeFileAtomic` replaces the snapshot in place, so before
HS-9573 the canonical copy had no history at all and a single bad write was terminal. The
writer now rotates the current snapshot to `snapshot.prev.tar.gz` first. It is a local
rename, it costs one file, and by itself it would have made the 2026-08-04 incident a
non-event.

## 73.8 Honest limitations

1. **Not corruption-proof.** The live `db/` is still the fragile multi-file format;
   Option D makes corruption survivable, not impossible. (That's the §72 `memoryfs`
   guarantee, at a RAM cost Option D refuses to pay.)
2. **Bounded data loss on hard crash.** Writes between the last snapshot and a crash are
   lost on auto-restore. The ~2 s debounce + 120 s safety floor bound this to seconds in
   practice; a clean shutdown loses nothing.
3. **Snapshot write cost grows with DB size.** `dumpDataDir` serializes the whole
   cluster synchronously. This bit hard: a project DB that grew to 833 MB (766 MB of it
   §67 telemetry) made `dumpDataDir` block the event loop ~6.7 s (the HS-9239 freeze).
   **Resolved by HS-9230 (epic HS-9226 Phase 1):** per-project telemetry was relocated
   OUT of `<dataDir>/db` into a sibling `<dataDir>/telemetry/db` cluster, which the
   snapshot does NOT serialize (it dumps only the `<dataDir>/db` cluster), so the project
   snapshot drops to a few MB. The threadpool-async / debounce / dirty-gate mitigations
   still apply to whatever remains in `db/`.
4. **Recovery is restart-scoped for a mid-session failure.** Every path in §73.4 hangs off
   `getDbByPath`. A cluster that goes bad *while the server is running* is now DETECTED at
   the query layer and marked so the next start restores it (§73.5.2), and this session's
   API errors say so — but the running process still cannot serve that project until it is
   restarted. That is a deliberate trade (see §73.5.2), not an oversight.

## 73.9 Testing strategy

- **Snapshot writer (unit).** Mutate → assert a debounced `snapshot.tar.gz` appears, is
  a valid gzip tarball, and `loadDataDir`-round-trips to the same row counts. Assert the
  `.tmp` is gone (atomic rename completed) and absent on a simulated mid-write throw.
- **Integrity probe (unit).** Healthy DB passes; a hand-corrupted catalog fails; the
  probe is read-only (no mutation).
- **Auto-restore (integration).** Open against a deliberately-corrupted `db/` → assert
  the corrupt dir is preserved aside, the snapshot is loaded, row counts match the
  snapshot, and a marker + (mocked) toast fire.
- **Fallback chain (integration).** No `snapshot.tar.gz` → restores from the newest §7
  tier; no tiers either → today's empty-recreate + banner.
- **Crash-recovery e2e (HS-8588).** **Shipped** in `src/db/snapshotCrashRecovery.e2e.test.ts`
  on the shared `src/spawnTestServer.ts` child-process harness (spawn `tsx src/cli.ts`,
  drive the real HTTP API, SIGKILL, relaunch). Three cases: (1) **bounded loss** — durable
  writes captured by the last debounced snapshot survive a SIGKILL + corrupt-cluster
  relaunch; writes made after that snapshot are the only loss (loss ≤ the un-snapshotted-
  writes bound); (2) **snapshot freshness wins** — with both a canonical snapshot AND a §7
  backup tarball present, restore prefers the fresher local snapshot (the slow-`backupDir`
  intent, tested as the precedence invariant); (3) **multi-project isolation** — two
  projects in one server each restore their OWN data with no cross-talk. SIGKILL is
  uncatchable, so `gracefulShutdown`'s final snapshot never runs (the genuine crash shape);
  the stale `hotsheet.lock` a SIGKILL leaves is cleared in-test (lock stale-detection is
  orthogonal + unit-covered in `lock.test.ts`). `describe.skipIf(!canSpawnTsxChild)` skips
  cleanly in tsx-IPC-restricted sandboxes (HS-8202).

## 73.10 Implementation follow-ups (phased)

- **Phase 1 — snapshot writer + setting** (HS-8586). **Shipped.** `src/db/snapshot.ts`,
  `db_snapshot_protection` (default true), the three triggers (debounce / shutdown /
  periodic), atomic write reusing the `dbJsonExport.ts` pattern, per-project dirty +
  in-progress guards, 13 unit tests. Produces the artifact + proves it round-trips.
- **Phase 2 — startup integrity probe + auto-restore** (HS-8587). **Shipped (server core +
  toast).** The §73.4 flow + §73.5 `probeIntegrity` wired into `getDbByPath` /
  `recoverFromOpenFailure`, `src/db/restore.ts` source list (canonical snapshot → §7-tier
  fallback), `restoredFrom` / `restoredTicketCount` marker fields, and the D2 success toast
  in `dbRecoveryBanner.tsx` (banner reserved for the no-source empty-recreate). 5 restore
  integration tests + 4 toast-formatter tests. **The Settings → Backups subsection (toggle
  + status line + `GET /api/db/snapshot-status`) was split to HS-8594** — it's client UI
  needing browser/Tauri verification, kept separate from the safety-critical server path.
- **Settings → Backups subsection** (HS-8594, split from Phase 2). **Shipped.**
  `src/client/snapshotProtectionUI.tsx` (toggle bound to `db_snapshot_protection` +
  status line), `GET /api/db/snapshot-status` route, `formatSnapshotStatusLine` unit
  tests + a route round-trip test + a Playwright toggle-persistence e2e
  (`e2e/snapshot-protection.spec.ts`, in-app checkbox — no native dialog).
- **Phase 3 — crash-recovery e2e + hardening** (HS-8588). **Shipped.** SIGKILL relaunch
  harness extracted into the shared `src/spawnTestServer.ts` (also now backing the HS-7934
  graceful-shutdown e2e), `src/db/snapshotCrashRecovery.e2e.test.ts` with the three cases
  in §73.9 (bounded loss, snapshot-beats-backup precedence, multi-project isolation),
  bounded-loss assertion, doc + AI-summary sync. With Phase 3 done, Option D / Snapshot
  Protection is fully implemented.

## 73.11 Cross-references

- §7 — backup / restore (deeper fallback; "find a working backup" iterator reused).
- §41 — JSON co-save (orthogonal escape hatch, unchanged).
- §42 — Database Repair (complementary; mostly bypassed once self-heal lands).
- §45 — PGLite cleaner-shutdown (the `gracefulShutdown` pipeline gains the final-snapshot
  step).
- §72 — memory-primary snapshot persistence (the high-RAM corruption-*proof* sibling;
  §72.6 introduced Option D and "Option B′"). This doc is the dedicated design for
  §72.6's Option D.
- HS-7889 / HS-7899 — preserve-aside + recovery marker, promoted from manual to automatic.
- HS-7932 / HS-7935 — fsync-no-op finding + the explicit-fsync wrap reused by the writer.
