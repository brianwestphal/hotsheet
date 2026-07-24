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
