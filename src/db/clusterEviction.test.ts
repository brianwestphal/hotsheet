// HS-9420 (docs/128) — the pure eviction policy + bookkeeping. No real clusters:
// the whole point is that the transition matrix (cap / idle / headroom ×
// pinned / in-flight / recency) is testable without opening a PGLite instance.
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROX_CLUSTER_EXTERNAL_BYTES,
  beginClusterQuery,
  chooseEvictions,
  clusterInFlight,
  clusterLastAccess,
  type ClusterState,
  endClusterQuery,
  type EvictionInput,
  forgetCluster,
  headroomEvictionCount,
  noteClusterAccess,
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
    maxOpen: 3,
    minIdleMs: 30_000,
    idleMs: 600_000,
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
    expect(chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 3 }))).toEqual([]);
  });

  it('evicts the least-recently-used when over the cap', () => {
    // d is newest, a is oldest → a is the victim.
    const clusters = [cluster('a', 90_000), cluster('b', 60_000), cluster('c', 45_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 3 }))).toEqual(['a']);
  });

  it('evicts multiple LRU when several over the cap', () => {
    const clusters = [cluster('a', 90_000), cluster('b', 80_000), cluster('c', 70_000), cluster('d', 60_000), cluster('e', 1_000)];
    // 5 open, cap 3 → evict the 2 oldest.
    expect(chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 3 }))).toEqual(['a', 'b']);
  });

  it('never evicts a pinned cluster even if it is the LRU', () => {
    const clusters = [cluster('a', 90_000), cluster('b', 60_000), cluster('c', 45_000), cluster('d', 1_000)];
    // a is oldest but pinned → next-oldest unpinned (b) is the victim.
    const out = chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 3, pinnedPaths: new Set(['a']) }));
    expect(out).toEqual(['b']);
  });

  it('never evicts an in-flight cluster even if it is the LRU', () => {
    const clusters = [cluster('a', 90_000, 1), cluster('b', 60_000), cluster('c', 45_000), cluster('d', 1_000)];
    // a is oldest but has an in-flight query → b is the victim.
    expect(chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 3 }))).toEqual(['b']);
  });

  it('respects the recency guard — a just-touched cluster is not cap-evicted', () => {
    // All three "extra" clusters are within the 30s recency guard → nothing aged
    // enough to evict, so the cap is temporarily exceeded (a burst) rather than
    // churn-evicting a hot cluster.
    const clusters = [cluster('a', 5_000), cluster('b', 4_000), cluster('c', 3_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 3, minIdleMs: 30_000 }))).toEqual([]);
  });

  it('evicts only aged clusters when over cap, skipping recent ones', () => {
    // a + b are aged (> guard); c + d are recent. Over by 2, but only aged ones
    // are eligible → both aged evicted.
    const clusters = [cluster('a', 90_000), cluster('b', 80_000), cluster('c', 2_000), cluster('d', 1_000)];
    expect(chooseEvictions(input({ clusters, mode: 'cap', maxOpen: 2, minIdleMs: 30_000 }))).toEqual(['a', 'b']);
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
    'HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS',
    'HOTSHEET_EXTERNAL_HEADROOM_BYTES',
    'HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS',
  ];
  afterEach(() => { for (const k of KEYS) Reflect.deleteProperty(process.env, k); });

  it('uses production defaults when no env is set', () => {
    const cfg = resolveEvictionConfig();
    expect(cfg.maxOpen).toBe(10);
    expect(cfg.idleMs).toBe(600_000);
    expect(cfg.minIdleMs).toBe(30_000);
    expect(cfg.headroomFloorBytes).toBe(768 * 1024 * 1024);
    expect(cfg.sweepIntervalMs).toBe(60_000);
  });

  it('honors env overrides', () => {
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '4';
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '120000';
    expect(resolveEvictionConfig().maxOpen).toBe(4);
    expect(resolveEvictionConfig().idleMs).toBe(120_000);
  });

  it('clamps maxOpen to a floor of 2 and ignores invalid/negative values', () => {
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '1';
    expect(resolveEvictionConfig().maxOpen).toBe(2);
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = 'not-a-number';
    expect(resolveEvictionConfig().maxOpen).toBe(10); // falls back to default
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '-5';
    expect(resolveEvictionConfig().idleMs).toBe(600_000); // negative → default
  });
});
