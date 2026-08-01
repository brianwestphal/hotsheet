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

1. **LRU cap — now a pressure-driven, per-type BUDGET** (HS-9468; was a fixed combined count).
   Project and telemetry clusters have **separate LRUs** with separate allowances, and both
   allowances are computed from live memory pressure rather than hardcoded. Steady-state memory
   is independent of how many projects are registered. See §128.2.1.
2. **Idle-close** (`idleMs`). A periodic sweep (`evictIdleClusters`, off-loop, `unref`'d, 60 s)
   closes any non-pinned cluster untouched for its idle window. This is what reclaims the
   telemetry clusters an ingest burst opened — they go idle and are closed, bounding the
   session-long "creep." **HS-9467 — the window is per cluster TYPE:** project clusters 5 min,
   telemetry clusters 60 s, because a telemetry reopen is invisible while a project reopen is a
   hitch the user sees. §128.5.1 has the measurements behind both numbers.
3. **Headroom guard** (`headroomFloorBytes`, default 768 MB). Before opening a new cluster, if
   `external` is within the floor of the V8 heap ceiling, evict LRU clusters *ignoring the
   recency guard* (but never one mid-query) to buy headroom before allocating another ~180 MB.
   The hard safety valve; count sized by the deficit ÷ ~180 MB/cluster.

### 128.2.1 The dynamic per-type budget (HS-9468)

`clusterBudget()` answers "how many of each kind can we afford *right now*", replacing the fixed
`maxOpen`:

```
effectiveExternal = external − pendingReclaim
spare             = ⌊(heapLimit − effectiveExternal − headroomFloor) / ~180 MB⌋
allowedTotal      = clamp(openNow + spare, floors, ceilings)
project           = clamp(allowedTotal − minTelemetry, minProject, maxProject)
telemetry         = clamp(allowedTotal − project,      minTelemetry, maxTelemetry)
```

Three properties fall out of that shape, and each is a deliberate decision:

- **It self-regulates.** The budget grows from `openNow`, and every cluster opened raises
  `external`, which lowers `spare`. Plentiful memory ⇒ budget above what is open ⇒ nothing
  evicted and more may open. Tight memory ⇒ budget below what is open ⇒ the excess is evicted.
  No oscillation, because the feedback is negative.
- **Separate LRUs.** A telemetry burst can no longer evict the project the user is looking at,
  and a project switch can no longer evict the cluster an ingest is writing to. Under the old
  single cap of 10 they competed for the same slots, and with two clusters per project **~5
  projects saturated it** — the cap, not the idle sweep, was doing all the work.
- **Telemetry gives way first.** Projects are served from `allowedTotal` before telemetry, so a
  shrink lands on telemetry until it hits its floor and only then on projects. Maintainer's
  rule: *"write speed for telemetry is more important than read speed — showing stats pages is
  relatively low priority"*. A stats page paying a reopen is cheap; a tab switch paying one is
  not. The telemetry **floor** is what protects writes: an ingest burst must not reopen on every
  batch, so at least one telemetry cluster always stays.

**`pendingReclaim` is not an optimization — it prevents a cascade.** A closed cluster's WASM heap
returns on **GC**, not at `close()` (§128.5.1). A pressure loop that ignored this would read the
still-high `external` immediately after evicting, conclude it is *still* over budget, and evict
again — an over-eviction cascade caused by its own success, which would empty the cache under
exactly the memory pressure where reopens hurt most. `connection.ts` timestamps each eviction
close and credits `~180 MB` per eviction inside a 15 s lag window.

Headroom eviction is deliberately **not** type-aware: when memory is critical the only question
is which cluster was touched least recently, whatever kind it is. Idle-close remains type-aware
via the §128.5.1 windows.

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

### 128.3.1 The gap the invariant does NOT close — stale handles (HS-9461)

Both mechanisms above protect a cluster for the duration of **one query**. But callers hold a
handle across **many**: `persistLogsPayload` (an OTLP ingest) resolves `mainDb` once and then
awaits a dozen writes. In the gaps `inFlight` is 0, and the headroom guard deliberately drops
the recency guard — so it can close a cluster a live request is midway through using. The next
query on that now-stale handle threw:

```
[db] headroom guard evicted 1 idle cluster(s) before opening a new one (external near heap ceiling).
[otel] daily-seen prompt update failed: Error: PGlite is closed
```

which reached the user as the app going "disconnected". (§128.4 previously predicted this race
would "self-heal via the existing stale-`postmaster.pid` recovery" — it does not; that recovery
is for a *reopen*, and nothing was reopening. Corrected below.)

**The fix is healing, not prevention.** The query proxy catches `PGlite is closed` / `PGlite is
closing`, asks `connection.ts` to reopen the cluster, and re-runs the call once on the fresh
instance. Three facts make the retry safe, all verified rather than assumed:

- PGLite raises both messages from `_checkReady`, a **pre-flight** check — the statement
  provably never ran, so a retry cannot double-write.
- Nothing in `src/` uses `db.transaction()`, so there is no multi-statement unit a retry
  could tear in half.
- The reopener **declines** (and the original error propagates unchanged) during
  `closeAllDatabases`, and for a cluster closed deliberately by `closeDb`/`closeDbForDir` —
  only paths marked by `closeClusterForEviction` may heal. Otherwise a late request could
  resurrect a cluster we meant to be rid of, which is the very leak this doc exists to fix.

The subtle part is that a **live cached instance outranks the evicted-marker**, because the
marker is consumed by the first reopen while the caller keeps using the same stale handle for
every remaining write. Checking the marker first heals the first query and fails all the
rest — half a fix. Pinned by the "keeps working for EVERY later query on the same stale
handle" and "heals repeatedly" transition tests.

Healing is a safety net, not a substitute for not evicting an in-use cluster: the eviction
still wasted a close + ~180 MB reopen, under the very memory pressure that triggered the guard.

### 128.3.2 The prevention half — operation-scoped pins (HS-9462)

`pinClustersForDirs(dataDirs)` (`connection.ts`) holds clusters for a whole **operation**
rather than one statement, and returns a release function to call in a `finally`:

```ts
const release = pinClustersForDirs([clusterDir, targetDir]);
try { /* resolve handles, write many records */ } finally { release(); }
```

It reuses the **same `inFlight` counter** the planner already consults, so a pinned cluster is
excluded in every mode — there is no second exclusion rule to keep in sync with
`chooseEvictions`. Pinning a dataDir whose cluster isn't open yet is correct: only open
clusters are eviction candidates, and the pin is already in place if one opens mid-operation
(which is exactly what the OTLP writers do — they pin before `getDbForDir`).

Applied to the three OTLP writers (`persistMetricsPayload` / `persistLogsPayload` /
`persistSpansPayload` in `otelWriters.ts`), which resolve their handles once per resource and
then write many records — the path that actually produced the report.

**The pin must be released, and that is the whole risk.** One that outlives its operation makes
its cluster permanently un-evictable, which is the unbounded-growth bug this doc exists to fix.
Hence a release function called in `finally`, rather than anything inferred from request
lifetime; releasing twice is a no-op, so a duplicate release can't drop a *concurrent*
operation's hold on the same cluster. Tests cover the pinned-survives-eviction case, release on
throw, double-release, and pinning-before-open.

Healing (§128.3.1) stays regardless — it covers what prevention misses: a genuinely long gap, or
a handle cached across requests.

**Where pins are taken (HS-9464 audit).** The vulnerable shape is *resolve a handle once, then
`await` several statements against it* — the gaps are what the headroom guard sees as idle. A
sweep of `src/` found three more places worth pinning, all of which hold handles across
unbounded loops AND run at **startup**, exactly when many clusters are opening and the guard is
most likely to fire:

| Site | Why |
|---|---|
| `otelWriters.ts` ×3 (HS-9462) | per-resource OTLP write: handles resolved once, then many records |
| `otelRollupBackfill.ts` ×4 | per-dir backfill across `backfillDaily…`/`backfillTickets…` etc. |
| `telemetryMigration.ts` | keyset-paginated copy of EVERY telemetry row, source + dest clusters |
| `snapshot.ts` | `CHECKPOINT` → `dumpDataDir` are separate statements, and the dump is our longest single DB op (6.7 s in the HS-9239 freeze) |

Deliberately **not** pinned: request handlers in `routes/`, and helpers that call `getDb()` per
statement. Re-resolving is already safe — `getDb()` reopens an evicted cluster transparently —
so only a *held* handle is at risk. Short two-statement sequences aren't worth the ceremony
either; the recency guard covers them outside memory pressure.

**Leaked-pin guard.** A pin that is never released disables eviction for its cluster *silently*,
which is how the original OOM went undiagnosed. `connectionEviction.test.ts` scans `src/` and
fails if any file's `pinClustersForDirs` calls aren't matched by a `release()` inside a
`finally`. That is also why every call site uses the same `release` name — a uniform convention
is what makes the check simple enough to trust.

## 128.4 Accepted trade-off

A switch to a **cold** (evicted) project pays a PGLite reopen (the `getDbForDir` time the
startup log already measures; it warns above 500 ms). This is the deliberate cost of making
memory independent of project count.

**Corrected by HS-9461.** This section used to claim a close/reopen race on the cluster being
evicted was "vanishingly rare … and self-heals via the existing stale-`postmaster.pid`
recovery — no data loss." Both halves were wrong. It is not rare: the headroom guard drops the
recency guard, so it fires on exactly the busy clusters an ingest burst is using. And it did
not self-heal — the stale-pid recovery runs on *open*, and nothing was reopening; the caller
just got `PGlite is closed`. See §128.3.1 for what actually happens now.

## 128.5 Tuning knobs (env, production defaults in parens)

| Env var | Meaning | Default |
| --- | --- | --- |
| `HOTSHEET_MAX_OPEN_CLUSTERS` | ceiling on open **project** clusters when memory is plentiful (floor 2) | 10 |
| `HOTSHEET_MAX_OPEN_TELEMETRY_CLUSTERS` | ceiling on open **telemetry** clusters (HS-9468) | 6 |
| `HOTSHEET_MIN_OPEN_CLUSTERS` | project-cluster floor the pressure budget never goes below | 2 |
| `HOTSHEET_MIN_OPEN_TELEMETRY_CLUSTERS` | telemetry floor — protects ingest write throughput | 1 |
| `HOTSHEET_CLUSTER_IDLE_MS` | idle-close threshold, **project** clusters | 300000 (5 min) |
| `HOTSHEET_TELEMETRY_CLUSTER_IDLE_MS` | idle-close threshold, **telemetry** clusters (HS-9467) | 60000 (1 min) |
| `HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS` | recency guard for cap/idle eviction | 30000 (30 s) |
| `HOTSHEET_EXTERNAL_HEADROOM_BYTES` | headroom floor below the budget ceiling | 805306368 (768 MB) |
| `HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS` | idle-sweep timer period (floor 1 s) | 60000 |
| `HOTSHEET_EXTERNAL_CEILING_BYTES` | the ceiling `external` is budgeted against (HS-9555) | 25% of machine RAM, floored at the V8 heap limit, capped at 12 GB |
| `HOTSHEET_FORCED_GC_MIN_INTERVAL_MS` | minimum gap between forced collections (HS-9479) | 30000 (30 s) |
| `HOTSHEET_FORCED_GC_URGENT_BYTES` | unreclaimed bytes that override that gap (HS-9553) | 566231040 (3 clusters) |

`0` is a valid value for the guard thresholds (disables that guard); `maxOpen` is clamped to a
floor of 2, the sweep interval to 1 s.

### 128.5.0 The ceiling is machine-derived, NOT V8's heap limit (HS-9555)

Until 2026-08-01 every guard in this document compared `external` against
`v8.getHeapStatistics().heap_size_limit`, and `heapSizeLimitBytes` was commented "the OOM
boundary". **For this memory that was simply the wrong quantity.** A PGLite WASM heap is
malloc'd native memory outside the V8 old space: the old-space limit does not bound it, does
not fail an allocation at it, and does not abort past it. The real boundary is the machine.

So on a 32 GB machine the cluster cache was budgeted against **4144 MB** — V8's *default*
old-space size, a number nobody here chose. During the 2026-08-01 death the kernel reported
memory pressure `normal` throughout (§131 working correctly) while the server evicted itself
into a churn spiral against that inherited default.

**Why that number specifically caused the spiral.** The caps and the guard were mutually
inconsistent. A full cache is `maxOpen` 10 + `maxTelemetryOpen` 6 = 16 clusters ≈ **2.9 GB**.
The headroom guard fires above `ceiling − headroomFloorBytes` = 4144 − 768 = **3376 MB**. That
left ~480 MB between "the cache is legitimately full" and "start pressure-evicting" — under
three clusters, and less than the uncollected heaps that always exist between forced
collections (§128.5.6). The guard therefore fired during *normal operation with a full cache*,
evicted, saw no drop because the closes were not yet collected, and evicted again.

`src/db/memoryCeiling.ts` resolves the ceiling instead: **25% of machine RAM, floored at the V8
heap limit** (so no machine ever gets a smaller budget than it had — an 8 GB machine's 25% is
below its own default old-space limit) **and capped at 12 GB**. The count caps remain the real
bound on residency; this governs only when the *pressure* guards start fighting. Measured on
the maintainer's machine: 4144 MB → **8192 MB**, logged once at startup by
`describeExternalCeiling()` so `usedPctOfLimit` in a freeze log has a visible denominator.

**Why not `--max-old-space-size`.** It is the obvious first idea and it does not work here.
Measured:

```
node                                                 -> heap_size_limit 4144 MB
v8.setFlagsFromString('--max-old-space-size=12288')  -> still 4144 MB
node --max-old-space-size=12288                      -> 12336 MB
```

The flag is honored only at launcher level, and there are three launchers (the `dist/cli.js`
npm bin, the Tauri sidecar, the dev `node --import tsx` spawn). A shebang cannot portably carry
node flags, so the npm bin would need a re-exec — which would break the Tauri PID tracking that
deliberately spawns the server so its PID is directly killable. And it would be treating the
wrong thing regardless: at the wedge `heapUsed` was **184 MB of 4144 MB**. The JS heap was never
under pressure; only the denominator was wrong. Raising the old-space limit stays available and
orthogonal.

### 128.5.1 Why the idle window is split by type (HS-9467)

The two kinds of cluster are not alike in either the cost of closing them or the benefit:

- A **project** cluster backs tab switches, so a reopen is a hitch the user sees. Measured on
  arm64 / Node 22.14: **60–240 ms** to reopen a real 57 MB cluster warm, and **537 ms – 2.3 s**
  cold in this machine's own `~/.hotsheet/startup.log` (that line only logs opens over 500 ms,
  so it is the slow tail, not the typical). Window cut 10 min → **5 min**: an abandoned tab is
  reclaimed within a coffee break, while an every-few-minutes revisit never pays.
- A **telemetry** cluster is opened by an OTLP ingest burst and then sits there, and **nothing
  user-facing ever waits on one** — the reopen is invisible. They are also the big ones on
  disk (1.0 GB for this repo's own telemetry cluster vs 41 MB for its project DB). Window
  **60 s**, one sweep interval past idle.

Only **idle** mode is type-aware. Cap and headroom are about count and memory, where a telemetry
cluster is not special, so LRU order alone decides — splitting those too would let a busy
telemetry cluster outrank a colder project one for no reason.

**Measured effect** (7 clusters open — 1 anchor, 3 projects, 3 sibling telemetry — with the cap
and recency guard disabled to isolate the sweep):

```
external BEFORE sweep: 1576 MB
evicted: 3 cluster(s)          ← the 3 telemetry ones; all 3 projects kept
external AFTER  sweep:  768 MB   (freed 808 MB, ~270 MB per cluster)
```

**The catch, and it is easy to be fooled by:** that memory comes back on **GC**, not at
`close()`. The same measurement without `--expose-gc` reachable by node reported `freed 0 MB`
and looked like proof that eviction does nothing. Anyone checking whether a tuning change helped
must force or wait for a collection before reading `process.memoryUsage().external` — a reading
taken immediately after a sweep is meaningless.

**Before tuning further, check which layer is actually binding.** With `maxOpen` 10 and roughly
two clusters per project, ~5 active projects already saturate the cap, so on a busy install the
LRU cap may be doing most of the work and the idle windows little. Whether `maxOpen` should
count the two types separately is deliberately left open — see HS-9468.

## 128.5.2 Observing it — the eviction counters (HS-9470)

The policy above is unit-tested, which proves it is what we intended. It cannot say whether the
intent was RIGHT on a real machine, so the cache now counts what it does. The counters ride the
existing §HS-9421 memory snapshot in `freeze.log`, next to `externalMb`:

| Field | Read it for |
| --- | --- |
| `evictCap` / `evictIdle` / `evictHeadroom` | **which layer actually binds.** Mostly `idle` is healthy. Any `headroom` at all means memory is tighter than the budget assumes and the ceilings are too generous. A `cap`-dominated profile means the budget is the binding constraint, which was the pre-HS-9468 situation. |
| `evictProject` / `evictTelemetry` | **whether "telemetry gives way first" holds** in practice, or whether project clusters are being evicted more than intended. |
| `evictChurn` | **read this first.** A cluster evicted and then reopened within 30 s: we paid a close plus a ~180 MB reopen for nothing. Non-trivial churn means a budget or idle window is too tight. |

Counts, deliberately, **not bytes**. Attributing freed memory around an eviction is meaningless
without forcing a GC (§128.5.1), and that trap has already produced one wrong conclusion here. A
counter cannot lie the same way.

The counters are absent from the snapshot until the boot wiring injects the reader, rather than
reported as zeros — zeros would be indistinguishable from "no evictions happened", which is
exactly the ambiguity an observability feature must not introduce.

**Once there is a real session's worth of numbers**, revisit the §128.5 defaults with evidence
rather than the reasoning-from-first-principles they currently rest on.

## 128.5.3 Pressure is acted on periodically, not only on open (HS-9477)

The headroom guard is the only layer that responds to how much memory is **actually in use** —
cap and idle eviction both reason about counts and ages. It ran exclusively on the
cluster-open path, so a server that was bloated but not opening anything had **no response to
memory pressure at all**. Memory climbed, the loop went into GC thrash, and the docs/45
watchdog SIGKILLed the process for being wedged. That is the "server still dying sometimes"
report.

The 60 s sweep now runs the pressure pass before the age pass. `evictForHeadroomBeforeOpen`
is accordingly renamed `evictForHeadroom` — the old name encoded the very assumption that was
wrong.

**What the crash log actually showed**, and what is still open:

```
[watchdog] FATAL: event loop blocked for 61569ms (> 60000ms)
[watchdog] memory at wedge: rss=1795MB heapUsed=231MB external=5852MB
           (heapUsed+external=6083MB = 147% of the 4144MB V8 limit); openPGLiteClusters=1
```

Startup had finished 68 minutes earlier, so this was steady-state, not a startup stall (the
watchdog's message says "where startup stalled" unconditionally, which is misleading for a
long-running process — worth fixing). All the numbers come from one `publishMemorySample` on
the main-thread heartbeat, so they are internally consistent and taken just before the wedge.

The unresolved part: **1 cluster does not explain 5852 MB.** A healthy sample from the same
day reads 15 clusters / 2818 MB — about 188 MB each, matching the ~180 MB figure this doc is
built on. At the wedge the ratio is off by ~30×. Two candidates, not yet distinguished:

1. **GC lag after mass eviction** (§128.5.1) — the clusters were shed, the count dropped, but
   their WASM heaps had not been collected yet. If so, eviction cannot rescue this situation on
   its own, because the memory only returns when V8 decides to collect.
2. **A non-cluster allocator** — `heapUsed` was only 231 MB, so it is Buffers/ArrayBuffers, not
   JS objects. This repo carries 1.0 GB of telemetry JSONL; the readers there are the obvious
   suspects.

Distinguishing them is HS-9478. Until it is settled, the fix here is a genuine improvement
(pressure now gets a response at all) but is **not** established as sufficient.

## 128.5.4 What actually kills the server (HS-9478 — measured, and it is not the cluster count)

**HS-9502 — telemetry-cluster stalls are in the PROJECT's `freeze.log`, tagged `telemetry:`.**
They used to land in `.hotsheet/telemetry/freeze.log`, because the instrumentation derived
its target from the cluster's own directory and a telemetry cluster sits one level deeper
(`telemetryClusterDataDir`). Nothing errored and nothing was lost — the log was silently
SPLIT, and the file every diagnostic instruction names looked complete while the entries
most likely to explain a stall sat one directory down. That matters most exactly here:
the eviction sweeps, OTLP ingest and `VACUUM FULL` passes this doc is about are telemetry
work. One file per project now; identity moved from the path into the label.

The 2026-07-29 death was investigated against `freeze.log`, which already records
`arrayBuffersMb` alongside `externalMb` and (since HS-9470) the eviction counters. No new
instrumentation was needed; the answer was in the data.

**It is not Buffers or file reads.** Across the peak samples `arrayBuffers` is **4–7% of
`external`** (e.g. 393 MB of 8449 MB). Whatever is consuming memory is WASM, not
`readAllOtelJsonl` or a `dumpDataDir` Buffer.

**It is not the live cluster count either.** Same-day comparison, same code:

| | median MB per open cluster | max |
| --- | --- | --- |
| the process that died (02:47) | **248 MB** | **7533 MB** |
| the process that replaced it (03:56), 30+ min | **183 MB** | 252 MB |

A fresh process sits exactly on the ~180 MB/cluster figure this doc is built on and stays there.
The dying one had drifted to 4–40× that. So the WASM heaps of clusters that are *no longer
open* are still resident.

**Why they are still resident:** V8 runs a major GC under **heap** pressure, and `external`
creates none. Throughout the entire spiral `heapUsed` was 130–320 MB against a 4144 MB limit —
completely relaxed — so V8 never had a reason to collect, while `external` climbed to 8449 MB
and the process was SIGKILLed for wedging. HS-9467 measured the same thing from the other side:
evicting 3 telemetry clusters freed **0 MB** normally and **808 MB** with a forced
`global.gc()`.

**And the guard makes it worse.** Because closing frees nothing, the headroom guard keeps seeing
high `external` and keeps evicting, while the work that needed a cluster reopens one and
allocates a *fresh* ~180 MB heap. Each cycle NET ADDS memory:

```
high external -> evict (frees nothing) -> work reopens (+180 MB) -> higher external -> evict harder -> ...
```

Measured, from the dying process's own counters:

| | time | external | clusters | headroom evictions | churn |
| --- | --- | --- | --- | --- | --- |
| healthy | 03:43:12 | 3077 MB | 17 | 0 | 10 |
| onset | 03:52:16 | 4237 MB | 10 | 5 | 12 |
| death | 03:54:26 | 5845 MB | 2 | **375** | **372** |

**370 evictions and 360 churned reopens in ~130 s, and `external` rose.** The §128.2.1
`pendingReclaim` credit was live and did not prevent it: it assumes the memory comes back within
15 s, and here it never comes back at all, so it delays the loop by one window rather than
breaking it.

**What this means for this document.** The LRU cap, the per-type budgets and the idle windows
are all still correct and still worth having — they bound how many heaps get *allocated*. But
every one of them assumes that closing a cluster returns its memory, and **that assumption is
false without a collection**. Until HS-9479 lands, no amount of eviction policy can rescue a
process in this state.

Follow-ups: **HS-9479** (force a GC after a pressure pass — the actual fix), **HS-9480**
(circuit-break the guard when eviction demonstrably isn't reclaiming, so it can never run away
like this again), **HS-9481** (verify PGLite really does release on `close()`; if something
retains the instance, HS-9479 is the wrong fix and this is a reference leak).

### 128.5.5 PGLite does release on close — the missing ingredient is the collection (HS-9481)

§128.5.4 left one assumption unverified: that after `close()` nothing still references the
instance, so a collection *would* reclaim its heap. If PGLite retained it internally, forcing a
GC would fix nothing. Measured directly, and it does not:

```
baseline (1 anchor cluster open)                    194 MB
cycle 1  open 4 -> 1193 MB   close + forced GC ->   194 MB   residue 0 MB
cycle 2  open 4 -> 1193 MB   close + forced GC ->   194 MB   residue 0 MB
cycle 3  open 4 -> 1193 MB   close + forced GC ->   194 MB   residue 0 MB
```

**Zero accumulation across three cycles.** No upstream leak, no internal registry, no stuck
`FinalizationRegistry`. Each cluster costs ~250 MB here and every byte comes back.

The control isolates the actual production behavior:

```
open 4                                     -> 1193 MB
close all, wait 5 s, NO forced GC          -> 1197 MB   (residue 1004 MB — nothing freed)
then force a GC                            ->  194 MB   (residue 0 MB)
```

Closing frees nothing; collecting frees everything. That is the whole bug, in two lines.

**One caveat that can defeat the fix.** A *held* handle pins its heap through both close and
collection:

```
close a cluster while a stale handle is HELD, forced GC -> 385 MB (191 MB retained)
```

GC cannot reclaim what is still reachable. HS-9461 deliberately made stale handles keep working
(reopen + retry), which makes holding one a supported pattern rather than an obvious error — so
nothing discourages code from keeping one, and any long-lived holder silently costs ~190 MB that
HS-9479 cannot recover. Auditing for those is **HS-9483**.

### 128.5.6 Forcing the collection (HS-9479) — the fix the rest of this doc depends on

Every layer above assumes that closing a cluster returns its memory. §128.5.4/§128.5.5 showed
that it does not, because a WASM heap lives in `external` and `external` creates no heap
pressure, so V8 has no reason to collect. `db/forceGc.ts` supplies the missing collection after
any eviction pass that closed something.

**No launcher flag.** `--expose-gc` would need adding to the npm bin, the Tauri sidecar spawn
and the dev command separately, and would be easy to lose. `v8.setFlagsFromString('--expose-gc')`
plus `vm.runInNewContext('gc')` obtains the same function at runtime — one code path, every
launcher, verified to actually collect.

**Two passes, and this is load-bearing.** Measured with ~200 MB of off-heap buffers dropped
immediately beforehand:

```
1 call  -> 194 MB -> 194 MB   (freed NOTHING)
2 calls -> 202 MB ->  10 MB   (freed everything, 10 ms)
3 calls ->            10 MB   (no better, slower)
```

The first collection makes the wrappers unreachable and queues their external-memory finalizers;
the second runs them. **Writing the obvious single `gc()` ships a fix that does nothing at all,
and looks correct in review.** `gc({ type: 'major', execution: 'sync' })` is accepted on this
Node and is *not* a substitute — measured, it freed nothing in one call.

**Rate-limited** (`HOTSHEET_FORCED_GC_MIN_INTERVAL_MS`, default 30 s) because a forced major GC
is stop-the-world, and this project treats a 6.7 s `dumpDataDir` block as a serious defect
(HS-9239). The pause is timed into `freeze.log` as `gc.forced`, so if it ever becomes expensive
it shows up where every other blocking operation does.

**End-to-end, through the real eviction path:**

```
baseline                      428 MB
opened 4 clusters            1193 MB
after a pressure eviction     194 MB    <- before HS-9479 this stayed at ~1197 MB
```

`forceGcNow` returns `collected | throttled | unavailable` rather than nothing, because "did not
run" and "ran and freed nothing" are the two states this area keeps conflating. If no collector
can be obtained, `connection.ts` says so once, loudly — a build where eviction cannot reclaim is
one that will climb until the watchdog restarts it, and that should not be silent.

### 128.5.7 Retained handles defeat all of it (HS-9483 audit)

Forcing the collection (§128.5.6) only helps if nothing else is still holding the cluster. A
single surviving reference makes eviction, the idle sweep, the headroom guard **and** the forced
GC all no-ops together — the cluster is closed, unreachable through `databases`, and still
resident. So after HS-9479 the next question was: does anything hold one?

**Audited** with ast-grep for the shapes that retain across an eviction — module-level `let`
bindings of a `PGlite`, object/class properties typed `PGlite`, and handles captured by timers or
long-lived closures. Two structural hits:

- **`src/backup.ts` `activePreviews: Map<string, PGlite>`** — smaller, but genuinely leaky: the
  entry was removed only when the client posted `/preview/cleanup`, so either query throwing, or
  the user closing the preview / the tab, stranded a whole second cluster. Nothing read the
  retained handle (`cleanupPreview` was its only other consumer), so it is now closed in a
  `finally` — held for exactly the one request that opens it. The endpoint stays and now just
  removes the `_preview` directory.
- **`src/projects.ts` `ProjectContext.db: PGlite`**, inside the process-lifetime
  `const projects = new Map<string, ProjectContext>()` — **the leak.** It is assigned once at
  registration and never reassigned, so each registered project pins the exact instance that
  existed when it was registered, forever. Eviction closes that instance and removes it from
  `databases`; this Map keeps it alive anyway. A later reopen builds a *new* instance beside the
  old one.

Measured on the real path, with the HS-9479 forced collection running:

```
baseline                                    194 MB
4 projects registered (handle in the Map)  1193 MB
evicted all + forced GC                     959 MB   residue 765 MB   <- ~191 MB per project, LEAKED
after clearing the Map + forced GC          194 MB   residue   0 MB
```

The Map is precisely what pins them, and clearing it is what releases them. With 10 registered
projects that is roughly **2 GB permanently unreclaimable** against a 4144 MB ceiling — a floor
everything else stacks on, and the reason §128.5.4 measured 248 MB median / 7533 MB max per
*open* cluster.

**Fixed in HS-9485** by dropping the field rather than teaching it to track eviction — a handle
that must be kept in sync with the cache is the same defect shape as HS-9461's stale handles. The
two consumers (the projects-list counts and `feedback-state`) resolve with `getDbForDir(p.dataDir)`
per §128.3.2, which also means they see a reopened cluster instead of a closed one.
`registerExistingProject` lost its `db` argument — it existed only to populate the field, and the
cluster is already in the `databases` cache by the time cli.ts calls it.

**The rule this leaves behind:** a `PGlite` may be held for the duration of one operation (a pin,
per §128.3.2) and never beyond it. Anything that outlives a request must store the **`dataDir`**
and resolve the handle at use.

Pinned by `connectionEviction.test.ts` — register three projects, evict everything, force a
collection, and assert `external` returns to within 100 MB of baseline **while the projects are
still registered** (a tab left open keeps its project registered for the life of the process).
Verified to fail on a deliberately retained handle: 356 MB residue. The preview lifecycle has its
own two cases in `backup.test.ts`, including the throw path, via the `_activePreviewCountForTests`
seam.

### 128.5.8 The guard's self-check (HS-9480)

Everything above assumes evicting reclaims. §128.5.6 made that true again, and this is the
guard against the assumption breaking a second time — worth having on its own terms, because a
control loop that cannot tell success from failure will eventually run away. It already did:

| | time | external | clusters | headroom evictions | churn |
|---|---|---|---|---|---|
| healthy | 03:43:12 | 3077 MB | 17 | 0 | 10 |
| onset | 03:52:16 | 4237 MB | 10 | 5 | 12 |
| death | 03:54:26 | 5845 MB | 2 | **375** | **372** |

375 headroom evictions and 372 churned reopens in ~130 s, and `external` went **up** (peaking at
8449 MB), because closing freed nothing while the work that needed a cluster reopened one and
allocated another ~180 MB. Each cycle net ADDED memory. The HS-9468 `pendingReclaim` credit was
designed for exactly this and was live; it didn't help, because it assumes the memory returns
within 15 s and here it never returned at all.

`clusterEviction.ts` now carries a pure `HeadroomBreakerState` (`noteHeadroomPass` /
`isHeadroomSuppressed`). `evictForHeadroom` measures `external` either side of each pass; after
`HEADROOM_BREAKER_TRIP_COUNT` (3) consecutive passes fail to free at least a quarter of what the
clusters they closed should have been worth, pressure eviction is suspended for
`HEADROOM_BREAKER_BACKOFF_MS` (5 min). One working pass re-arms it completely, so a transient
blip can't latch; when the back-off expires one probe pass goes through, and if that still fails
it re-suspends immediately rather than re-earning all three.

Three details that matter:

- **Only a pass where a collection actually ran is judged.** `forceGcNow` is throttled to one
  collection per 30 s (it is stop-the-world), and a throttled pass legitimately frees nothing —
  counting it would trip the breaker on a perfectly healthy server. `runEvictionDetailed` reports
  the `ForceGcResult` so `evictForHeadroom` can tell the two apart.
- **Only the pressure path is suspended.** The cap and idle sweeps keep running; they are not the
  runaway, and suspending the cap would let the cache grow unbounded — the original bug.
- **The log line is distinct.** "We are low on memory" and "our only lever does not work" are
  completely different operator stories, and before this they were the same message.

Tests: the pure transition matrix in `clusterEviction.test.ts` (armed while working, trips only on
the Nth failure, trips on the real external-going-up signature, re-arms on one success, back-off
expiry + re-suspend, partial reclaim counts as working, and the bar scales with the number of
clusters closed) plus `headroomBreakerWiring.test.ts`, which pins `currentExternalBytes` to a
constant and drives **real** clusters through `evictForHeadroom` — it evicts for three passes, then
stops, logs the suspension exactly once, and leaves the idle sweep working. Verified to fail when
the breaker is not consulted.

### 128.5.9 A burst of closes overrides the GC throttle (HS-9553)

§128.5.6 forces the collection that makes eviction mean anything, rate-limited to **one per
30 s** because a forced major GC is stop-the-world. That floor assumes closes arrive at a human
pace. On 2026-08-01 they did not.

The machine resumed from a ~16-minute sleep and the whole periodic world fired at once — the
5-minute backup train, the hourly backup, telemetry ingest, the github scheduled sync, the idle
sweep and the headroom guard — churning clusters **~15 times in 2 seconds** (`evictChurn`
125 → 140 in `freeze.log`). From the log:

```
06:31:57.041  clusters=10  external=2680MB   68%
06:31:57.271  clusters= 1  external=1127MB   30%   <- the one collection that was allowed
06:31:57.845  clusters= 6  external=2241MB   58%
06:31:58.767  clusters= 3  external=4892MB  122%   <- 3 open, 4.3GB of ALREADY-CLOSED heaps
06:31:58.962  clusters= 5  external=5012MB  125%
```

The first sweep collected and worked exactly as designed. Every close for the next 30 s then
returned `'throttled'` and freed nothing, while each reopen allocated a fresh ~180 MB heap. That
is §128.5.4's runaway with the throttle standing in for the missing collection:

```
high external -> evict (throttled, frees nothing) -> reopen (+180 MB) -> higher external
```

**The HS-9480 breaker could not catch it either.** `noteHeadroomPass` is only called when
`gc === 'collected'` — deliberately, since a throttled pass legitimately frees nothing and
counting it would trip the breaker on a healthy server. During the storm essentially every pass
was throttled, so the breaker never counted an ineffective pass and never tripped. The safety
net was blind in exactly the regime it exists for.

So `shouldForceGc` now takes the accumulated **unreclaimed debt** and collects regardless of
elapsed time once it reaches `HOTSHEET_FORCED_GC_URGENT_BYTES` (3 clusters). This cannot degrade
into collect-on-every-close — the bypass requires that much *already-closed, uncollected* heap,
which only a burst produces, and `connection.ts` clears the credit when a collection actually
runs. Clearing it also fixes a second-order error: the credit is subtracted from `external` when
sizing the budget (§128.2.1), so leaving it in place after a successful collection inflated
apparent headroom for the rest of the lag window.

Side effect worth naming: because storms now produce *measured* passes rather than throttled
ones, the §128.5.8 breaker starts receiving real data in the one situation it was written for.

### 128.5.10 A trapped WASM instance is dead — stop calling it (HS-9554)

The 2026-08-01 process was SIGKILLed by the §45 watchdog after a **61.7 s** event-loop block.
The watchdog's FATAL line called it GC thrash; it prints that whenever memory is above 75% of
the limit. The `sample` it captured one line later says otherwise — 1373 of 1456 samples, one
stack:

```
Runtime_ThrowWasmError -> Factory::NewWasmRuntimeError -> ErrorUtils::MakeGenericError
  -> Isolate::CaptureAndSetErrorStack -> CaptureSimpleStackTrace (1079)
     -> OptimizedFrame::Summarize (390) / UnoptimizedFrame::Summarize (337)
```

**Not one sample in GC.** The loop was pinned constructing `WebAssembly.RuntimeError`s inside a
promise continuation off an inbound HTTP request. A WASM trap is cheap to raise; the *error
object* is not — V8 captures a stack trace, and on a JIT-optimized async stack that means
deoptimizing frame translation per frame per throw. Hundreds of those is a wedged event loop.

The missing invariant: **a trapped WASM instance never recovers.** An emscripten `abort()` /
`unreachable` / out-of-bounds trap leaves the module permanently faulted, so every later call
traps identically. `isRecoverableOpenError` has encoded that for *open* failures since HS-8426,
but a trap on a **live query** fell through every branch of the query proxy's catch and merely
propagated — leaving the dead handle in the `databases` map for the caller's next row to hit.

`wasmTrap.ts` adds the predicate (matching on `.name === 'RuntimeError'` as well as message —
the bare `unreachable` variant carries no "RuntimeError" text, which is what HS-7889 missed and
what recurred here) and `connection.ts` **poisons** the cluster: drop the handle, take it out of
action for a 30 s cooldown, and raise a stack-less `PoisonedClusterError` from `getDbByPath`.

Two things this deliberately does **not** do:

- It does **not** stop the caller's loop — the caller decides how many rows it iterates. It makes
  each iteration fail immediately and cheaply from a pre-built JS error instead of re-entering
  WASM. That is the difference between a wedged loop and a failed request, which is the outcome
  §45 exists to prefer.
- A poisoned cluster is **not** added to `evictedClusterPaths`, so the §128.3.1 stale-handle heal
  will not resurrect it. Healing a trap would allocate a fresh ~180 MB heap *per failing
  statement* — the same runaway one level up. The trap check therefore runs **before** the
  closed-instance check in the proxy's catch.

Also fixed here: the watchdog's stack capture was named from `Date.now()` at watchdog *start*,
so this wedge's file was stamped `2026-07-31T04-29-43` — 26 hours off — and every wedge in one
process overwrote the same path. The worker now substitutes the timestamp at capture time. And
the FATAL line no longer asserts "GC thrash"; memory pressure, GC thrash and a trap storm are
indistinguishable from the watchdog's vantage point, and saying otherwise sent this
investigation the wrong way.

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
- `src/db/headroomBreakerWiring.test.ts` — the §128.5.8 circuit breaker wired into
  `evictForHeadroom` against real clusters (pressure eviction suspends; cap + idle keep running).
- `src/db/memoryCeiling.test.ts` — §128.5.0: the 32 GB case, the heap-limit floor (no machine
  regresses), the large-machine cap, override handling incl. junk that must not become `NaN`, and
  the gap-between-full-cache-and-guard property that is the actual fix.
- `src/db/forceGc.test.ts` — §128.5.9: the debt bypass, a replay of the 15-closes-in-2s burst,
  and the negative case that it must not degrade into collect-on-every-close.
- `src/db/wasmTrap.test.ts` — §128.5.10: trap recognition (including the bare `unreachable`
  variant), the non-matches that must keep healing (`PGlite is closed`) or stay ordinary errors,
  and that `PoisonedClusterError` captures no stack.
- `src/db/queryInstrumentation.test.ts` — §128.5.10 routing: a trap reports and propagates
  without a reopen, is checked *before* the closed-instance heal, releases the in-flight count,
  and survives a missing handler.
- `src/db/queryInstrumentation.test.ts` — the always-on proxy stays transparent when
  freeze-timing is disabled, and in-flight counts are tracked (and released on reject).

## 128.8 Relation to the earlier mitigations

The OOM epic shipped in layers: HS-9420 direction-1 (`ac7816c`, telemetry maintenance closes the
cluster it opened) was the first mitigation; HS-9426/HS-9427 bounded + reclaimed telemetry **WAL
disk** ([127](127-telemetry-wal-management.md)). This doc is the **cure** — the general bounded
cache that makes process memory independent of project count.
