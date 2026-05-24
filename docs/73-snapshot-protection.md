# 73. Snapshot Protection — NodeFS live + atomic snapshot + auto-restore

HS-8583. The low-RAM, ship-first robustness feature that came out of the HS-8575
investigation (`docs/72-snapshot-persistence.md`, esp. §72.6 — "Option D"). Greenlit
for implementation; this doc is the design of record. Three shaping decisions were
confirmed with the user up front (see §73.2).

> **Status: Design — greenlit, not yet implemented.** Behavior described here ships
> across the phased follow-ups in §73.10. Unlike §72 (which proposes moving the *live*
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

## 73.6 Settings

- **`db_snapshot_protection: boolean`** (per-project file-setting, **default `true`** —
  D3). Master switch. Off ⇒ no snapshot writes, and the recovery flow falls back to
  today's behavior (no snapshot source, §7-tier-and-empty-recreate only).
- **`db_snapshot_debounce_ms`** / **`db_snapshot_safety_interval_ms`** — optional
  advanced overrides (defaults 2 000 / 120 000). Documented but not surfaced in the
  Settings UI v1; live in `settings.json` for power users / benchmarking.

Settings → Backups gains a "Snapshot protection" subsection (sits naturally beside the
§42 Database Repair subsection): the toggle + a status line ("Last snapshot: HH:MM ·
N KB").

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

## 73.8 Honest limitations

1. **Not corruption-proof.** The live `db/` is still the fragile multi-file format;
   Option D makes corruption survivable, not impossible. (That's the §72 `memoryfs`
   guarantee, at a RAM cost Option D refuses to pay.)
2. **Bounded data loss on hard crash.** Writes between the last snapshot and a crash are
   lost on auto-restore. The ~2 s debounce + 120 s safety floor bound this to seconds in
   practice; a clean shutdown loses nothing.
3. **Snapshot write cost grows with DB size.** `dumpDataDir` serializes the whole
   cluster; for a large §67 telemetry set this is non-trivial. Mitigated by: async on the
   threadpool (HS-8178 pattern), debounce coalescing, and the dirty-gated safety timer.
   If it ever dominates, the §72.6 "Option B′" telemetry-split is the escape hatch.

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
- **Crash-recovery e2e (the HS-8578 SIGKILL harness, reused).** Write rows, SIGKILL,
  relaunch → assert auto-restore + that loss ≤ the debounce/safety bound. Multi-project
  + slow-`backupDir` variants.

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
- **Phase 3 — crash-recovery e2e + hardening** (HS-8588). SIGKILL relaunch harness
  (shared with HS-8578 if that lands first), multi-project + slow-`backupDir`
  verification, bounded-loss assertion, doc + AI-summary sync.

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
