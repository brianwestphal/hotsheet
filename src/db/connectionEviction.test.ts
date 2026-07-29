/**
 * HS-9420 (docs/128) — the bounded cluster cache wired through connection.ts,
 * exercised against REAL PGLite clusters. The policy itself is unit-tested purely
 * in `clusterEviction.test.ts`; this file proves the integration: opening past the
 * cap evicts an LRU cluster, the idle sweep closes idle clusters, an in-flight
 * query protects its cluster, the default/pinned cluster is never evicted, and a
 * close drops the eviction bookkeeping.
 */
import { rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import {
  beginClusterQuery,
  clusterLastAccess,
  endClusterQuery,
  resetEvictionTrackingForTests,
} from './clusterEviction.js';
import {
  closeAllDatabases,
  closeDbForDir,
  evictIdleClusters,
  getDbForDir,
  isDbOpenForDir,
  pinClustersForDirs,
  setDataDir,
} from './connection.js';

const dbPathOf = (dataDir: string): string => join(dataDir, 'db');

/** Env we set to make eviction deterministic in-test, restored in afterEach. */
const ENV_KEYS = [
  'HOTSHEET_MAX_OPEN_CLUSTERS',
  'HOTSHEET_CLUSTER_IDLE_MS',
  'HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS',
  'HOTSHEET_EXTERNAL_HEADROOM_BYTES',
] as const;

describe('bounded cluster cache — connection.ts integration (HS-9420)', () => {
  let anchor: string;
  const saved: Record<string, string | undefined> = {};
  const created: string[] = [];

  const tempDir = (): string => { const d = createTempDir(); created.push(d); return d; };

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Small cap, no recency guard, and a headroom floor of 1 byte so the headroom
    // guard is effectively disabled (headroom is always ≥ 1) — we test the LRU cap
    // and idle sweep in isolation here.
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '2';
    process.env.HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS = '0';
    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = '1';

    // Anchor the default/pinned cluster to a known dir so pin behavior is
    // deterministic regardless of what a prior test left in `defaultDbPath`.
    anchor = tempDir();
    setDataDir(anchor);
    await getDbForDir(anchor);
  });

  afterEach(async () => {
    await closeAllDatabases();
    resetEvictionTrackingForTests();
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('evicts the LRU non-pinned cluster when opening past the cap', async () => {
    const p1 = tempDir();
    const p2 = tempDir();

    await getDbForDir(p1); // anchor + p1 = 2 open (at cap)
    expect(isDbOpenForDir(p1)).toBe(true);

    await getDbForDir(p2); // opening p2 → 3 open, over cap → evict LRU non-pinned (p1)

    expect(isDbOpenForDir(anchor)).toBe(true); // pinned default survives
    expect(isDbOpenForDir(p2)).toBe(true);     // just opened
    expect(isDbOpenForDir(p1)).toBe(false);    // LRU non-pinned → evicted
  });

  it('keeps the active (recently re-accessed) cluster and evicts the cold one', async () => {
    const p1 = tempDir();
    const p2 = tempDir();
    await getDbForDir(p1);
    await getDbForDir(p2); // p1 evicted here (proven above); anchor + p2 open

    // Re-open p1 (a "project switch back"): now p2 is the LRU non-pinned.
    await getDbForDir(p1); // 3 open → evict LRU non-pinned (p2)
    expect(isDbOpenForDir(p1)).toBe(true);
    expect(isDbOpenForDir(p2)).toBe(false);
    expect(isDbOpenForDir(anchor)).toBe(true);
  });

  it('idle sweep closes non-pinned idle clusters but never the pinned default', async () => {
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '0'; // everything counts as idle
    const p1 = tempDir();
    await getDbForDir(p1);
    expect(isDbOpenForDir(p1)).toBe(true);

    const closed = await evictIdleClusters();
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(isDbOpenForDir(p1)).toBe(false);     // idle non-pinned → closed
    expect(isDbOpenForDir(anchor)).toBe(true);  // pinned default → kept
  });

  it('never evicts a cluster with an in-flight query, even when idle', async () => {
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '0';
    const p1 = tempDir();
    await getDbForDir(p1);

    // Simulate an in-flight query on p1 (what the instrumentation proxy records
    // around a real query). The idle sweep must skip it.
    beginClusterQuery(dbPathOf(p1));
    try {
      const closed = await evictIdleClusters();
      expect(isDbOpenForDir(p1)).toBe(true); // protected by in-flight count
      expect(closed).toBe(0);
    } finally {
      endClusterQuery(dbPathOf(p1));
    }

    // Once the query settles, the next sweep may close it.
    await evictIdleClusters();
    expect(isDbOpenForDir(p1)).toBe(false);
  });

  it('drops eviction bookkeeping when a cluster is closed', async () => {
    const p1 = tempDir();
    await getDbForDir(p1);
    expect(clusterLastAccess(dbPathOf(p1))).toBeGreaterThan(0);

    await closeDbForDir(p1);
    expect(isDbOpenForDir(p1)).toBe(false);
    expect(clusterLastAccess(dbPathOf(p1))).toBe(0); // forgotten
  });

  it('a real query keeps its cluster warm (recency) via the instrumentation proxy', async () => {
    // Turn the recency guard back on and confirm a genuine query updates
    // lastAccess through the proxy's begin/endClusterQuery hooks.
    process.env.HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS = '60000';
    const p1 = tempDir();
    const db = await getDbForDir(p1);
    const before = clusterLastAccess(dbPathOf(p1));
    await db.query('SELECT 1');
    expect(clusterLastAccess(dbPathOf(p1))).toBeGreaterThanOrEqual(before);
  });
});

/**
 * HS-9461 — the gap the cap/idle/in-flight rules above do NOT cover: a request
 * holds its handle across MANY queries, and between them `inFlight` is 0. The
 * headroom guard deliberately ignores the recency guard under memory pressure,
 * so it can close a cluster a live request is midway through using; the next
 * query on that stale handle threw `PGlite is closed` and the app went
 * "disconnected". These walk the real transitions — evicted vs deliberately
 * closed vs shutting down — because the whole point of the fix is that only the
 * FIRST of the three may heal.
 */
describe('stale-handle healing vs deliberate close (HS-9461)', () => {
  let anchor: string;
  const saved: Record<string, string | undefined> = {};
  const created: string[] = [];
  const tempDir = (): string => { const d = createTempDir(); created.push(d); return d; };

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '2';
    process.env.HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS = '0';
    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = '1';
    anchor = tempDir();
    setDataDir(anchor);
    await getDbForDir(anchor);
  });

  afterEach(async () => {
    await closeAllDatabases();
    resetEvictionTrackingForTests();
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('a PINNED cluster is not evicted, even when opening past the cap', async () => {
    // HS-9462 — the prevention half. The in-flight guard covers ONE query; a
    // request that resolves a handle once and then writes many records is
    // unprotected between statements. With the pin held, the cluster must
    // survive the eviction pass that would otherwise pick it.
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE t (id int)');

    const release = pinClustersForDirs([p1]);
    try {
      await getDbForDir(tempDir()); // over cap → p1 is the LRU non-pinned
      expect(isDbOpenForDir(p1)).toBe(true); // pinned → survived
      await evictIdleClusters();             // and the idle sweep skips it too
      expect(isDbOpenForDir(p1)).toBe(true);
    } finally {
      release();
    }

    // Released → evictable again, so the pin is not a permanent leak.
    await getDbForDir(tempDir());
    expect(isDbOpenForDir(p1)).toBe(false);
  });

  it('releases the pin when the operation throws', async () => {
    // A pin that outlives its operation makes the cluster permanently
    // un-evictable — the unbounded-growth bug docs/128 exists to fix.
    const p1 = tempDir();
    await getDbForDir(p1);
    const release = pinClustersForDirs([p1]);
    const failingOperation = async (): Promise<void> => {
      try {
        await Promise.resolve();
        throw new Error('write failed');
      } finally { release(); }
    };
    await expect(failingOperation()).rejects.toThrow('write failed');

    await getDbForDir(tempDir());
    expect(isDbOpenForDir(p1)).toBe(false); // evictable again
  });

  it('releasing twice is a no-op (does not under-count the guard)', async () => {
    // A double release would decrement past zero and could un-protect a
    // DIFFERENT concurrent pin on the same cluster.
    const p1 = tempDir();
    await getDbForDir(p1);
    const first = pinClustersForDirs([p1]);
    const second = pinClustersForDirs([p1]); // concurrent operation on the same cluster
    first();
    first(); // duplicate — must not release `second`'s hold

    await getDbForDir(tempDir());
    expect(isDbOpenForDir(p1)).toBe(true); // still held by `second`
    second();
    await getDbForDir(tempDir());
    expect(isDbOpenForDir(p1)).toBe(false);
  });

  it('pinning a dataDir whose cluster is not open yet still protects it', async () => {
    // The pin is taken before `getDbForDir` in the OTLP writers, so it must
    // apply to a cluster that opens DURING the operation.
    const p1 = tempDir();
    const release = pinClustersForDirs([p1]);
    try {
      await getDbForDir(p1); // opens under the pin
      await getDbForDir(tempDir());
      await getDbForDir(tempDir());
      expect(isDbOpenForDir(p1)).toBe(true);
    } finally {
      release();
    }
  });

  it('a query on a handle whose cluster was EVICTED transparently heals', async () => {
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE heal_probe (id int)');
    await stale.query('INSERT INTO heal_probe VALUES (1)');

    // Evict it out from under the holder — exactly what the headroom guard did.
    await getDbForDir(tempDir()); // over cap → p1 is the LRU non-pinned
    expect(isDbOpenForDir(p1)).toBe(false);

    // The holder still has the OLD handle. Before HS-9461 this threw
    // "PGlite is closed"; now it reopens and the row is still there (the data
    // was on disk all along — only the in-process instance went away).
    const res = await stale.query<{ id: number }>('SELECT id FROM heal_probe');
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(isDbOpenForDir(p1)).toBe(true); // reopened + re-cached
  });

  it('does NOT heal a handle whose cluster was closed deliberately', async () => {
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE t (id int)');

    await closeDbForDir(p1); // deliberate — a closed project, not memory pressure
    expect(isDbOpenForDir(p1)).toBe(false);

    // Healing here would resurrect a cluster we meant to be rid of — the
    // unbounded-growth leak docs/128 exists to prevent.
    await expect(stale.query('SELECT 1')).rejects.toThrow(/PGlite is clos/);
    expect(isDbOpenForDir(p1)).toBe(false);
  });

  it('a deliberate close AFTER an eviction still does not heal', async () => {
    // The evicted-marker must not outlive the eviction: evict p1, then close it
    // deliberately (a no-op close on an already-evicted path), and the stale
    // handle must stay dead.
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE t (id int)');
    await getDbForDir(tempDir()); // evict p1
    expect(isDbOpenForDir(p1)).toBe(false);

    await closeDbForDir(p1); // clears the evicted-marker

    await expect(stale.query('SELECT 1')).rejects.toThrow(/PGlite is clos/);
    expect(isDbOpenForDir(p1)).toBe(false);
  });

  it('does not heal after closeAllDatabases (shutdown)', async () => {
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE t (id int)');
    await getDbForDir(tempDir()); // evict p1 → marker set

    await closeAllDatabases(); // shutdown clears the marker set

    await expect(stale.query('SELECT 1')).rejects.toThrow(/PGlite is clos/);
    expect(isDbOpenForDir(p1)).toBe(false);
  });

  it('keeps working for EVERY later query on the same stale handle', async () => {
    // The production shape: an OTLP ingest resolves `mainDb` ONCE and then does a
    // dozen writes. The eviction lands between two of them, so the handle is
    // stale for all the rest — not just the one that noticed. An earlier draft
    // healed the first and failed the second (the reopen consumes the
    // evicted-marker), which would have left the reported bug half fixed.
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE t (id int)');

    await getDbForDir(tempDir()); // evict p1 out from under the holder
    expect(isDbOpenForDir(p1)).toBe(false);

    for (let i = 1; i <= 5; i += 1) await stale.query('INSERT INTO t VALUES ($1)', [i]);
    const res = await stale.query<{ c: number }>('SELECT count(*)::int AS c FROM t');
    expect(res.rows[0].c).toBe(5);
  });

  it('heals repeatedly — evict, heal, evict again, heal again', async () => {
    // The marker is consumed on reopen, so a SECOND eviction has to set it
    // again. A one-shot heal would pass the first assertion and fail here.
    const p1 = tempDir();
    const stale = await getDbForDir(p1);
    await stale.exec('CREATE TABLE t (id int)');

    await getDbForDir(tempDir());                       // evict #1
    await stale.query('INSERT INTO t VALUES (1)');      // heal #1
    expect(isDbOpenForDir(p1)).toBe(true);

    await getDbForDir(tempDir());                       // evict #2
    expect(isDbOpenForDir(p1)).toBe(false);
    await stale.query('INSERT INTO t VALUES (2)');      // heal #2

    const res = await stale.query<{ c: number }>('SELECT count(*)::int AS c FROM t');
    expect(res.rows[0].c).toBe(2);
  });
});
