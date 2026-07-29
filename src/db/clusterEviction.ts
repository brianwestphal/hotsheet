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
  /** `cap`: steady-state ceiling on open clusters. */
  maxOpen: number;
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
    const overBy = input.clusters.length - input.maxOpen;
    if (overBy <= 0) return [];
    // Only evict clusters aged past the recency guard, so a burst that opened
    // many clusters at once doesn't immediately churn-evict a just-touched one.
    const aged = byLru.filter((c) => input.now - c.lastAccess >= input.minIdleMs);
    return aged.slice(0, overBy).map((c) => c.dbPath);
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

/** Record that a cluster was just opened or served from cache. */
export function noteClusterAccess(dbPath: string, now: number = Date.now()): void {
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
}

/** ~WASM heap per open PGLite cluster, from the HS-9420 live measurement
 *  (3.2 GB / 18 clusters ≈ 180 MB). Used only to size the headroom-guard's
 *  eviction count; an approximation is fine for a safety valve. */
export const APPROX_CLUSTER_EXTERNAL_BYTES = 180 * 1024 * 1024;

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
    maxOpen: Math.max(2, numEnv('HOTSHEET_MAX_OPEN_CLUSTERS', 10)),
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
