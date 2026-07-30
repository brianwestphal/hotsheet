/**
 * HS-9426 (docs/127) — telemetry clusters open with a small WAL budget, project
 * clusters keep PGLite's default. Against a REAL cluster, since the whole point
 * is that the GUCs actually reach the postgres runtime.
 */
import { rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import { closeDbForDir, getDbForDir, isTelemetryClusterDbPath, telemetryClusterDataDir } from './connection.js';

// HS-9504 — a PGLite-heavy suite: real embedded-Postgres clusters, which stretch ~6x
// under the full parallel run (CPU starvation, see `vitest.config.ts`). The global 30s
// budget is deliberate and stays; the heavy tier scopes its own. Applied to the whole
// tier at once rather than one file per flake — the failing file ROTATED between runs,
// so fixing them individually was whack-a-mole.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let tmp: string;
beforeEach(() => { tmp = createTempDir(); });
afterEach(async () => {
  await closeDbForDir(join(tmp, 'telemetry'));
  await closeDbForDir(tmp);
  rmSync(tmp, { recursive: true, force: true });
});

describe('isTelemetryClusterDbPath (HS-9426)', () => {
  it('recognizes a telemetry cluster db dir, not a project one', () => {
    expect(isTelemetryClusterDbPath('/x/.hotsheet/telemetry/db')).toBe(true);
    expect(isTelemetryClusterDbPath('/home/u/.hotsheet/telemetry/db')).toBe(true);
    expect(isTelemetryClusterDbPath('/x/.hotsheet/db')).toBe(false);
  });

  it('agrees with the path telemetryClusterDataDir produces', () => {
    // Pin the contract the detection relies on: a project's telemetry cluster db
    // dir is `<telemetryClusterDataDir>/db`, and that IS detected as telemetry.
    const clusterDb = join(telemetryClusterDataDir(tmp), 'db');
    expect(isTelemetryClusterDbPath(clusterDb)).toBe(true);
  });
});

describe('telemetry cluster WAL budget (HS-9426)', () => {
  const showMaxWal = async (dataDir: string): Promise<string> => {
    const db = await getDbForDir(dataDir);
    const r = await db.query<{ max_wal_size: string }>('SHOW max_wal_size;');
    return r.rows[0]?.max_wal_size ?? '';
  };

  it('opens a telemetry cluster with max_wal_size=64MB', async () => {
    expect(await showMaxWal(telemetryClusterDataDir(tmp))).toBe('64MB');
  });

  it('opens a telemetry cluster with min_wal_size=32MB', async () => {
    const db = await getDbForDir(telemetryClusterDataDir(tmp));
    const r = await db.query<{ min_wal_size: string }>('SHOW min_wal_size;');
    expect(r.rows[0]?.min_wal_size).toBe('32MB');
  });

  it('leaves a PROJECT cluster on the PGLite default (1GB)', async () => {
    // The tuning must not touch clusters holding live ticket data.
    expect(await showMaxWal(tmp)).toBe('1GB');
  });

  it('re-derives the same budget on reopen', async () => {
    const dir = telemetryClusterDataDir(tmp);
    expect(await showMaxWal(dir)).toBe('64MB');
    await closeDbForDir(dir);
    // A cold reopen must apply the same params — otherwise the WAL would drift
    // back to the default budget on the next launch.
    expect(await showMaxWal(dir)).toBe('64MB');
  });
});
