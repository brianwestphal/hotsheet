/**
 * HS-8884 — telemetry-DB disk reclaim (VACUUM) tests.
 *
 * `decideVacuumMode` is the pure size/throttle policy; the rest exercise the
 * effectful pieces against real temp dirs + a real PGLite cluster (VACUUM /
 * VACUUM FULL run for real — they succeeded in the PGLite probe), with the
 * global config + project list mocked so the test never touches the developer's
 * real `~/.hotsheet`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalConfig } from '../routes/validation.js';
import { createBackgroundScheduler } from '../scheduler/backgroundScheduler.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir } from './connection.js';

// Isolate the central store to a temp dir (mirrors cleanupTelemetry.test.ts).
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

// In-memory global config so the VACUUM throttle timestamp round-trips without
// touching the real config.json.
const { configStore } = vi.hoisted(() => {
  const configStore: { value: GlobalConfig } = { value: {} };
  return { configStore };
});
vi.mock('../global-config.js', () => ({
  readGlobalConfig: (): GlobalConfig => configStore.value,
  writeGlobalConfig: (updates: Partial<GlobalConfig>): GlobalConfig => {
    configStore.value = { ...configStore.value, ...updates };
    return configStore.value;
  },
}));

const { mockReadProjectList } = vi.hoisted(() => ({ mockReadProjectList: vi.fn<() => string[]>(() => []) }));
vi.mock('../project-list.js', () => ({ readProjectList: mockReadProjectList }));

const {
  decideVacuumMode, dirSizeBytes, maintainTelemetryDb,
  scheduleTelemetryMaintenance, scheduleTelemetryReclaim, telemetryDbDir,
} = await import('./telemetryVacuum.js');

const MB = 1024 * 1024;

describe('decideVacuumMode (HS-8884)', () => {
  const opts = { plainMinBytes: 20 * MB, fullMinBytes: 100 * MB, throttleMs: 7 * 24 * 60 * 60 * 1000 };

  it('does nothing below the plain threshold', () => {
    expect(decideVacuumMode(5 * MB, null, 1000, opts)).toBe('none');
  });

  it('plain-vacuums between the plain and full thresholds', () => {
    expect(decideVacuumMode(50 * MB, null, 1000, opts)).toBe('plain');
  });

  it('full-vacuums above the full threshold when never done before', () => {
    expect(decideVacuumMode(200 * MB, null, 1000, opts)).toBe('full');
  });

  it('falls back to plain when bloated but a full ran within the throttle window', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const lastFull = now - 1 * 24 * 60 * 60 * 1000; // 1 day ago, < 7-day throttle
    expect(decideVacuumMode(200 * MB, lastFull, now, opts)).toBe('plain');
  });

  it('full-vacuums again once the throttle window has elapsed', () => {
    const now = 30 * 24 * 60 * 60 * 1000;
    const lastFull = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago, > 7-day throttle
    expect(decideVacuumMode(200 * MB, lastFull, now, opts)).toBe('full');
  });
});

describe('dirSizeBytes (HS-8884)', () => {
  it('sums file sizes recursively; 0 for a missing dir', () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'a.bin'), Buffer.alloc(1000));
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'b.bin'), Buffer.alloc(2000));
      expect(dirSizeBytes(dir)).toBe(3000);
      expect(dirSizeBytes(join(dir, 'does-not-exist'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('maintainTelemetryDb (HS-8884)', () => {
  let tempDir: string;
  beforeEach(async () => {
    configStore.value = {};
    mockReadProjectList.mockReset();
    mockReadProjectList.mockReturnValue([]);
    tempDir = await setupTestDb();
  });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  it('skips (mode none) a DB under the plain threshold', async () => {
    // A fresh empty cluster is small; with default thresholds it's a no-op.
    const res = await maintainTelemetryDb(tempDir);
    expect(res.mode).toBe('none');
  });

  it('runs a full reclaim when over the (test-lowered) threshold + records the throttle stamp', async () => {
    const now = 1_000_000;
    // Lower thresholds so the tiny test cluster qualifies for a full reclaim.
    const res = await maintainTelemetryDb(tempDir, { plainMinBytes: 0, fullMinBytes: 0, now: () => now });
    expect(res.mode).toBe('full');
    // Throttle stamp recorded against the db dir.
    expect(configStore.value.telemetryVacuumFullAt?.[telemetryDbDir(tempDir)]).toBe(new Date(now).toISOString());

    // A second call one day later is throttled down to a plain VACUUM.
    const later = now + 24 * 60 * 60 * 1000;
    const res2 = await maintainTelemetryDb(tempDir, { plainMinBytes: 0, fullMinBytes: 0, now: () => later });
    expect(res2.mode).toBe('plain');
  });

  it('force runs a full reclaim regardless of size/throttle (the §74 clear path)', async () => {
    const now = 2_000_000;
    // Pre-seed a recent full so the throttle would otherwise block.
    configStore.value = { telemetryVacuumFullAt: { [telemetryDbDir(tempDir)]: new Date(now).toISOString() } };
    const res = await maintainTelemetryDb(tempDir, { now: () => now + 1000, force: true });
    expect(res.mode).toBe('full');
  });
});

describe('scheduleTelemetryMaintenance / scheduleTelemetryReclaim (HS-8884)', () => {
  beforeEach(() => {
    configStore.value = {};
    mockReadProjectList.mockReset();
    mockReadProjectList.mockReturnValue([]);
  });

  it('submits one maintenance job per distinct DB (launched + listed + central)', async () => {
    const launched = '/proj/launched';
    const listed = '/proj/other';
    mockReadProjectList.mockReturnValue([listed, launched]); // launched duplicated on purpose
    const scheduler = createBackgroundScheduler();
    const seen: string[] = [];
    const promises = scheduleTelemetryMaintenance(launched, {
      scheduler,
      maintain: (dir) => { seen.push(dir); return Promise.resolve(); },
    });
    await Promise.all(promises);
    // Deduped: launched + listed + central, exactly once each.
    expect(new Set(seen)).toEqual(new Set([launched, listed, centralTelemetryDataDir()]));
    expect(seen.length).toBe(3);
  });

  it('reclaim submits a single forced job for one DB', async () => {
    const scheduler = createBackgroundScheduler();
    const seen: string[] = [];
    await scheduleTelemetryReclaim('/proj/cleared', {
      scheduler,
      maintain: (dir) => { seen.push(dir); return Promise.resolve(); },
    });
    expect(seen).toEqual(['/proj/cleared']);
  });
});
