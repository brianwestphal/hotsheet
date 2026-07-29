// HS-9420 (docs/128) — the pure eviction policy + bookkeeping. No real clusters:
// the whole point is that the transition matrix (cap / idle / headroom ×
// pinned / in-flight / recency) is testable without opening a PGLite instance.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APPROX_CLUSTER_EXTERNAL_BYTES,
  beginClusterQuery,
  chooseEvictions,
  CHURN_WINDOW_MS,
  clusterBudget,
  clusterInFlight,
  clusterLastAccess,
  type ClusterState,
  endClusterQuery,
  type EvictionInput,
  evictionStats,
  forgetCluster,
  headroomEvictionCount,
  noteClusterAccess,
  noteEviction,
  resetEvictionStatsForTests,
  resetEvictionTrackingForTests,
  resolveEvictionConfig,
  snapshotClusters,
} from './clusterEviction.js';

const NOW = 1_000_000;

/** Build a chooseEvictions input with sane defaults, overridable per-case. */
function input(over: Partial<EvictionInput>): EvictionInput {
  return {
    clusters: [],
    pinnedPaths: new Set<string>(),
    now: NOW,
    mode: 'cap',
    budget: { project: 3, telemetry: 3 },
    minIdleMs: 30_000,
    idleMs: 600_000,
    telemetryIdleMs: 60_000,
    targetEvictions: 0,
    ...over,
  };
}

/** A cluster last accessed `ageMs` ago with `inFlight` running queries. */
function cluster(dbPath: string, ageMs: number, inFlight = 0): ClusterState {
  return { dbPath, lastAccess: NOW - ageMs, inFlight };
}

describe('chooseEvictions — cap mode (HS-9420)', () => {
  it('evicts nothing when at or under the cap', () => {
    const clusters = [cluster('a', 60_000), cluster('b', 50_000), cluster('c', 40_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 3, telemetry: 99 } }))).toEqual([]);
  });

  it('evicts the least-recently-used when over the cap', () => {
    // d is newest, a is oldest → a is the victim.
    const clusters = [cluster('a', 90_000), cluster('b', 60_000), cluster('c', 45_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 3, telemetry: 99 } }))).toEqual(['a']);
  });

  it('evicts multiple LRU when several over the cap', () => {
    const clusters = [cluster('a', 90_000), cluster('b', 80_000), cluster('c', 70_000), cluster('d', 60_000), cluster('e', 1_000)];
    // 5 open, cap 3 → evict the 2 oldest.
    expect(chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 3, telemetry: 99 } }))).toEqual(['a', 'b']);
  });

  it('never evicts a pinned cluster even if it is the LRU', () => {
    const clusters = [cluster('a', 90_000), cluster('b', 60_000), cluster('c', 45_000), cluster('d', 1_000)];
    // a is oldest but pinned → next-oldest unpinned (b) is the victim.
    const out = chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 3, telemetry: 99 }, pinnedPaths: new Set(['a']) }));
    expect(out).toEqual(['b']);
  });

  it('never evicts an in-flight cluster even if it is the LRU', () => {
    const clusters = [cluster('a', 90_000, 1), cluster('b', 60_000), cluster('c', 45_000), cluster('d', 1_000)];
    // a is oldest but has an in-flight query → b is the victim.
    expect(chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 3, telemetry: 99 } }))).toEqual(['b']);
  });

  it('respects the recency guard — a just-touched cluster is not cap-evicted', () => {
    // All three "extra" clusters are within the 30s recency guard → nothing aged
    // enough to evict, so the cap is temporarily exceeded (a burst) rather than
    // churn-evicting a hot cluster.
    const clusters = [cluster('a', 5_000), cluster('b', 4_000), cluster('c', 3_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 3, telemetry: 99 }, minIdleMs: 30_000 }))).toEqual([]);
  });

  it('evicts only aged clusters when over cap, skipping recent ones', () => {
    // a + b are aged (> guard); c + d are recent. Over by 2, but only aged ones
    // are eligible → both aged evicted.
    const clusters = [cluster('a', 90_000), cluster('b', 80_000), cluster('c', 2_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', budget: { project: 2, telemetry: 99 }, minIdleMs: 30_000 }))).toEqual(['a', 'b']);
  });
});

describe('chooseEvictions — idle mode (HS-9420)', () => {
  it('evicts every cluster idle past the threshold, regardless of count', () => {
    const clusters = [cluster('a', 700_000), cluster('b', 650_000), cluster('c', 10_000)];
    // a + b idle > 600s; c is fresh.
    expect(new Set(chooseEvictions(input({ clusters, mode: 'idle', idleMs: 600_000 })))).toEqual(new Set(['a', 'b']));
  });

  it('skips pinned and in-flight clusters in idle mode', () => {
    const clusters = [cluster('a', 700_000), cluster('b', 700_000, 1), cluster('c', 700_000)];
    const out = chooseEvictions(input({ clusters, mode: 'idle', idleMs: 600_000, pinnedPaths: new Set(['c']) }));
    // a evictable; b in-flight; c pinned.
    expect(out).toEqual(['a']);
  });

  it('evicts nothing when all clusters are fresh', () => {
    const clusters = [cluster('a', 10_000), cluster('b', 5_000)];
    expect(chooseEvictions(input({ clusters, mode: 'idle', idleMs: 600_000 }))).toEqual([]);
  });
});

/**
 * HS-9467 — the idle window is per cluster TYPE. A telemetry cluster is opened by
 * an ingest burst and then sits there with nothing user-facing waiting on it (a
 * reopen is invisible), and it is the big one on disk; a project cluster backs tab
 * switches, where a reopen is a hitch the user sees. Same age, different verdict.
 */
describe('chooseEvictions — per-type idle windows (HS-9467)', () => {
  const projectDb = (name: string) => `/data/${name}/db`;
  const telemetryDb = (name: string) => `/data/${name}/telemetry/db`;

  it('evicts a telemetry cluster that a project cluster of the SAME age keeps', () => {
    // 90 s idle: past the 60 s telemetry window, well inside the 5 min project one.
    const clusters = [
      cluster(projectDb('p'), 90_000),
      cluster(telemetryDb('p'), 90_000),
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'idle', idleMs: 300_000, telemetryIdleMs: 60_000,
    }));
    expect(out).toEqual([telemetryDb('p')]);
  });

  it('still evicts a project cluster once it passes its own longer window', () => {
    const clusters = [
      cluster(projectDb('p'), 400_000),
      cluster(telemetryDb('p'), 400_000),
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'idle', idleMs: 300_000, telemetryIdleMs: 60_000,
    }));
    expect(new Set(out)).toEqual(new Set([projectDb('p'), telemetryDb('p')]));
  });

  it('keeps a telemetry cluster that is still inside its short window', () => {
    const clusters = [cluster(telemetryDb('p'), 30_000)];
    expect(chooseEvictions(input({
      clusters, mode: 'idle', idleMs: 300_000, telemetryIdleMs: 60_000,
    }))).toEqual([]);
  });

  it('holds the hard invariants for telemetry clusters too', () => {
    // The shorter window must not become a back door around pinned / in-flight.
    const clusters = [
      cluster(telemetryDb('a'), 900_000, 1),   // in-flight
      cluster(telemetryDb('b'), 900_000),      // pinned
      cluster(telemetryDb('c'), 900_000),      // evictable
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'idle', idleMs: 300_000, telemetryIdleMs: 60_000,
      pinnedPaths: new Set([telemetryDb('b')]),
    }));
    expect(out).toEqual([telemetryDb('c')]);
  });

  it('headroom stays type-blind — it is pure memory triage', () => {
    // Cap mode became type-aware in HS-9468 (separate budgets, see below), but
    // headroom did NOT: when memory is critical the only question is which
    // cluster was touched least recently, whatever kind it is.
    const clusters = [
      cluster(projectDb('old'), 900_000),
      cluster(telemetryDb('new'), 100_000),
    ];
    const headOut = chooseEvictions(input({
      clusters, mode: 'headroom', targetEvictions: 1,
      idleMs: 300_000, telemetryIdleMs: 60_000,
    }));
    expect(headOut).toEqual([projectDb('old')]);
  });

  it('classifies by path: only a `…/telemetry/db` dir gets the short window', () => {
    // A project literally named "telemetry" must NOT be mistaken for one — its
    // cluster is `/data/telemetry/db`, whose parent dir IS named telemetry.
    // This is the known sharp edge of path-based classification; assert the
    // actual behavior so a future change to the rule shows up here.
    expect(chooseEvictions(input({
      clusters: [cluster('/data/telemetry/db', 90_000)],
      mode: 'idle', idleMs: 300_000, telemetryIdleMs: 60_000,
    }))).toEqual(['/data/telemetry/db']);
    // A normal project is unaffected.
    expect(chooseEvictions(input({
      clusters: [cluster('/data/telemetry-tools/db', 90_000)],
      mode: 'idle', idleMs: 300_000, telemetryIdleMs: 60_000,
    }))).toEqual([]);
  });
});

describe('chooseEvictions — headroom mode (HS-9420)', () => {
  it('evicts up to targetEvictions LRU clusters, ignoring the recency guard', () => {
    // All recent (would be safe from cap eviction), but memory pressure forces
    // evicting the 2 LRU anyway.
    const clusters = [cluster('a', 5_000), cluster('b', 4_000), cluster('c', 3_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'headroom', targetEvictions: 2 }))).toEqual(['a', 'b']);
  });

  it('still never evicts pinned or in-flight clusters under memory pressure', () => {
    const clusters = [cluster('a', 5_000, 1), cluster('b', 4_000), cluster('c', 3_000)];
    const out = chooseEvictions(input({ clusters, mode: 'headroom', targetEvictions: 3, pinnedPaths: new Set(['c']) }));
    // a in-flight (protected), c pinned → only b is eligible.
    expect(out).toEqual(['b']);
  });

  it('evicts nothing when targetEvictions is 0', () => {
    const clusters = [cluster('a', 5_000), cluster('b', 4_000)];
    expect(chooseEvictions(input({ clusters, mode: 'headroom', targetEvictions: 0 }))).toEqual([]);
  });
});

describe('headroomEvictionCount (HS-9420)', () => {
  const FLOOR = 768 * 1024 * 1024;
  const LIMIT = 4_144 * 1024 * 1024;

  it('returns 0 when headroom is comfortable', () => {
    const external = LIMIT - FLOOR - 1; // headroom just above the floor
    expect(headroomEvictionCount(external, LIMIT, FLOOR)).toBe(0);
  });

  it('returns at least 1 once headroom dips below the floor', () => {
    const external = LIMIT - FLOOR + 1; // headroom just below the floor
    expect(headroomEvictionCount(external, LIMIT, FLOOR)).toBe(1);
  });

  it('scales the count with the deficit (≈180 MB per cluster)', () => {
    // Deficit of ~3 clusters' worth below the floor → evict 3.
    const external = LIMIT - FLOOR + 3 * APPROX_CLUSTER_EXTERNAL_BYTES;
    expect(headroomEvictionCount(external, LIMIT, FLOOR)).toBe(3);
  });
});

describe('bookkeeping + snapshotClusters (HS-9420)', () => {
  afterEach(() => resetEvictionTrackingForTests());

  it('tracks last access and in-flight counts', () => {
    noteClusterAccess('x', 100);
    expect(clusterLastAccess('x')).toBe(100);
    expect(clusterInFlight('x')).toBe(0);

    beginClusterQuery('x', 200);
    beginClusterQuery('x', 210);
    expect(clusterInFlight('x')).toBe(2);
    expect(clusterLastAccess('x')).toBe(210);

    endClusterQuery('x', 300);
    expect(clusterInFlight('x')).toBe(1);
    endClusterQuery('x', 400);
    expect(clusterInFlight('x')).toBe(0);
    expect(clusterLastAccess('x')).toBe(400);
  });

  it('never lets in-flight go negative on an unbalanced end', () => {
    endClusterQuery('y', 100); // end with no begin
    expect(clusterInFlight('y')).toBe(0);
  });

  it('forgetCluster drops all bookkeeping', () => {
    noteClusterAccess('z', 100);
    beginClusterQuery('z', 200);
    forgetCluster('z');
    expect(clusterLastAccess('z')).toBe(0);
    expect(clusterInFlight('z')).toBe(0);
  });

  it('snapshotClusters reflects live access/in-flight and defaults unseen paths to now', () => {
    noteClusterAccess('a', 500);
    beginClusterQuery('b', 600);
    const snap = snapshotClusters(['a', 'b', 'unseen'], 999);
    expect(snap).toContainEqual({ dbPath: 'a', lastAccess: 500, inFlight: 0 });
    expect(snap).toContainEqual({ dbPath: 'b', lastAccess: 600, inFlight: 1 });
    // An open path with no recorded access is treated as accessed `now`, so it
    // can't be spuriously evicted before its first real use.
    expect(snap).toContainEqual({ dbPath: 'unseen', lastAccess: 999, inFlight: 0 });
  });
});

describe('resolveEvictionConfig (HS-9420)', () => {
  const KEYS = [
    'HOTSHEET_MAX_OPEN_CLUSTERS',
    'HOTSHEET_CLUSTER_IDLE_MS',
    'HOTSHEET_TELEMETRY_CLUSTER_IDLE_MS',
    'HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS',
    'HOTSHEET_EXTERNAL_HEADROOM_BYTES',
    'HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS',
  ];
  afterEach(() => { for (const k of KEYS) Reflect.deleteProperty(process.env, k); });

  it('uses production defaults when no env is set', () => {
    const cfg = resolveEvictionConfig();
    expect(cfg.maxOpen).toBe(10);
    // HS-9467 — project clusters 5 min (was 10), telemetry 60 s. A reopen costs
    // 60–240 ms warm; nothing user-facing waits on a telemetry reopen at all.
    expect(cfg.idleMs).toBe(300_000);
    expect(cfg.telemetryIdleMs).toBe(60_000);
    expect(cfg.minIdleMs).toBe(30_000);
    expect(cfg.headroomFloorBytes).toBe(768 * 1024 * 1024);
    expect(cfg.sweepIntervalMs).toBe(60_000);
  });

  it('honors env overrides', () => {
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '4';
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '120000';
    process.env.HOTSHEET_TELEMETRY_CLUSTER_IDLE_MS = '15000';
    expect(resolveEvictionConfig().maxOpen).toBe(4);
    expect(resolveEvictionConfig().idleMs).toBe(120_000);
    expect(resolveEvictionConfig().telemetryIdleMs).toBe(15_000);
  });

  it('clamps maxOpen to a floor of 2 and ignores invalid/negative values', () => {
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '1';
    expect(resolveEvictionConfig().maxOpen).toBe(2);
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = 'not-a-number';
    expect(resolveEvictionConfig().maxOpen).toBe(10); // falls back to default
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '-5';
    expect(resolveEvictionConfig().idleMs).toBe(300_000); // negative → default
  });
});

/**
 * HS-9468 — the budget is derived from LIVE memory pressure instead of a fixed
 * count, with separate allowances for project and telemetry clusters. Encodes two
 * maintainer decisions: separate LRUs, and telemetry gives way first (a stats page
 * paying a reopen is cheap; a tab switch paying one is not).
 */
describe('clusterBudget (HS-9468)', () => {
  const GB = 1024 * 1024 * 1024;
  const base = {
    heapLimitBytes: 4 * GB,
    headroomFloorBytes: 768 * 1024 * 1024,
    pendingReclaimBytes: 0,
    openProject: 2,
    openTelemetry: 2,
    maxProject: 10,
    maxTelemetry: 6,
    minProject: 2,
    minTelemetry: 1,
    systemPressure: 'normal' as const,
  };

  it('allows the full ceilings when memory is plentiful', () => {
    // Almost nothing allocated → room for everything.
    expect(clusterBudget({ ...base, externalBytes: 100 * 1024 * 1024 }))
      .toEqual({ project: 10, telemetry: 6 });
  });

  it('shrinks as pressure rises', () => {
    const plenty = clusterBudget({ ...base, externalBytes: 0.5 * GB });
    const tight = clusterBudget({ ...base, externalBytes: 3 * GB });
    const total = (b: { project: number; telemetry: number }) => b.project + b.telemetry;
    expect(total(tight)).toBeLessThan(total(plenty));
  });

  it('takes it out of TELEMETRY first', () => {
    // Enough pressure to force a shrink, but not down to the floors: the
    // telemetry allowance should absorb it while projects stay at their ceiling.
    const b = clusterBudget({ ...base, externalBytes: 3 * GB, openProject: 6, openTelemetry: 6 });
    expect(b.telemetry).toBeLessThan(base.maxTelemetry);
    expect(b.project).toBeGreaterThan(b.telemetry);
  });

  it('never drops below the floors, however critical memory is', () => {
    // The active project must survive, and one telemetry cluster stays so an
    // ingest burst isn't reopening on every batch.
    const b = clusterBudget({ ...base, externalBytes: 100 * GB });
    expect(b.project).toBe(base.minProject);
    expect(b.telemetry).toBe(base.minTelemetry);
  });

  it('never exceeds the ceilings, however much room there is', () => {
    const b = clusterBudget({ ...base, heapLimitBytes: 1024 * GB, externalBytes: 0 });
    expect(b).toEqual({ project: 10, telemetry: 6 });
  });

  it('credits pending reclaim so eviction cannot cascade', () => {
    // THE subtle one. A closed cluster's heap returns on GC, not at close(), so
    // `external` still counts it. Without the credit the budget reads the same
    // pressure that just triggered an eviction and evicts again — a cascade
    // caused by its own success. With 4 evictions in flight the budget must be
    // no tighter than if that memory were already back.
    const externalBytes = 3.2 * GB;
    const naive = clusterBudget({ ...base, externalBytes, pendingReclaimBytes: 0 });
    const credited = clusterBudget({
      ...base, externalBytes, pendingReclaimBytes: 4 * APPROX_CLUSTER_EXTERNAL_BYTES,
    });
    const total = (b: { project: number; telemetry: number }) => b.project + b.telemetry;
    expect(total(credited)).toBeGreaterThan(total(naive));
  });

  it('grows from the CURRENT open count, so the loop converges', () => {
    // The budget is `open + spare`: with headroom it sits above what is open (so
    // nothing is evicted and more may open), and each open raises `external`,
    // lowering `spare`. That feedback is what makes it self-regulating rather
    // than oscillating.
    const b = clusterBudget({ ...base, externalBytes: 2 * GB, openProject: 3, openTelemetry: 3 });
    expect(b.project + b.telemetry).toBeGreaterThanOrEqual(6);
  });

  it('handles a negative headroom without producing nonsense', () => {
    const b = clusterBudget({ ...base, externalBytes: 5 * GB });
    expect(Number.isFinite(b.project)).toBe(true);
    expect(b.project).toBeGreaterThanOrEqual(base.minProject);
    expect(b.telemetry).toBeGreaterThanOrEqual(base.minTelemetry);
  });

  it('MACHINE pressure caps what process headroom would allow (HS-9469)', () => {
    // The two signals are independent: process headroom can look roomy while the
    // machine is swapping. Taking the more conservative is the whole point.
    const roomy = { ...base, externalBytes: 100 * 1024 * 1024 };
    const normal = clusterBudget({ ...roomy, systemPressure: 'normal' });
    const warn = clusterBudget({ ...roomy, systemPressure: 'warn' });
    const critical = clusterBudget({ ...roomy, systemPressure: 'critical' });
    const total = (b: { project: number; telemetry: number }) => b.project + b.telemetry;

    expect(total(normal)).toBe(16);
    expect(total(warn)).toBeLessThan(total(normal));
    // Critical means the machine is stalling; holding cache is actively harmful.
    expect(critical).toEqual({ project: base.minProject, telemetry: base.minTelemetry });
  });

  it('machine pressure never LICENSES growth beyond process headroom', () => {
    // `normal` must not loosen a budget the process-level term already tightened —
    // it only ever caps.
    const tight = { ...base, externalBytes: 100 * (1024 ** 3) };
    expect(clusterBudget({ ...tight, systemPressure: 'normal' }))
      .toEqual(clusterBudget({ ...tight, systemPressure: 'critical' }));
  });

  it('the floors survive every pressure level', () => {
    for (const systemPressure of ['normal', 'warn', 'critical'] as const) {
      const b = clusterBudget({ ...base, externalBytes: 100 * (1024 ** 3), systemPressure });
      expect(b.project).toBeGreaterThanOrEqual(base.minProject);
      expect(b.telemetry).toBeGreaterThanOrEqual(base.minTelemetry);
    }
  });

  it('cannot be pushed below its floors by an absurd pending credit', () => {
    const b = clusterBudget({ ...base, externalBytes: 0, pendingReclaimBytes: 100 * GB });
    expect(b.project).toBeLessThanOrEqual(base.maxProject);
    expect(b.telemetry).toBeLessThanOrEqual(base.maxTelemetry);
  });
});

describe('chooseEvictions — separate per-type LRUs (HS-9468)', () => {
  const projectDb = (n: string) => `/data/${n}/db`;
  const telemetryDb = (n: string) => `/data/${n}/telemetry/db`;

  it('a telemetry burst does not evict the project the user is looking at', () => {
    // The reason for separate budgets: under one combined cap, 4 telemetry opens
    // would push the total over and evict the oldest cluster — which could be a
    // project. Now the telemetry overage is settled among telemetry clusters.
    const clusters = [
      cluster(projectDb('active'), 900_000),
      cluster(telemetryDb('t1'), 800_000),
      cluster(telemetryDb('t2'), 700_000),
      cluster(telemetryDb('t3'), 600_000),
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'cap', budget: { project: 5, telemetry: 2 }, minIdleMs: 0,
    }));
    // Exactly one telemetry cluster over budget → the LRU telemetry one goes.
    expect(out).toEqual([telemetryDb('t1')]);
    expect(out).not.toContain(projectDb('active'));
  });

  it('evicts within each type independently when both are over', () => {
    const clusters = [
      cluster(projectDb('p1'), 900_000),
      cluster(projectDb('p2'), 800_000),
      cluster(telemetryDb('t1'), 700_000),
      cluster(telemetryDb('t2'), 600_000),
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'cap', budget: { project: 1, telemetry: 1 }, minIdleMs: 0,
    }));
    // Telemetry first (cheaper reopen), then the project one; LRU within each.
    expect(out).toEqual([telemetryDb('t1'), projectDb('p1')]);
  });

  it('leaves a type alone when only the OTHER is over budget', () => {
    const clusters = [
      cluster(projectDb('p1'), 900_000),
      cluster(telemetryDb('t1'), 800_000),
      cluster(telemetryDb('t2'), 700_000),
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'cap', budget: { project: 5, telemetry: 1 }, minIdleMs: 0,
    }));
    expect(out).toEqual([telemetryDb('t1')]);
  });

  it('keeps the hard invariants per type', () => {
    const clusters = [
      cluster(telemetryDb('t1'), 900_000, 1),  // in-flight (a write in progress)
      cluster(telemetryDb('t2'), 800_000),     // pinned
      cluster(telemetryDb('t3'), 700_000),     // evictable
    ];
    const out = chooseEvictions(input({
      clusters, mode: 'cap', budget: { project: 5, telemetry: 1 }, minIdleMs: 0,
      pinnedPaths: new Set([telemetryDb('t2')]),
    }));
    expect(out).toEqual([telemetryDb('t3')]);
  });
});

/**
 * HS-9470 — the counters that let the HS-9468 budget be judged on a real machine.
 * Counts, not bytes: attributing freed memory around an eviction is meaningless
 * without forcing a GC (docs/128 §128.5.1), and that trap has already produced one
 * wrong conclusion in this area.
 */
describe('eviction counters (HS-9470)', () => {
  const projectDb = (n: string) => `/data/${n}/db`;
  const telemetryDb = (n: string) => `/data/${n}/telemetry/db`;

  beforeEach(() => { resetEvictionStatsForTests(); resetEvictionTrackingForTests(); });
  afterEach(() => { resetEvictionStatsForTests(); resetEvictionTrackingForTests(); });

  it('starts at zero', () => {
    expect(evictionStats()).toEqual({
      byMode: { cap: 0, idle: 0, headroom: 0 }, project: 0, telemetry: 0, churn: 0,
    });
  });

  it('counts by mode — the question "which layer actually binds"', () => {
    noteEviction(projectDb('a'), 'cap', NOW);
    noteEviction(projectDb('b'), 'idle', NOW);
    noteEviction(projectDb('c'), 'idle', NOW);
    noteEviction(projectDb('d'), 'headroom', NOW);
    expect(evictionStats().byMode).toEqual({ cap: 1, idle: 2, headroom: 1 });
  });

  it('counts by type — does "telemetry gives way first" hold in practice', () => {
    noteEviction(telemetryDb('t1'), 'cap', NOW);
    noteEviction(telemetryDb('t2'), 'cap', NOW);
    noteEviction(projectDb('p1'), 'cap', NOW);
    const s = evictionStats();
    expect(s.telemetry).toBe(2);
    expect(s.project).toBe(1);
  });

  it('counts churn — evicted, then reopened moments later', () => {
    // The cost the user actually feels: we paid a close and a reopen for nothing.
    noteEviction(projectDb('a'), 'cap', NOW);
    noteClusterAccess(projectDb('a'), NOW + 5_000);
    expect(evictionStats().churn).toBe(1);
  });

  it('does NOT count a reopen long after the eviction', () => {
    // Coming back to a project half an hour later is the cache working, not churn.
    noteEviction(projectDb('a'), 'cap', NOW);
    noteClusterAccess(projectDb('a'), NOW + CHURN_WINDOW_MS + 1);
    expect(evictionStats().churn).toBe(0);
  });

  it('counts churn only once per eviction', () => {
    // A reopened cluster is accessed constantly afterwards; each of those must not
    // re-count the single eviction that preceded them.
    noteEviction(projectDb('a'), 'cap', NOW);
    noteClusterAccess(projectDb('a'), NOW + 1_000);
    noteClusterAccess(projectDb('a'), NOW + 2_000);
    noteClusterAccess(projectDb('a'), NOW + 3_000);
    expect(evictionStats().churn).toBe(1);
  });

  it('counts churn again if the same cluster is evicted a second time', () => {
    // Repeated evict→reopen on ONE cluster is the strongest "too tight" signal
    // there is, so it must accumulate rather than saturate at 1.
    noteEviction(projectDb('a'), 'cap', NOW);
    noteClusterAccess(projectDb('a'), NOW + 1_000);
    noteEviction(projectDb('a'), 'cap', NOW + 2_000);
    noteClusterAccess(projectDb('a'), NOW + 3_000);
    expect(evictionStats().churn).toBe(2);
  });

  it('does not count an access to a cluster that was never evicted', () => {
    noteClusterAccess(projectDb('fresh'), NOW);
    expect(evictionStats().churn).toBe(0);
  });

  it('prunes evicted paths past the churn window instead of growing forever', () => {
    // The map is bounded by pruning on write — a cluster evicted and never
    // reopened must not sit in it for the life of the process.
    noteEviction(projectDb('never-reopened'), 'idle', NOW);
    noteEviction(projectDb('later'), 'idle', NOW + CHURN_WINDOW_MS + 1);
    // The first is now aged out, so a (very) late reopen is not counted as churn.
    noteClusterAccess(projectDb('never-reopened'), NOW + CHURN_WINDOW_MS + 2);
    expect(evictionStats().churn).toBe(0);
  });

  it('returns a copy, so a caller cannot mutate the live counters', () => {
    noteEviction(projectDb('a'), 'cap', NOW);
    const snapshot = evictionStats();
    snapshot.byMode.cap = 999;
    snapshot.project = 999;
    expect(evictionStats().byMode.cap).toBe(1);
    expect(evictionStats().project).toBe(1);
  });
});
