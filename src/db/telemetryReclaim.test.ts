/**
 * HS-9427 (docs/127 §127.5) — reclaim existing telemetry WAL bloat.
 *
 * Two layers: the real dump→reload primitive against a genuinely bloated cluster
 * (the part that must actually preserve data), and the pure policy/threshold/
 * report logic with the rebuild seam mocked.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import { closeDbForDir, getDbForDir, rebuildTelemetryClusterFromDump, telemetryClusterDataDir } from './connection.js';
import {
  RECLAIM_WAL_THRESHOLD_BYTES,
  reclaimBloatedTelemetryClusters,
  summarizeReclaim,
  telemetryDirsForProjects,
} from './telemetryReclaim.js';

// HS-9504 — a PGLite-heavy suite: real embedded-Postgres clusters, which stretch ~6x
// under the full parallel run (CPU starvation, see `vitest.config.ts`). The global 30s
// budget is deliberate and stays; the heavy tier scopes its own. Applied to the whole
// tier at once rather than one file per flake — the failing file ROTATED between runs,
// so fixing them individually was whack-a-mole.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const walSegs = (dbDir: string): number => {
  try { return readdirSync(join(dbDir, 'pg_wal')).filter(f => /^[0-9A-F]{24}$/.test(f)).length; }
  catch { return 0; }
};

describe('rebuildTelemetryClusterFromDump (HS-9427) — real cluster', () => {
  let proj: string;
  beforeEach(() => { proj = createTempDir(); });
  afterEach(async () => {
    await closeDbForDir(telemetryClusterDataDir(proj));
    rmSync(proj, { recursive: true, force: true });
  });

  it('preserves every row while shedding the WAL', async () => {
    const clusterDataDir = telemetryClusterDataDir(proj);
    const dbDir = join(clusterDataDir, 'db');

    // Build a bloated cluster with data in a table of our own (a throwaway name so
    // it can't collide with the schema initSchema applies to every cluster). This
    // stands in for the cluster-resident tables a JSONL re-derive would have lost
    // (announcer_usage / ticket_work_intervals) — the point is that dump/reload
    // preserves ARBITRARY cluster data, not just derived rollups. `getDbForDir`
    // opens it tuned, but a burst of writes still peaks the WAL well past 64 MB.
    const db = await getDbForDir(clusterDataDir);
    await db.exec(`CREATE TABLE hs9427_probe (id serial primary key, val text);`);
    await db.exec(`INSERT INTO hs9427_probe (val) SELECT 'keep-' || g FROM generate_series(1, 500) g;`);
    for (let i = 0; i < 30; i++) {
      await db.exec(`INSERT INTO hs9427_probe (val) SELECT repeat('x', 2000) FROM generate_series(1, 2000);`);
    }
    const rowsBefore = (await db.query<{ c: number }>('SELECT count(*)::int c FROM hs9427_probe')).rows[0].c;
    const walBefore = walSegs(dbDir);
    expect(walBefore).toBeGreaterThan(4); // genuinely bloated

    await rebuildTelemetryClusterFromDump(clusterDataDir);

    // Reopen and confirm: same rows, a distinctive one intact, fewer WAL segments,
    // and the tuned budget on the rebuilt cluster.
    const db2 = await getDbForDir(clusterDataDir);
    const rowsAfter = (await db2.query<{ c: number }>('SELECT count(*)::int c FROM hs9427_probe')).rows[0].c;
    expect(rowsAfter, 'the rebuild lost rows').toBe(rowsBefore);
    expect((await db2.query<{ val: string }>(`SELECT val FROM hs9427_probe WHERE val = 'keep-1'`)).rows).toHaveLength(1);
    expect(walSegs(dbDir), 'the rebuild did not shrink the WAL').toBeLessThan(walBefore);
    expect((await db2.query<{ max_wal_size: string }>('SHOW max_wal_size')).rows[0].max_wal_size).toBe('64MB');
    // The aside dir must be gone on success.
    expect(readdirSync(join(clusterDataDir)).some(n => n.startsWith('db.reclaim-old'))).toBe(false);
  });

  it('refuses a non-telemetry (project) cluster', async () => {
    // `proj` itself (not its telemetry sibling) is a project cluster.
    await expect(rebuildTelemetryClusterFromDump(proj)).rejects.toThrow(/non-telemetry/);
    await closeDbForDir(proj);
  });
});

describe('reclaimBloatedTelemetryClusters (HS-9427) — policy', () => {
  let dir: string;
  beforeEach(() => { dir = createTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Fabricate a cluster dir with `walMb` of fake WAL segments + `dataMb` of base. */
  const fakeCluster = (name: string, walMb: number, dataMb: number): string => {
    const clusterDataDir = join(dir, name);
    const wal = join(clusterDataDir, 'db', 'pg_wal');
    const base = join(clusterDataDir, 'db', 'base');
    mkdirSync(wal, { recursive: true });
    mkdirSync(base, { recursive: true });
    const seg = Buffer.alloc(16 * 1024 * 1024);
    // `clusterSizeBreakdown` sums every file under pg_wal; the 24-hex-char segment
    // naming isn't what it measures, so a plain zero-padded counter is enough.
    for (let i = 0; i < walMb / 16; i++) {
      writeFileSync(join(wal, String(i).padStart(24, '0')), seg);
    }
    if (dataMb > 0) writeFileSync(join(base, 'data'), Buffer.alloc(dataMb * 1024 * 1024));
    return clusterDataDir;
  };

  it('rebuilds only clusters over the threshold, skips the rest', async () => {
    const big = fakeCluster('big', 320, 8);      // > 256 MB WAL → reclaim
    const small = fakeCluster('small', 64, 8);   // <= 256 MB WAL → skip
    const rebuilt: string[] = [];

    const results = await reclaimBloatedTelemetryClusters({
      clusterDataDirs: [big, small],
      rebuild: (d) => {
        rebuilt.push(d);
        // Simulate the rebuild shrinking the WAL: drop the fake segments.
        rmSync(join(d, 'db', 'pg_wal'), { recursive: true, force: true });
        mkdirSync(join(d, 'db', 'pg_wal'), { recursive: true });
        return Promise.resolve();
      },
    });

    expect(rebuilt).toEqual([big]); // small was never rebuilt
    const byStatus = Object.fromEntries(results.map(r => [r.clusterDataDir, r.status]));
    expect(byStatus[big]).toBe('reclaimed');
    expect(byStatus[small]).toBe('skipped');
    const bigResult = results.find(r => r.clusterDataDir === big)!;
    expect(bigResult.freedBytes).toBeGreaterThan(300 * 1024 * 1024);
  });

  it('reports a failed rebuild without aborting the others', async () => {
    const a = fakeCluster('a', 320, 4);
    const b = fakeCluster('b', 320, 4);
    const results = await reclaimBloatedTelemetryClusters({
      clusterDataDirs: [a, b],
      rebuild: (d) => {
        if (d === a) return Promise.reject(new Error('boom'));
        rmSync(join(d, 'db', 'pg_wal'), { recursive: true, force: true });
        mkdirSync(join(d, 'db', 'pg_wal'), { recursive: true });
        return Promise.resolve();
      },
    });
    const byStatus = Object.fromEntries(results.map(r => [r.clusterDataDir, r.status]));
    expect(byStatus[a]).toBe('failed');
    expect(byStatus[b]).toBe('reclaimed');
    expect(results.find(r => r.clusterDataDir === a)!.error).toContain('boom');
  });

  it('summarizeReclaim rolls up the counts + freed bytes', () => {
    const summary = summarizeReclaim([
      { clusterDataDir: 'x', status: 'reclaimed', beforeBytes: 300e6, afterBytes: 60e6, freedBytes: 240e6 },
      { clusterDataDir: 'y', status: 'skipped', beforeBytes: 10e6, afterBytes: 10e6, freedBytes: 0 },
      { clusterDataDir: 'z', status: 'failed', beforeBytes: 300e6, afterBytes: 300e6, freedBytes: 0 },
    ]);
    expect(summary).toEqual({ reclaimed: 1, skipped: 1, failed: 1, freedBytes: 240e6 });
  });

  it('the default threshold is above the HS-9426 steady state', () => {
    // A healthy tuned cluster (~64 MB WAL) must never qualify.
    expect(RECLAIM_WAL_THRESHOLD_BYTES).toBeGreaterThan(64 * 1024 * 1024);
  });

  it('telemetryDirsForProjects maps projects to telemetry siblings + central, deduped', () => {
    const central = '/home/u/.hotsheet/telemetry';
    const dirs = telemetryDirsForProjects(['/a/.hotsheet', '/b/.hotsheet', '/a/.hotsheet'], central);
    expect(dirs).toContain('/a/.hotsheet/telemetry');
    expect(dirs).toContain('/b/.hotsheet/telemetry');
    expect(dirs).toContain(central);
    expect(new Set(dirs).size).toBe(dirs.length); // deduped
  });
});
