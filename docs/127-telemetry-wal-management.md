# 127. Telemetry cluster WAL management

Keeps each per-project telemetry PGLite cluster's `pg_wal/` bounded, and reclaims the bloat already
on existing installs. Grew out of the HS-9420 OOM diagnosis (HS-9422 → HS-9424 investigation).

## 127.1 The problem

Telemetry lives in a **sibling** PGLite cluster per project (`<dataDir>/telemetry/db`, HS-9230) plus a
central store (`~/.hotsheet/telemetry/db`). PGLite uses PostgreSQL's default WAL budget —
`max_wal_size = 1GB`, `min_wal_size = 80MB` — which is wildly oversized for an append-mostly store
whose actual working set is tiny. A measured cluster on 2026-07-24 was **1.0 GB total: 22 MB of data
+ 1.0 GB of WAL** (65 × 16 MB segments, most three weeks old).

Nothing in Hot Sheet reclaimed it:

- `VACUUM` / `VACUUM FULL` shrink only the data files, never `pg_wal` (HS-9422). `VACUUM FULL` even
  *grows* WAL, because the rewrite is itself logged.
- An explicit `CHECKPOINT` does not remove segments while under budget — Postgres recycles them for
  reuse (measured; HS-9424).
- The 1 GB is **not a leak** — it is `max_wal_size` working as designed. It just never needed to be
  that large.

Beyond disk, this fed the HS-9420 OOM: telemetry clusters are opened per maintenance pass, and a
1 GB-WAL cluster is slower to open (WAL scan at startup).

## 127.2 What PGLite exposes (and the trap)

The earlier checkpoint spike (docs/45, HS-7936) concluded PGLite had **no** way to set `max_wal_size`.
That was true for 0.3.16 and is **false as of 0.4.6**: `PGliteOptions` gained **`startParams`**, which
forwards `-c` flags to the postgres runtime. Verified against a real cluster in the exact production
shape (`new PGlite(dir, { database: 'template1', startParams })`):

```
db=template1  max_wal_size=64MB  min_wal_size=32MB  peak=176MB  reopen=64MB
```

Four traps, all verified (also in docs/45's UPDATE):

1. **`startParams` REPLACES PGLite's internal `defaultStartParams`, it does not append.** An
   incomplete array makes the cluster **fail to initialize**. You must prepend the full defaults.
2. That default array is **not exported** from `@electric-sql/pglite`, so our copy
   (`PGLITE_DEFAULT_START_PARAMS` in `src/db/pglite.ts`) can **drift on upgrade**. §127.4 is the guard.
3. **`postgresqlconf` overwrites the entire config file** (not a delta) — using it drops every other
   required setting and bricks the cluster. Use `startParams`.
4. **`min_wal_size` has a floor:** 16 MB fails init, 32 MB works. **`max_wal_size` is a soft target** —
   WAL still peaks during a heavy write burst, then recycles down to the budget on the next
   checkpoint/restart. It bounds steady-state, not peak.

## 127.3 Bounding NEW clusters (HS-9426, shipped)

`src/db/pglite.ts` exports `TELEMETRY_START_PARAMS = [...PGLITE_DEFAULT_START_PARAMS, '-c',
'max_wal_size=64MB', '-c', 'min_wal_size=32MB']`.

`connection.ts::openAndCacheDb` applies them **only to telemetry clusters**, detected by path:
`isTelemetryClusterDbPath(dbPath)` = `basename(dirname(dbPath)) === 'telemetry'`. That works because
`telemetryClusterDataDir` guarantees every telemetry cluster lives under a `telemetry` segment, and a
project's own cluster is always `<dataDir>/db` where `<dataDir>` is a `.hotsheet` dir. Detecting by
path (rather than threading a flag) means **every** construction path — first open, recovery, snapshot
restore — tunes consistently, because they all funnel through `openAndCacheDb`.

**Project clusters are deliberately left on the default budget.** They hold live ticket data and the
checkpoint-cadence trade-off (docs/45 §45.6) hasn't been benchmarked for them; the WAL bloat problem
is telemetry-specific.

Effect: a telemetry cluster's WAL settles to ~48–64 MB across close/reopen instead of 1 GB. This only
governs **new** clusters (and the steady state of existing ones going forward) — it does not shrink
WAL already written under the old budget (see §127.5).

## 127.4 The drift guard (required)

`PGLITE_DEFAULT_START_PARAMS` is a verbatim copy of an unexported PGLite constant, so a PGLite upgrade
that changes the defaults would silently make our array wrong — and a wrong array bricks cluster init.
`src/db/pglite.startParams.test.ts` reads the bundled `dist`, extracts the real `defaultStartParams`
array, and asserts our copy matches. **That test is the guard** — it fails loudly at test/CI time on
drift, which is the moment to re-copy the array. A runtime assertion was deliberately avoided: a
mismatch that *throws* at startup would be a worse failure than the WAL bloat it guards against.

## 127.5 Reclaiming EXISTING bloat (HS-9427, not yet built)

Tuning at creation does nothing for the multi-hundred-MB clusters already on disk: reopening an
existing bloated cluster with the tuned budget does **not** reclaim the excess (measured — stays at
176 MB through reopen + CHECKPOINT + write + CHECKPOINT). There is no in-place shrink.

But telemetry clusters are **rebuildable**: the durable source is the rotating JSONL raw store
(`<dataDir>/telemetry/*.jsonl`, HS-9280); the cluster only holds derived rollups. So the reclaim path
is **recreate, not repair** — for a cluster whose `pg_wal` exceeds a threshold (e.g. 256 MB, well
above the ~64 MB tuned steady state), move the `db/` aside, re-create it tuned, re-derive rollups from
JSONL, delete the old dir. Off-loop via the §75 scheduler, gated on the cluster not being mid-write
(HS-9420 `isDbOpenForDir`), move-aside-then-delete so a failed re-derive is recoverable, and **never**
touch `pg_wal` segments by hand. Tracked by HS-9427; its open question (whether JSONL fully
reproduces the cluster) needs a maintainer decision before implementation.

## 127.6 Tests

- `pglite.startParams.test.ts` — the drift guard (§127.4) + that `TELEMETRY_START_PARAMS` is exactly
  defaults + the two WAL flags.
- `connection.telemetryWal.test.ts` — against a real cluster: a telemetry cluster opens at
  `max_wal_size=64MB` / `min_wal_size=32MB`, a project cluster stays at `1GB`, `isTelemetryClusterDbPath`
  agrees with `telemetryClusterDataDir`, and the budget re-applies on a cold reopen.
