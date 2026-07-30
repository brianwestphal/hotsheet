/**
 * HS-9480 — the headroom circuit breaker WIRED INTO `evictForHeadroom`, against
 * real PGLite clusters. The policy itself is pure-tested in
 * `clusterEviction.test.ts`; this file exists because HS-9477 was nearly shipped
 * with a test that exercised the function but not the wiring, and a breaker
 * nobody consults is worse than no breaker (it reads as covered).
 *
 * `currentExternalBytes` is pinned to a constant so every pass measures "we
 * evicted, we forced a collection, and memory did not move" — the signature of
 * the 2026-07-29 death spiral, where 375 headroom evictions in ~130 s coincided
 * with `external` climbing from 4237 MB to 5845 MB.
 */
import { rmSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import type * as ClusterEvictionModule from './clusterEviction.js';

// HS-9504 — a PGLite-heavy suite: real embedded-Postgres clusters, which stretch ~6x
// under the full parallel run (CPU starvation, see `vitest.config.ts`). The global 30s
// budget is deliberate and stays; the heavy tier scopes its own. Applied to the whole
// tier at once rather than one file per flake — the failing file ROTATED between runs,
// so fixing them individually was whack-a-mole.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/** High enough that the guard always wants to evict, and constant so no pass can
 *  ever look effective. */
const PINNED_EXTERNAL = 4237 * 1024 * 1024;

vi.mock('./clusterEviction.js', async () => {
  const actual = await vi.importActual<typeof ClusterEvictionModule>('./clusterEviction.js');
  return { ...actual, currentExternalBytes: () => PINNED_EXTERNAL };
});

const {
  closeAllDatabases,
  evictForHeadroomForTests,
  getDbForDir,
  headroomGuardSuspended,
  isDbOpenForDir,
  resetHeadroomBreakerForTests,
  setDataDir,
} = await import('./connection.js');
const { HEADROOM_BREAKER_TRIP_COUNT, resetEvictionTrackingForTests } = await import('./clusterEviction.js');

const ENV_KEYS = [
  'HOTSHEET_EXTERNAL_HEADROOM_BYTES',
  'HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS',
  'HOTSHEET_FORCED_GC_MIN_INTERVAL_MS',
] as const;

describe('headroom guard suspends itself when evicting stops reclaiming (HS-9480)', () => {
  const saved: Record<string, string | undefined> = {};
  const created: string[] = [];
  const tempDir = (): string => { const d = createTempDir(); created.push(d); return d; };
  let anchor: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HOTSHEET_EXTERNAL_HEADROOM_BYTES = String(1024 ** 4); // always under pressure
    process.env.HOTSHEET_CLUSTER_MIN_IDLE_EVICT_MS = '0';             // no recency guard
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '0';             // every pass is measurable
    resetHeadroomBreakerForTests();
    resetEvictionTrackingForTests();
    anchor = tempDir();
    setDataDir(anchor);
    await getDbForDir(anchor);
  });

  afterEach(async () => {
    await closeAllDatabases();
    resetHeadroomBreakerForTests();
    resetEvictionTrackingForTests();
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('keeps evicting until the trip count, then stops — and says so distinctly', async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      // Each round: open a victim, run a pressure pass, confirm it was evicted.
      for (let i = 0; i < HEADROOM_BREAKER_TRIP_COUNT; i++) {
        const victim = tempDir();
        await getDbForDir(victim);
        expect(headroomGuardSuspended(), `must still be armed before pass ${String(i + 1)}`).toBe(false);
        await evictForHeadroomForTests();
        expect(isDbOpenForDir(victim), `pass ${String(i + 1)} should still evict`).toBe(false);
      }

      expect(headroomGuardSuspended(), 'three fruitless passes should open the breaker').toBe(true);

      // The whole point: the next pass must NOT churn. An un-evicted warm cluster
      // costs the same memory as an evicted-then-reopened one, minus the reopen.
      const survivor = tempDir();
      await getDbForDir(survivor);
      await evictForHeadroomForTests();
      expect(isDbOpenForDir(survivor), 'a suspended guard must not evict').toBe(true);

      // "We are low on memory" and "our only lever does not work" are different
      // operator stories; before this they were the same line.
      expect(errors.some(m => m.includes('SUSPENDED')), `expected a distinct suspension log, got: ${errors.join(' | ')}`).toBe(true);
      expect(errors.filter(m => m.includes('SUSPENDED')).length, 'and only once, not once per pass').toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('leaves the cap and idle sweeps alone — only pressure eviction is suspended', async () => {
    // The runaway was the pressure path specifically. Suspending the cap would
    // let the cache grow without bound, which is the bug docs/128 exists to fix.
    for (let i = 0; i < HEADROOM_BREAKER_TRIP_COUNT; i++) {
      const victim = tempDir();
      await getDbForDir(victim);
      await evictForHeadroomForTests();
    }
    expect(headroomGuardSuspended()).toBe(true);

    process.env.HOTSHEET_CLUSTER_IDLE_MS = '0';
    try {
      const idle = tempDir();
      await getDbForDir(idle);
      const { evictIdleClusters } = await import('./connection.js');
      const closed = await evictIdleClusters();
      expect(closed, 'the idle sweep still runs while the pressure guard is suspended').toBeGreaterThanOrEqual(1);
      expect(isDbOpenForDir(idle)).toBe(false);
      expect(isDbOpenForDir(anchor), 'the pinned default is still never evicted').toBe(true);
    } finally {
      Reflect.deleteProperty(process.env, 'HOTSHEET_CLUSTER_IDLE_MS');
    }
  });
});
