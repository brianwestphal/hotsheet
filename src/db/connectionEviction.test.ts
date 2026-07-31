/**
 * HS-9420 (docs/128) — the bounded cluster cache wired through connection.ts,
 * exercised against REAL PGLite clusters. The policy itself is unit-tested purely
 * in `clusterEviction.test.ts`; this file proves the integration: opening past the
 * cap evicts an LRU cluster, the idle sweep closes idle clusters, an in-flight
 * query protects its cluster, the default/pinned cluster is never evicted, and a
 * close drops the eviction bookkeeping.
 *
 * HS-9504 — this file scopes its own timeouts. Proving eviction integration means
 * opening and closing REAL embedded-Postgres clusters over and over: ~56 cluster
 * operations, against 5–14 for every other `src/db` suite. It is an order of magnitude
 * heavier than its neighbors, and that shows up as ~69 s in isolation and intermittent
 * 30 s timeouts under a full parallel run — the CPU-starvation stretch
 * `vitest.config.ts` documents. The failures rotated between files run to run, which is
 * the signature of contention rather than of any assertion being wrong.
 *
 * Raising the GLOBAL budget was rejected: 30 s is deliberate, and a suite-wide raise
 * would mask a real hang somewhere quiet. Same reasoning as `snapshotRestore.test.ts`
 * and `backup.test.ts`, which scope their own for the same reason.
 */
import { execFileSync } from 'child_process';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import {
  beginClusterQuery,
  clusterLastAccess,
  endClusterQuery,
  evictionStats,
  resetEvictionStatsForTests,
  resetEvictionTrackingForTests,
} from './clusterEviction.js';
import {
  closeAllDatabases,
  closeDbForDir,
  evictForHeadroomForTests,
  evictIdleClusters,
  getDbForDir,
  isDbOpenForDir,
  pinClustersForDirs,
  setDataDir,
  startClusterEvictionTimer,
  stopClusterEvictionTimer,
} from './connection.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const dbPathOf = (dataDir: string): string => join(dataDir, 'db');

/** Env we set to make eviction deterministic in-test, restored in afterEach. */
const ENV_KEYS = [
  'HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS',
  'HOTSHEET_MAX_OPEN_CLUSTERS',
  'HOTSHEET_CLUSTER_IDLE_MS',
  'HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS',
  'HOTSHEET_EXTERNAL_HEADROOM_BYTES',
  // The memory-reclamation tests disable the forced-GC throttle; restore it so a
  // later test in this file doesn't inherit an un-throttled collector.
  'HOTSHEET_FORCED_GC_MIN_INTERVAL_MS',
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

  it('every pin in src/ is released in a finally (leaked-pin guard)', () => {
    // A pin that outlives its operation makes its cluster permanently
    // un-evictable — the unbounded-growth bug docs/128 exists to fix. The
    // failure is SILENT: eviction just stops working for that cluster and
    // memory creeps back up, which is exactly how the original OOM went
    // undiagnosed. So every `pinClustersForDirs` call must have a matching
    // release, and it must be inside a `finally`.
    const files = execFileSync('git', ['ls-files', 'src'], { timeout: 60_000, killSignal: 'SIGKILL', encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const pins = src.split('pinClustersForDirs(').length - 1;
      if (pins === 0) continue;
      // `connection.ts` DEFINES the primitive; its own occurrence isn't a call site.
      const calls = file.endsWith('db/connection.ts') ? pins - 1 : pins;
      if (calls === 0) continue;
      const releases = src.split('release();').length - 1;
      if (releases !== calls) offenders.push(`${file}: ${String(calls)} pin(s), ${String(releases)} release(s)`);
      // Each release must sit in a `finally`, not just anywhere in the file.
      const finallyReleases = (/finally \{\s*(?:\/\/[^\n]*\n\s*)*release\(\);/g.exec(src) === null)
        ? 0 : src.split(/finally \{\s*(?:\/\/[^\n]*\n\s*)*release\(\);/).length - 1;
      if (finallyReleases < calls) offenders.push(`${file}: ${String(calls)} pin(s) but only ${String(finallyReleases)} released in a finally`);
    }
    expect(offenders).toEqual([]);
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

/**
 * HS-9470 — the counters have to be wired to REAL evictions, not just unit-tested
 * in isolation. A counter that is never incremented reads exactly like a healthy
 * system, which is the worst possible failure for an observability feature.
 */
describe('eviction counters wired to real evictions (HS-9470)', () => {
  let anchor: string;
  const saved: Record<string, string | undefined> = {};
  const created: string[] = [];
  const tempDir = (): string => { const d = createTempDir(); created.push(d); return d; };

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '2';
    process.env.HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS = '0';
    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = '1';
    resetEvictionStatsForTests();
    anchor = tempDir();
    setDataDir(anchor);
    await getDbForDir(anchor);
  });

  afterEach(async () => {
    await closeAllDatabases();
    resetEvictionTrackingForTests();
    resetEvictionStatsForTests();
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('records the MODE of a real cap eviction', async () => {
    const p1 = tempDir();
    await getDbForDir(p1);
    await getDbForDir(tempDir()); // over the project budget → cap eviction
    expect(isDbOpenForDir(p1)).toBe(false);

    const s = evictionStats();
    expect(s.byMode.cap).toBeGreaterThanOrEqual(1);
    expect(s.byMode.idle).toBe(0);
    expect(s.project).toBeGreaterThanOrEqual(1);
  });

  it('records the MODE of a real idle eviction', async () => {
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '0';
    const p1 = tempDir();
    await getDbForDir(p1);
    await evictIdleClusters();

    const s = evictionStats();
    expect(s.byMode.idle).toBeGreaterThanOrEqual(1);
    expect(s.byMode.cap).toBe(0);
  });

  it('records churn when an evicted cluster is reopened straight away', async () => {
    // The signal that a budget is too tight — and the reason it is worth counting
    // separately from the eviction itself: evictions alone look like the cache
    // working, evictions followed by immediate reopens are it thrashing.
    const p1 = tempDir();
    await getDbForDir(p1);
    await getDbForDir(tempDir()); // evicts p1
    expect(isDbOpenForDir(p1)).toBe(false);
    expect(evictionStats().churn).toBe(0);

    await getDbForDir(p1); // straight back — that is churn
    expect(evictionStats().churn).toBe(1);
  });
});

/**
 * HS-9477 — "server still dying sometimes ... it needs to be MUCH more resilient
 * even if it starts running out of memory".
 *
 * The headroom guard is the only layer that responds to how much memory is
 * actually in use, and it ran ONLY on the cluster-open path. A server that was
 * bloated but not opening anything therefore had no response to pressure at all:
 * memory climbed, the loop went into GC thrash, and the docs/45 watchdog SIGKILLed
 * it for being wedged. The periodic sweep now runs it too.
 */
/**
 * HS-9540 — wait for `external` to fall back under `limit`, forcing a collection
 * each round.
 *
 * Returns as soon as it drops (so the common case costs one sample) and gives up
 * after `timeoutMs`, returning the last reading so the caller's assertion reports
 * the real number rather than a timeout.
 */
async function waitForExternalToDropBelow(before: number, limit: number, timeoutMs = 20_000): Promise<number> {
  const { forceGcNow } = await import('./forceGc.js');
  const deadline = Date.now() + timeoutMs;
  let residue = process.memoryUsage().external - before;
  while (residue >= limit && Date.now() < deadline) {
    forceGcNow('hs-9540-poll');
    await new Promise((r) => setTimeout(r, 250));
    residue = process.memoryUsage().external - before;
  }
  return residue;
}

describe('pressure-driven eviction runs off the sweep, not just on open (HS-9477)', () => {
  let anchor: string;
  const saved: Record<string, string | undefined> = {};
  const created: string[] = [];
  const tempDir = (): string => { const d = createTempDir(); created.push(d); return d; };

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HOTSHEET_MAX_OPEN_CLUSTERS = '50';   // keep the cap out of it
    process.env.HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS = '0';
    process.env.HOTSHEET_CLUSTER_IDLE_MS = '3600000'; // and the idle window out of it
    resetEvictionStatsForTests();
    anchor = tempDir();
    setDataDir(anchor);
    await getDbForDir(anchor);
  });

  afterEach(async () => {
    await closeAllDatabases();
    resetEvictionTrackingForTests();
    resetEvictionStatsForTests();
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('sheds clusters under pressure even though none are idle and the cap is not reached', async () => {
    const p1 = tempDir();
    const p2 = tempDir();
    await getDbForDir(p1);
    await getDbForDir(p2);
    expect(isDbOpenForDir(p1)).toBe(true);

    // A headroom floor larger than the heap ceiling forces the guard to see a
    // deficit — the same state a genuinely bloated process is in.
    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = String(1024 ** 4);
    await evictForHeadroomForTests();

    const stillOpen = [p1, p2].filter((d) => isDbOpenForDir(d)).length;
    expect(stillOpen, 'pressure should have shed at least one cluster').toBeLessThan(2);
    expect(evictionStats().byMode.headroom).toBeGreaterThanOrEqual(1);
  });

  it('the SWEEP TIMER runs the pressure pass — not just the function existing', async () => {
    // The bug was the WIRING, not the function: `evictForHeadroom` worked fine,
    // it was simply never called except when opening a cluster. A test that calls
    // it directly passes either way (this one was written that way first and
    // proved nothing), so this drives the real timer.
    const p1 = tempDir();
    const p2 = tempDir();
    await getDbForDir(p1);
    await getDbForDir(p2);

    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = String(1024 ** 4);
    process.env.HOTSHEET_CLUSTER_SWEEP_INTERVAL_MS = '1000'; // the floor
    startClusterEvictionTimer();
    try {
      await vi.waitFor(
        () => { expect(evictionStats().byMode.headroom).toBeGreaterThanOrEqual(1); },
        { timeout: 8000, interval: 200 },
      );
    } finally {
      stopClusterEvictionTimer();
    }
  });

  it('RECLAIMS the memory — eviction without a collection frees nothing (HS-9479)', async () => {
    // The behavior the whole memory workstream turned out to hinge on. Before
    // HS-9479 this exact sequence left `external` untouched: closing a cluster
    // drops the reference but a WASM heap creates no heap pressure, so V8 never
    // collected and the guard just evicted harder (docs/128 §128.5.4).
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '0'; // no throttle in-test
    const dirs = [tempDir(), tempDir(), tempDir()];
    for (const d of dirs) await getDbForDir(d);
    const opened = process.memoryUsage().external;

    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = String(1024 ** 4);
    await evictForHeadroomForTests();

    expect(dirs.filter((d) => isDbOpenForDir(d)).length).toBe(0);
    const after = process.memoryUsage().external;
    expect(after, `external should fall after eviction (was ${String(opened)})`).toBeLessThan(opened);
  });

  it('RECLAIMS the memory of REGISTERED projects too — nothing may retain a handle (HS-9485)', async () => {
    // The test above evicts clusters nothing is holding. This one runs the same
    // sequence through `registerProject`'s real bookkeeping, because a single
    // surviving reference silently defeats eviction AND the forced collection
    // together: the cluster is closed, gone from `databases`, and still resident.
    //
    // `ProjectContext` used to carry a `db: PGlite` assigned once at registration
    // and never reassigned. Measured before the fix — 4 projects registered, then
    // every cluster evicted and a collection forced:
    //
    //   baseline 194 MB -> registered 1193 MB -> evicted+GC 959 MB   (765 MB LEAKED)
    //
    // i.e. ~191 MB per registered project that no policy in docs/128 could ever
    // return, on a machine with 10 registered projects and a 4144 MB ceiling.
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '0';
    const { registerExistingProject, unregisterProject } = await import('../projects.js');

    const before = process.memoryUsage().external;
    const dirs = [tempDir(), tempDir(), tempDir()];
    const secrets: string[] = [];
    for (const [i, d] of dirs.entries()) {
      await getDbForDir(d);
      const secret = `hs-9485-${String(i)}`;
      secrets.push(secret);
      registerExistingProject(d, secret);
    }
    const opened = process.memoryUsage().external;
    // Guard the guard: if registration didn't actually allocate clusters, the
    // reclamation assertion below would pass vacuously.
    expect(opened - before, 'registering 3 projects should allocate real WASM heaps').toBeGreaterThan(100 * 1024 * 1024);

    try {
      process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = String(1024 ** 4);
      await evictForHeadroomForTests();
      expect(dirs.filter((d) => isDbOpenForDir(d)).length).toBe(0);

      // The projects are STILL REGISTERED — that is the whole point. Their memory
      // has to come back anyway, because a tab left open in the UI keeps its
      // project registered for as long as the process lives.
      const { getAllProjects } = await import('../projects.js');
      expect(getAllProjects().map((p) => p.secret)).toEqual(expect.arrayContaining(secrets));

      // HS-9540 — POLL rather than sampling once. The property under test is "the
      // memory comes back", not "it comes back within this tick". Reclaiming a
      // WASM heap depends on V8 running finalizers (docs/128 §128.5.6 — which is
      // also why `forceGcNow` collects TWICE), and under CPU contention that does
      // not always finish before the next statement. Sampling once made this fail
      // in a loaded full-suite run while passing in isolation, on BOTH the changed
      // and unchanged tree — a flaky memory assertion, which reads as a real leak.
      //
      // Nudging GC inside the loop is deliberate and does not weaken the test: a
      // RETAINED handle is not collectable, so no number of collections reclaims
      // it and the assertion still fails loudly. All the polling removes is the
      // timing dependence.
      const LIMIT = 100 * 1024 * 1024;
      const residue = await waitForExternalToDropBelow(before, LIMIT);
      // One cluster's heap is ~190 MB, so a retained handle per project shows up
      // here as hundreds of MB. Allow generous slack for unrelated allocations
      // while still failing loudly on even ONE pinned cluster.
      expect(residue, `evicting registered projects must reclaim their heaps (opened ${String(opened - before)} over baseline)`)
        .toBeLessThan(LIMIT);
    } finally {
      for (const secret of secrets) unregisterProject(secret);
    }
  });

  it('does nothing when there is comfortable headroom', async () => {
    // The guard must stay silent in the normal case — an always-on evictor would
    // trade one failure (dying) for another (constant reopen churn).
    const p1 = tempDir();
    await getDbForDir(p1);
    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = '1';
    await evictForHeadroomForTests();
    expect(isDbOpenForDir(p1)).toBe(true);
    expect(evictionStats().byMode.headroom).toBe(0);
  });

  it('still never evicts a pinned or in-flight cluster under pressure', async () => {
    // Resilience must not come at the cost of the docs/128 §128.3 invariants —
    // shedding a cluster mid-query would turn an OOM into a failed request.
    const p1 = tempDir();
    await getDbForDir(p1);
    const release = pinClustersForDirs([p1]);
    try {
      process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = String(1024 ** 4);
      await evictForHeadroomForTests();
      expect(isDbOpenForDir(p1), 'a pinned cluster must survive even critical pressure').toBe(true);
    } finally {
      release();
    }
  });
});
