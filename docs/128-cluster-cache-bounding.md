# 128 — Bounded PGLite cluster cache (memory-management)

Status: **Shipped** (HS-9420). Closes the 2026-07-24 server OOM crash loop.

Companion to [45-pglite-robustness.md](45-pglite-robustness.md) (cleaner-shutdown) and
[127-telemetry-wal-management.md](127-telemetry-wal-management.md) (telemetry WAL disk). This
doc governs **process memory** — how many PGLite clusters are held open at once.

## 128.1 The bug

`src/db/connection.ts` cached one `PGlite` instance per `<dataDir>/db` in a module-level
`Map` with **no eviction**. Anything that opened a cluster — a project restore, an OTLP
telemetry ingest, a cross-project dashboard fan-out — pinned its **~180 MB WASM heap for the
life of the process**.

On an install with ~10 registered projects the HS-9230 telemetry split (per-project telemetry
moved to a *sibling* `<dataDir>/telemetry/db` cluster) roughly **doubled** the live cluster
count (10 → ~20), and the startup retention sweep force-opened every telemetry cluster. That
landed **~3.2 GB of `external` (WASM) memory against V8's ~4.1 GB ceiling** before a client even
connected. Any normal burst (a client attaching, a project switch, a backup `dumpDataDir`) then
tipped it over into `FatalProcessOutOfMemory`, the watchdog saw a 60 s GC-thrash event-loop
block, and SIGKILLed — a restart loop.

**Why it went undiagnosed:** `external` (WASM heaps) is reserved sparsely and largely
non-resident, so it does **not** show up in RSS. `ps` read a misleading ~1.3 GB. The number
that mattered was `process.memoryUsage().external`, surfaced in the diagnostics by HS-9421.

## 128.2 The fix — three layers (maintainer chose "all three")

Policy lives in `src/db/clusterEviction.ts` (pure + unit-tested); `connection.ts` owns the
PGLite handles and performs the closes the planner selects.

1. **LRU cap** (`maxOpen`, default 10). Opening the (cap+1)-th cluster evicts the
   least-recently-used *evictable* cluster. Steady-state memory is now independent of how many
   projects are registered — someone with 30 projects holds at most `maxOpen` open.
2. **Idle-close** (`idleMs`, default 10 min). A periodic sweep (`evictIdleClusters`, off-loop,
   `unref`'d, 60 s) closes any non-pinned cluster untouched for `idleMs`. This is what reclaims
   the telemetry clusters an ingest burst opened — they go idle and are closed, bounding the
   session-long "creep."
3. **Headroom guard** (`headroomFloorBytes`, default 768 MB). Before opening a new cluster, if
   `external` is within the floor of the V8 heap ceiling, evict LRU clusters *ignoring the
   recency guard* (but never one mid-query) to buy headroom before allocating another ~180 MB.
   The hard safety valve; count sized by the deficit ÷ ~180 MB/cluster.

## 128.3 The correctness invariant — never evict mid-query

A close must never land on a cluster with an in-flight query (it would reject the caller's
`await db.query(...)`). Two mechanisms guarantee it:

- **In-flight tracking.** The query-instrumentation proxy (`queryInstrumentation.ts`) calls
  `beginClusterQuery`/`endClusterQuery` around every `query`/`exec`/`dumpDataDir`. A cluster
  with `inFlight > 0` is **never** chosen for eviction, in any mode. This protects long single
  operations (a big `dumpDataDir` backup) whose caller holds the handle across the whole call.
  **The proxy is now always applied** (even when `HOTSHEET_DISABLE_QUERY_INSTRUMENTATION=1`,
  which only skips freeze-timing) — eviction correctness must not depend on an env flag.
- **Recency guard** (`minIdleMs`, default 30 s). Cap/idle eviction also skips clusters accessed
  within `minIdleMs`, protecting a just-accessed cluster in the gap between a caller's `getDb()`
  and its first query. The headroom guard drops this softer guard under memory pressure but
  keeps the hard in-flight one.

A sequential cross-project fan-out (`for (p of projects) await runWithDataDir(p, …)`) is
naturally safe: each cluster's query fully settles before the next opens.

**The launch/default project is always pinned** (`defaultDbPath`), so the primary interaction
surface never pays a reopen; every other active project is protected implicitly by LRU recency.

## 128.4 Accepted trade-off

A switch to a **cold** (evicted) project pays a PGLite reopen (the `getDbForDir` time the
startup log already measures; it warns above 500 ms). This is the deliberate cost of making
memory independent of project count. A close/reopen race on the exact cluster being evicted is
possible but vanishingly rare (evictions target idle clusters aged past 30 s) and self-heals via
the existing stale-`postmaster.pid` recovery — no data loss.

## 128.5 Tuning knobs (env, production defaults in parens)

| Env var | Meaning | Default |
| --- | --- | --- |
| `HOTSHEET_MAX_OPEN_CLUSTERS` | LRU cap on open clusters (floor 2) | 10 |
| `HOTSHEET_CLUSTER_IDLE_MS` | idle-close threshold | 600000 (10 min) |
| `HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS` | recency guard for cap/idle eviction | 30000 (30 s) |
| `HOTSHEET_EXTERNAL_HEADROOM_BYTES` | headroom floor below the heap ceiling | 805306368 (768 MB) |
| `HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS` | idle-sweep timer period (floor 1 s) | 60000 |

`0` is a valid value for the guard thresholds (disables that guard); `maxOpen` is clamped to a
floor of 2, the sweep interval to 1 s.

## 128.6 Lifecycle

- Started once at startup (`cli.ts` `postStartup`, after project restore →
  `startClusterEvictionTimer`).
- Stopped early in `gracefulShutdown` (`lifecycle.ts` `stopClusterEvictionTimerStep`, before the
  databases are snapshotted/closed) so a sweep can't race the shutdown close.
- Every close path (`closeDb` / `closeDbForDir` / `closeAllDatabases` / recovery deletes /
  eviction) calls `forgetCluster` to keep the bookkeeping in lockstep with the `databases` Map.

## 128.7 Tests

- `src/db/clusterEviction.test.ts` — the pure transition matrix (cap / idle / headroom ×
  pinned / in-flight / recency), `headroomEvictionCount`, bookkeeping, and env-config resolution.
  No real clusters.
- `src/db/connectionEviction.test.ts` — the integration against **real** PGLite clusters: opening
  past the cap evicts an LRU cluster, a project-switch-back keeps the active one, the idle sweep
  closes idle clusters, an in-flight query protects its cluster, the pinned default is never
  evicted, and a close drops the bookkeeping.
- `src/db/queryInstrumentation.test.ts` — the always-on proxy stays transparent when
  freeze-timing is disabled, and in-flight counts are tracked (and released on reject).

## 128.8 Relation to the earlier mitigations

The OOM epic shipped in layers: HS-9420 direction-1 (`ac7816c`, telemetry maintenance closes the
cluster it opened) was the first mitigation; HS-9426/HS-9427 bounded + reclaimed telemetry **WAL
disk** ([127](127-telemetry-wal-management.md)). This doc is the **cure** — the general bounded
cache that makes process memory independent of project count.
