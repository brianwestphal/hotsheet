/**
 * HS-9420 (docs/128) — bound the open-PGLite-cluster set so the server can't
 * OOM by pinning every project + telemetry cluster's ~180 MB WASM heap forever.
 *
 * ## The bug this closes
 * `connection.ts`'s `databases` Map was an unbounded cache with NO eviction:
 * anything that opened a cluster (a project restore, a telemetry ingest, a
 * cross-project dashboard fan-out) pinned its WASM heap for the life of the
 * process. On an install with ~10 projects that landed ~3.2 GB of `external`
 * (WASM) memory against V8's ~4.1 GB ceiling — and `external` does NOT show up
 * in RSS, so the 2026-07-24 crash loop went undiagnosed. See the ticket.
 *
 * ## The policy (maintainer chose option "c" — all three layers)
 * 1. **LRU cap.** Keep at most `maxOpen` clusters. Opening the (cap+1)-th evicts
 *    the least-recently-used cluster that is safe to close. The active project is
 *    protected two ways: it is constantly re-accessed (so it sits at the MRU end
 *    and is never the victim), and `defaultDbPath` is always pinned.
 * 2. **Idle-close.** A periodic sweep closes any non-pinned cluster untouched for
 *    `idleMs`. This is what reclaims the telemetry clusters an OTLP ingest burst
 *    opened (the "creep" in the ticket) — they go idle and get closed.
 * 3. **Headroom guard.** Before opening a new cluster, if `external` is within
 *    `headroomFloorBytes` of the heap ceiling, evict LRU clusters *ignoring the
 *    recency guard* (but never one mid-query) to buy headroom before allocating
 *    another ~180 MB heap. The hard safety valve.
 *
 * ## Correctness: never evict a cluster mid-query
 * The one hard invariant is that a close must not land on a cluster with an
 * in-flight query — that would reject the caller's `await db.query(...)`. Two
 * mechanisms guarantee it:
 *   - **In-flight tracking.** The query-instrumentation proxy (`queryInstrumentation.ts`)
 *     calls `beginClusterQuery`/`endClusterQuery` around every `query`/`exec`/
 *     `dumpDataDir`. A cluster with `inFlight > 0` is NEVER chosen for eviction,
 *     in any mode. This protects long single operations (a big `dumpDataDir`
 *     backup) whose caller holds the reference across the whole call.
 *   - **Recency guard.** Cap/idle eviction also skips clusters accessed within
 *     `minIdleMs`, so a just-accessed cluster is safe even in the gap between a
 *     caller's `getDb()` and its first query. (The headroom guard drops this
 *     softer guard when memory is critical, but keeps the hard in-flight one.)
 * A sequential cross-project fan-out (`for (p of projects) await runWithDataDir(p,…)`)
 * is naturally safe: each cluster's query fully settles before the next opens, so
 * an already-finished fan-out cluster carries no in-flight query.
 *
 * This module is pure policy + bookkeeping — it owns no PGLite handles and never
 * imports `connection.ts` (no cycle). `connection.ts` records access/close events
 * here, asks `chooseEvictions` what to close, and performs the closes itself.
 */

import { basename, dirname } from 'node:path';
import v8 from 'node:v8';

/**
 * Is this a TELEMETRY cluster's `db/` dir (`<dataDir>/telemetry/db`) rather than a
 * project's own (`<dataDir>/db`, where `<dataDir>` is always a `.hotsheet` dir)?
 *
 * Lives here rather than in `connection.ts` (which re-exports it) because the pure
 * planner below needs it and `connection.ts` imports this module — the other
 * direction would be a cycle. Originally added for the HS-9426 WAL budget.
 */
export function isTelemetryClusterDbPath(dbPath: string): boolean {
  return basename(dirname(dbPath)) === 'telemetry';
}

/** Per-cluster bookkeeping the planner reasons over. */
export interface ClusterState {
  /** The `<dataDir>/db` path — the `databases` Map key in connection.ts. */
  dbPath: string;
  /** ms-epoch of the most recent access (open or cache hit). */
  lastAccess: number;
  /** Count of in-flight timed queries (query/exec/dumpDataDir). */
  inFlight: number;
}

export type EvictionMode = 'cap' | 'idle' | 'headroom';

export interface EvictionInput {
  /** Every currently-open cluster (including pinned ones — filtered here). */
  clusters: readonly ClusterState[];
  /** Paths that must never be evicted (e.g. the launch/default project). */
  pinnedPaths: ReadonlySet<string>;
  now: number;
  mode: EvictionMode;
  /**
   * `cap`: the per-type budget (HS-9468). Project and telemetry clusters have
   * SEPARATE LRUs, so a telemetry burst can't evict the project the user is
   * looking at. Sized from live memory pressure by `clusterBudget`.
   */
  budget: ClusterBudget;
  /** `cap`: don't evict a cluster accessed within this many ms (recency guard). */
  minIdleMs: number;
  /** `idle`: evict any non-pinned PROJECT cluster untouched for at least this long. */
  idleMs: number;
  /**
   * `idle`: the same for a TELEMETRY cluster (HS-9467). Deliberately much shorter —
   * see `resolveEvictionConfig` for why the two are not alike.
   */
  telemetryIdleMs: number;
  /** `headroom`: how many clusters to try to free (ignores the recency guard). */
  targetEvictions: number;
}

/**
 * Pure eviction planner. Returns the dbPaths to close, in eviction order.
 * Deterministic and side-effect-free — the whole policy lives here so the
 * transition matrix (cap/idle/headroom × pinned/in-flight/recency) is unit-tested
 * without opening a single real cluster.
 *
 * Invariants held in EVERY mode: a pinned cluster is never returned, and a
 * cluster with `inFlight > 0` is never returned.
 */
export function chooseEvictions(input: EvictionInput): string[] {
  const evictable = input.clusters.filter(
    (c) => !input.pinnedPaths.has(c.dbPath) && c.inFlight === 0,
  );

  if (input.mode === 'idle') {
    // Every cluster aged past ITS OWN idle threshold — order doesn't matter.
    // HS-9467: a telemetry cluster gets a much shorter window than a project one.
    return evictable
      .filter((c) => {
        const window = isTelemetryClusterDbPath(c.dbPath) ? input.telemetryIdleMs : input.idleMs;
        return input.now - c.lastAccess >= window;
      })
      .map((c) => c.dbPath);
  }

  // cap + headroom both evict in LRU order (oldest access first).
  const byLru = [...evictable].sort((a, b) => a.lastAccess - b.lastAccess);

  if (input.mode === 'cap') {
    // HS-9468 — two independent LRUs. Counting them together let one type's
    // churn evict the other's warm clusters; with two clusters per project a
    // single combined cap of 10 was saturated by ~5 projects.
    const overBudget = (type: 'project' | 'telemetry'): string[] => {
      const isTel = type === 'telemetry';
      const all = input.clusters.filter((c) => isTelemetryClusterDbPath(c.dbPath) === isTel);
      const limit = isTel ? input.budget.telemetry : input.budget.project;
      const overBy = all.length - limit;
      if (overBy <= 0) return [];
      // Only evict clusters aged past the recency guard, so a burst that opened
      // many at once doesn't immediately churn-evict a just-touched one.
      const aged = byLru
        .filter((c) => isTelemetryClusterDbPath(c.dbPath) === isTel)
        .filter((c) => input.now - c.lastAccess >= input.minIdleMs);
      return aged.slice(0, overBy).map((c) => c.dbPath);
    };
    // Telemetry first: if both are over budget, the cheaper reopens go first.
    return [...overBudget('telemetry'), ...overBudget('project')];
  }

  // headroom (critical): free `targetEvictions` LRU clusters, dropping the
  // recency guard (memory pressure outweighs a reopen) but NEVER the in-flight
  // guard (already applied above).
  const target = Math.max(0, input.targetEvictions);
  return byLru.slice(0, target).map((c) => c.dbPath);
}

// ── Bookkeeping ────────────────────────────────────────────────────────────
// Module-level maps keyed by dbPath. Kept in lockstep with connection.ts's
// `databases` Map: an entry appears on first access and is removed by
// `forgetCluster` when the cluster is closed (by eviction, explicit close, or
// shutdown). A stale entry can never cause a wrong eviction because
// `chooseEvictions` only ever operates over the caller-supplied live cluster
// list — these maps only supply lastAccess / inFlight for those live paths.

const lastAccess = new Map<string, number>();
const inFlight = new Map<string, number>();

/**
 * HS-9470 — eviction counters, so the HS-9468 budget can be judged on a real
 * machine instead of only in unit tests.
 *
 * The tests prove the policy is what we intended; they cannot say whether the
 * intent was right. Three things are worth knowing and none were observable:
 *
 *  - **Which mode evicts.** Before HS-9468 the cap was suspected of doing nearly
 *    all of it. It should now be mostly `idle`. Any `headroom` firing at all means
 *    memory is tighter than the budget assumes and the ceilings are too generous.
 *  - **Churn** — a cluster evicted and then reopened seconds later. That is the
 *    signal a budget or window is too tight, and it is the cost the user actually
 *    feels (a reopen is 60–240 ms warm).
 *  - **Whether the split holds** — are project clusters staying put while
 *    telemetry absorbs the pressure, as "telemetry gives way first" intends?
 *
 * Counts, deliberately, rather than bytes. Attributing freed memory around an
 * eviction is meaningless without forcing a GC (docs/128 §128.5.1) — that trap has
 * already produced one wrong conclusion in this area, and a counter cannot lie the
 * same way.
 */
export interface EvictionStats {
  /** Evictions by mode, since process start. */
  byMode: Record<EvictionMode, number>;
  /** Evictions by cluster type. */
  project: number;
  telemetry: number;
  /** Evicted, then reopened within `CHURN_WINDOW_MS` — the budget was too tight. */
  churn: number;
}

/** A reopen sooner than this after an eviction means we should not have closed it. */
export const CHURN_WINDOW_MS = 30_000;

const stats: EvictionStats = {
  byMode: { cap: 0, idle: 0, headroom: 0 },
  project: 0,
  telemetry: 0,
  churn: 0,
};

/** When each recently-evicted path was closed, for churn detection. Bounded by
 *  pruning on write — a path that is never reopened ages out rather than leaking. */
const evictedAt = new Map<string, number>();

/** Record an eviction. Called by `connection.ts` as it closes each victim. */
export function noteEviction(dbPath: string, mode: EvictionMode, now: number = Date.now()): void {
  stats.byMode[mode] += 1;
  if (isTelemetryClusterDbPath(dbPath)) stats.telemetry += 1;
  else stats.project += 1;
  evictedAt.set(dbPath, now);
  // Prune anything past the churn window; nothing older can ever count.
  for (const [path, at] of evictedAt) {
    if (now - at > CHURN_WINDOW_MS) evictedAt.delete(path);
  }
}

/** A point-in-time copy. Cheap enough to read from the diagnostics snapshot. */
export function evictionStats(): EvictionStats {
  return { byMode: { ...stats.byMode }, project: stats.project, telemetry: stats.telemetry, churn: stats.churn };
}

/** Test seam — zero the counters. */
export function resetEvictionStatsForTests(): void {
  stats.byMode = { cap: 0, idle: 0, headroom: 0 };
  stats.project = 0;
  stats.telemetry = 0;
  stats.churn = 0;
  evictedAt.clear();
}

/** Record that a cluster was just opened or served from cache. */
export function noteClusterAccess(dbPath: string, now: number = Date.now()): void {
  // HS-9470 — reopening something we evicted moments ago is churn: we paid a close
  // and a reopen for nothing. Counted here because this is the one call every
  // open and cache-hit funnels through.
  const closedAt = evictedAt.get(dbPath);
  if (closedAt !== undefined) {
    if (now - closedAt <= CHURN_WINDOW_MS) stats.churn += 1;
    evictedAt.delete(dbPath);
  }
  lastAccess.set(dbPath, now);
}

/** A timed query (query/exec/dumpDataDir) started on this cluster. */
export function beginClusterQuery(dbPath: string, now: number = Date.now()): void {
  inFlight.set(dbPath, (inFlight.get(dbPath) ?? 0) + 1);
  // A query is an access — keep the cluster warm for the recency guard even if
  // the caller cached the handle and isn't calling getDb() each statement.
  lastAccess.set(dbPath, now);
}

/** A timed query settled (resolve or reject). */
export function endClusterQuery(dbPath: string, now: number = Date.now()): void {
  const n = inFlight.get(dbPath) ?? 0;
  if (n <= 1) inFlight.delete(dbPath);
  else inFlight.set(dbPath, n - 1);
  lastAccess.set(dbPath, now);
}

/** Drop all bookkeeping for a cluster that has been closed. Idempotent. */
export function forgetCluster(dbPath: string): void {
  lastAccess.delete(dbPath);
  inFlight.delete(dbPath);
}

/** In-flight query count for a cluster (0 if untracked). */
export function clusterInFlight(dbPath: string): number {
  return inFlight.get(dbPath) ?? 0;
}

/** Last-access ms-epoch for a cluster, or 0 if never accessed. */
export function clusterLastAccess(dbPath: string): number {
  return lastAccess.get(dbPath) ?? 0;
}

/**
 * Snapshot the live `ClusterState[]` for the given open paths, pulling
 * lastAccess / inFlight from the bookkeeping maps. A path with no recorded
 * access (shouldn't happen for a live cluster, but be defensive) is treated as
 * accessed `now` so it isn't spuriously evicted before it's been used.
 */
export function snapshotClusters(openPaths: Iterable<string>, now: number = Date.now()): ClusterState[] {
  const out: ClusterState[] = [];
  for (const dbPath of openPaths) {
    out.push({
      dbPath,
      lastAccess: lastAccess.get(dbPath) ?? now,
      inFlight: inFlight.get(dbPath) ?? 0,
    });
  }
  return out;
}

/** Reset ALL bookkeeping. Tests only — production never clears wholesale
 *  (individual `forgetCluster` on close is the production path). */
export function resetEvictionTrackingForTests(): void {
  lastAccess.clear();
  inFlight.clear();
}

// ── Configuration ──────────────────────────────────────────────────────────

export interface EvictionConfig {
  maxOpen: number;
  idleMs: number;
  /** HS-9467 — the shorter idle window for telemetry clusters. */
  telemetryIdleMs: number;
  minIdleMs: number;
  headroomFloorBytes: number;
  sweepIntervalMs: number;
  /** HS-9468 — ceiling on open TELEMETRY clusters when memory is plentiful.
   *  (`maxOpen` is the matching project-cluster ceiling.) */
  maxTelemetryOpen: number;
  /** HS-9468 — floors the pressure-driven budget never shrinks below, so the
   *  active project and the cluster an ingest burst is writing to survive even
   *  when memory is critical. */
  minOpen: number;
  minTelemetryOpen: number;
}

/** ~WASM heap per open PGLite cluster, from the HS-9420 live measurement
 *  (3.2 GB / 18 clusters ≈ 180 MB). Used only to size the headroom-guard's
 *  eviction count; an approximation is fine for a safety valve. */
export const APPROX_CLUSTER_EXTERNAL_BYTES = 180 * 1024 * 1024;

/**
 * HS-9468 — how many clusters of each type we can afford to keep open RIGHT NOW.
 *
 * Replaces the fixed `maxOpen` count with a budget derived from live memory
 * pressure: keep more when there is headroom, fewer when there is not. The
 * feedback loop is self-regulating — every cluster we open raises `external`,
 * which lowers the budget, which is what eventually evicts something.
 *
 * Two policy decisions are encoded here, both from the maintainer:
 *
 *  1. **Project and telemetry clusters get SEPARATE budgets** (separate LRUs), so
 *     a burst of telemetry opens can't evict the project the user is looking at,
 *     and vice versa. Under a single cap they competed, and with two clusters per
 *     project ~5 projects saturated it.
 *  2. **Telemetry gives way first.** When the affordable total shrinks, it comes
 *     out of the telemetry budget before the project one — a stats page paying a
 *     reopen is cheap, a tab switch paying one is not. The telemetry FLOOR still
 *     holds, because telemetry WRITE throughput matters (an ingest burst
 *     shouldn't reopen on every batch) even though read latency doesn't.
 *
 * `pendingReclaimBytes` is the subtle part, and it comes from a measurement that
 * nearly produced the wrong conclusion (docs/128 §128.5.1): a closed cluster's
 * WASM heap is returned on **GC**, not at `close()`. Reading `external` straight
 * after an eviction still sees the freed memory, so a naive pressure loop would
 * evict again, and again — an over-eviction cascade triggered by its own success.
 * Bytes already promised back are subtracted before computing pressure.
 *
 * Pure. Exported for the unit test.
 */
export interface ClusterBudgetInput {
  externalBytes: number;
  heapLimitBytes: number;
  headroomFloorBytes: number;
  /** Clusters closed but not yet collected — see above. */
  pendingReclaimBytes: number;
  /** Currently-open counts, the base the budget grows or shrinks from. */
  openProject: number;
  openTelemetry: number;
  maxProject: number;
  maxTelemetry: number;
  minProject: number;
  minTelemetry: number;
  /**
   * HS-9469 — the MACHINE's memory pressure, passed in (not read here) so the
   * planner stays pure. `warn` halves what the process-level term allows;
   * `critical` goes straight to the floors. Applied as a CEILING on the
   * process-derived budget, never a licence to grow: if either signal says
   * memory is tight, memory is tight.
   */
  systemPressure: 'normal' | 'warn' | 'critical';
}

export interface ClusterBudget {
  project: number;
  telemetry: number;
}

export function clusterBudget(input: ClusterBudgetInput): ClusterBudget {
  const effectiveExternal = Math.max(0, input.externalBytes - input.pendingReclaimBytes);
  const headroom = input.heapLimitBytes - effectiveExternal;
  // How many more (or fewer, when negative) cluster-sized heaps fit above the floor.
  const spare = Math.floor((headroom - input.headroomFloorBytes) / APPROX_CLUSTER_EXTERNAL_BYTES);
  const open = input.openProject + input.openTelemetry;

  const floorTotal = input.minProject + input.minTelemetry;
  const ceilTotal = input.maxProject + input.maxTelemetry;
  const allowedTotal = Math.min(Math.max(open + spare, floorTotal), ceilTotal);

  // Projects are served first; telemetry takes what's left. That ordering IS the
  // "telemetry gives way first" rule — under pressure the subtraction lands on
  // telemetry until it hits its floor, and only then on projects.
  // HS-9469 — the machine's verdict caps what the process-level headroom allows.
  // Taking the MORE CONSERVATIVE of the two is the whole point: process headroom
  // can look roomy while the machine is swapping, and vice versa.
  const constrained = applySystemPressure(allowedTotal, floorTotal, input.systemPressure);

  const project = clamp(constrained - input.minTelemetry, input.minProject, input.maxProject);
  const telemetry = clamp(constrained - project, input.minTelemetry, input.maxTelemetry);
  return { project, telemetry };
}

/**
 * HS-9469 — fold the machine-level verdict into the affordable total.
 *
 * `warn` halves the room ABOVE the floors rather than halving the total, so the
 * floors keep their meaning (the active project and one telemetry cluster survive
 * every level). `critical` drops to the floors outright — at that point the
 * machine is stalling and holding cache is actively harmful.
 */
function applySystemPressure(allowedTotal: number, floorTotal: number, level: 'normal' | 'warn' | 'critical'): number {
  if (level === 'normal') return allowedTotal;
  if (level === 'critical') return floorTotal;
  const above = Math.max(0, allowedTotal - floorTotal);
  return floorTotal + Math.floor(above / 2);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), Math.max(lo, hi));
}

/** Parse a NON-NEGATIVE numeric env, falling back on absent/blank/invalid/negative.
 *  0 is accepted deliberately — `minIdleMs`/`idleMs`/`headroomFloorBytes` all treat
 *  0 as a meaningful "disable this guard" value. */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the eviction config from env (overridable for tuning / tests) with
 * production defaults. Defaults chosen against the HS-9420 evidence:
 *   - maxOpen 10 → ≤ ~1.8 GB steady worst case, leaving ~2 GB headroom.
 *   - idleMs 10 min → telemetry clusters an ingest burst opened get reclaimed.
 *   - minIdleMs 30 s → comfortably longer than any query sequence, so cap
 *     eviction never races a just-switched-to project.
 *   - headroomFloorBytes 768 MB → trip the critical guard well before the
 *     ~900 MB margin that was already OOMing.
 */
export function resolveEvictionConfig(): EvictionConfig {
  return {
    // HS-9468 — `maxOpen` is now the PROJECT-cluster ceiling (it was a combined
    // one; with two clusters per project that meant ~5 projects saturated it).
    // Both ceilings apply only when memory is plentiful — `clusterBudget` scales
    // down from here as pressure rises.
    maxOpen: Math.max(2, numEnv('HOTSHEET_MAX_OPEN_CLUSTERS', 10)),
    maxTelemetryOpen: Math.max(1, numEnv('HOTSHEET_MAX_OPEN_TELEMETRY_CLUSTERS', 6)),
    // Floors: the active project always stays, and one telemetry cluster stays so
    // an ingest burst isn't reopening on every batch (write throughput matters
    // even though telemetry read latency doesn't).
    minOpen: Math.max(1, numEnv('HOTSHEET_MIN_OPEN_CLUSTERS', 2)),
    minTelemetryOpen: Math.max(1, numEnv('HOTSHEET_MIN_OPEN_TELEMETRY_CLUSTERS', 1)),
    // HS-9467 — the idle window is split by cluster type, because the two are not
    // alike in either cost or benefit:
    //
    //  - A PROJECT cluster backs tab switches, so a reopen is a hitch the user
    //    sees: measured 60–240 ms warm on a real 57 MB cluster (arm64/Node 22.14),
    //    and 0.5–2.3 s cold in this machine's own startup log. 5 min (down from
    //    10) reclaims an abandoned tab within a coffee break without making an
    //    every-few-minutes revisit pay for it.
    //  - A TELEMETRY cluster is opened by an OTLP ingest burst and then sits
    //    there, and NOTHING user-facing ever waits on one — a reopen is invisible.
    //    They are also the big ones (1.0 GB on disk for this repo's own, vs 41 MB
    //    for its project DB). 60 s, i.e. one sweep interval past idle.
    //
    // Each ~190 MB of `external` freed is measured, not assumed (see docs/128 §128.5).
    idleMs: numEnv('HOTSHEET_CLUSTER_IDLE_MS', 5 * 60 * 1000),
    telemetryIdleMs: numEnv('HOTSHEET_TELEMETRY_CLUSTER_IDLE_MS', 60 * 1000),
    minIdleMs: numEnv('HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS', 30 * 1000),
    headroomFloorBytes: numEnv('HOTSHEET_EXTERNAL_HEADROOM_BYTES', 768 * 1024 * 1024),
    // Floor the sweep interval so a 0 / tiny override can't spin the timer.
    sweepIntervalMs: Math.max(1000, numEnv('HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS', 60 * 1000)),
  };
}

/** Current `external` (WASM + other native) memory in bytes. */
export function currentExternalBytes(): number {
  return process.memoryUsage().external;
}

/** V8's hard heap ceiling in bytes (the OOM boundary). */
export function heapSizeLimitBytes(): number {
  return v8.getHeapStatistics().heap_size_limit;
}

/**
 * How many clusters the headroom guard should try to evict before opening a new
 * one, or 0 if there's comfortable headroom. `external` is measured against the
 * heap ceiling; the deficit below `headroomFloorBytes` is divided by the approx
 * per-cluster cost to get a count. Pure over its inputs so it's unit-testable
 * without real memory pressure.
 */
export function headroomEvictionCount(
  externalBytes: number,
  heapLimitBytes: number,
  headroomFloorBytes: number,
): number {
  const headroom = heapLimitBytes - externalBytes;
  if (headroom >= headroomFloorBytes) return 0;
  const deficit = headroomFloorBytes - headroom;
  return Math.max(1, Math.ceil(deficit / APPROX_CLUSTER_EXTERNAL_BYTES));
}

// --- Headroom circuit breaker (HS-9480, docs/128 §128.5.8) ---

/**
 * The headroom guard has no idea whether it is working, and in the 2026-07-29
 * death spiral that made it the accelerant rather than the brake: **375 headroom
 * evictions and 372 churned reopens in ~130 seconds while `external` ROSE**
 * (4237 → 5845 MB, peaking at 8449 MB). Closing returned nothing (HS-9479 — no
 * collection ran), so the guard still saw high `external`, while the work that
 * needed a cluster reopened one and allocated a fresh ~180 MB heap. Every cycle
 * net ADDED memory:
 *
 *     high external -> evict (frees nothing) -> reopen (+180 MB) -> higher external -> evict harder
 *
 * HS-9479 fixed the cause. This is the guard against the assumption breaking
 * again, and it is worth having on its own terms: a control loop that cannot
 * tell success from failure will eventually run away. When consecutive passes
 * demonstrably fail to reduce `external`, stop pressure-evicting for a while —
 * an un-evicted warm cluster costs the same memory as an evicted-then-reopened
 * one, minus the reopen.
 *
 * The HS-9468 `pendingReclaim` credit was designed for this and was live at the
 * time; it didn't help because it assumes the memory comes back within 15 s.
 * Here it never came back at all, so the credit only delayed the loop by a
 * window. This breaker keys off the *measured* outcome instead of an assumption
 * about timing.
 */
export interface HeadroomBreakerState {
  /** Consecutive measured passes that failed to reduce `external`. */
  ineffective: number;
  /** Epoch ms until which pressure eviction is suppressed; 0 when armed. */
  suppressedUntil: number;
}

export function initialHeadroomBreakerState(): HeadroomBreakerState {
  return { ineffective: 0, suppressedUntil: 0 };
}

/** Consecutive ineffective passes before the breaker trips. */
export const HEADROOM_BREAKER_TRIP_COUNT = 3;
/** How long pressure eviction stays suppressed once tripped. */
export const HEADROOM_BREAKER_BACKOFF_MS = 5 * 60_000;
/**
 * A pass counts as effective if it freed at least this share of what the
 * clusters it closed should have been worth. Deliberately forgiving (a quarter):
 * concurrent work allocates during a pass, and the point is to catch "memory
 * went UP", not to grade the collector. The consecutive-pass requirement covers
 * the rest.
 */
const EFFECTIVE_FRACTION = 0.25;

/** Is pressure eviction currently suppressed? */
export function isHeadroomSuppressed(state: HeadroomBreakerState, now: number = Date.now()): boolean {
  return state.suppressedUntil > now;
}

/**
 * Fold one MEASURED pass into the breaker state.
 *
 * Only call this for a pass whose outcome is actually interpretable: it closed
 * at least one cluster AND a collection ran. A pass whose forced GC was
 * throttled (the common case — `forceGcNow` is rate-limited to one collection
 * per 30 s because it is stop-the-world) legitimately frees nothing, and
 * counting it would trip the breaker on a perfectly healthy server.
 */
export function noteHeadroomPass(
  state: HeadroomBreakerState,
  input: { evicted: number; externalBefore: number; externalAfter: number },
  now: number = Date.now(),
): HeadroomBreakerState {
  const expected = input.evicted * APPROX_CLUSTER_EXTERNAL_BYTES * EFFECTIVE_FRACTION;
  const freed = input.externalBefore - input.externalAfter;
  if (freed >= expected) {
    // Working. Reset completely — this also re-arms after a back-off probe.
    return { ineffective: 0, suppressedUntil: 0 };
  }
  const ineffective = state.ineffective + 1;
  if (ineffective < HEADROOM_BREAKER_TRIP_COUNT) return { ineffective, suppressedUntil: state.suppressedUntil };
  return { ineffective, suppressedUntil: now + HEADROOM_BREAKER_BACKOFF_MS };
}
