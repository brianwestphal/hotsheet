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
  decideVacuumMode, dirSizeBytes, isExpectedVacuumLimitation, isVacuumFreezeError,
  isVacuumFullCatalogError, maintainTelemetryDb,
  performVacuum, scheduleTelemetryMaintenance, scheduleTelemetryReclaim, telemetryDbDir,
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

describe('isVacuumFullCatalogError (HS-8897)', () => {
  // The exact error PGLite raised on the user's telemetry DBs: VACUUM FULL hit a
  // pg_class (relname, relnamespace) unique violation rebuilding an index.
  const realError = Object.assign(new Error('duplicate key value violates unique constraint "pg_class_relname_nsp_index"'), {
    code: '23505',
    constraint: 'pg_class_relname_nsp_index',
    detail: 'Key (relname, relnamespace)=(idx_command_log_created, 2200) already exists.',
    query: 'VACUUM FULL',
  });

  it('matches the real PGLite pg_class catalog violation by code + constraint', () => {
    expect(isVacuumFullCatalogError(realError)).toBe(true);
  });

  it('matches when only the message is present (degraded error shape)', () => {
    expect(isVacuumFullCatalogError(new Error('… duplicate key value violates unique constraint "pg_class_relname_nsp_index"'))).toBe(true);
  });

  it('does not match an unrelated SQL error', () => {
    expect(isVacuumFullCatalogError(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(false);
    expect(isVacuumFullCatalogError(Object.assign(new Error('dup'), { code: '23505', constraint: 'tickets_pkey' }))).toBe(false);
  });

  it('is safe on non-error values', () => {
    expect(isVacuumFullCatalogError(null)).toBe(false);
    expect(isVacuumFullCatalogError('boom')).toBe(false);
    expect(isVacuumFullCatalogError(undefined)).toBe(false);
  });
});

describe('performVacuum (HS-8897)', () => {
  const catalogError = Object.assign(new Error('duplicate key value violates unique constraint "pg_class_relname_nsp_index"'), {
    code: '23505', constraint: 'pg_class_relname_nsp_index',
  });

  it('runs a plain VACUUM and never attempts full for plain mode', async () => {
    const calls: string[] = [];
    const r = await performVacuum((sql: string): Promise<void> => { calls.push(sql); return Promise.resolve(); }, 'plain');
    expect(calls).toEqual(['VACUUM']);
    expect(r).toEqual({ ranMode: 'plain', fullAttempted: false });
  });

  it('runs VACUUM FULL when it succeeds', async () => {
    const calls: string[] = [];
    const r = await performVacuum((sql: string): Promise<void> => { calls.push(sql); return Promise.resolve(); }, 'full');
    expect(calls).toEqual(['VACUUM FULL']);
    expect(r).toEqual({ ranMode: 'full', fullAttempted: true });
  });

  it('degrades a catalog-limited VACUUM FULL to a plain VACUUM (HS-8897)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const r = await performVacuum((sql: string): Promise<void> => {
      calls.push(sql);
      if (sql === 'VACUUM FULL') throw catalogError;
      return Promise.resolve();
    }, 'full');
    expect(calls).toEqual(['VACUUM FULL', 'VACUUM']); // attempted full, then fell back
    expect(r).toEqual({ ranMode: 'plain', fullAttempted: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('rethrows a non-catalog VACUUM FULL failure', async () => {
    const boom = Object.assign(new Error('out of disk'), { code: '53100' });
    await expect(performVacuum((sql: string): Promise<void> => { if (sql === 'VACUUM FULL') throw boom; return Promise.resolve(); }, 'full')).rejects.toBe(boom);
  });

  // HS-8915 — the exact plain-VACUUM error PGLite raised on the user's Glassbox
  // telemetry DB: heap_pre_freeze_checks aborting on an unfrozen catalog tuple.
  const freezeError = Object.assign(new Error('uncommitted xmin 8486 needs to be frozen'), {
    code: 'XX001',
    where: 'while scanning block 63 of relation "pg_catalog.pg_attribute"',
    file: 'heapam.c', line: '7288', routine: 'heap_pre_freeze_checks', query: 'VACUUM',
  });

  it('skips (does not throw) a plain VACUUM that hits the freeze limitation (HS-8915)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await performVacuum((sql: string): Promise<void> => { if (sql === 'VACUUM') throw freezeError; return Promise.resolve(); }, 'plain');
    expect(r).toEqual({ ranMode: 'skipped', fullAttempted: false });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('skips a VACUUM FULL that hits the freeze limitation directly (HS-8915)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await performVacuum((sql: string): Promise<void> => { if (sql === 'VACUUM FULL') throw freezeError; return Promise.resolve(); }, 'full');
    expect(r).toEqual({ ranMode: 'skipped', fullAttempted: true });
    warn.mockRestore();
  });

  it('degrades a catalog-limited FULL to plain, then skips if plain also freezes (HS-8915)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const r = await performVacuum((sql: string): Promise<void> => {
      calls.push(sql);
      if (sql === 'VACUUM FULL') throw catalogError;
      throw freezeError; // the degraded plain VACUUM also fails on this cluster
    }, 'full');
    expect(calls).toEqual(['VACUUM FULL', 'VACUUM']);
    expect(r).toEqual({ ranMode: 'skipped', fullAttempted: true });
    warn.mockRestore();
  });
});

describe('isVacuumFreezeError / isExpectedVacuumLimitation (HS-8915)', () => {
  const freezeByFields = Object.assign(new Error('uncommitted xmin 8486 needs to be frozen'), {
    code: 'XX001', routine: 'heap_pre_freeze_checks',
  });

  it('matches the real freeze error by code + routine', () => {
    expect(isVacuumFreezeError(freezeByFields)).toBe(true);
  });

  it('matches by message when fields are absent (degraded shape)', () => {
    expect(isVacuumFreezeError(new Error('… needs to be frozen'))).toBe(true);
  });

  it('does not match an unrelated error or non-objects', () => {
    expect(isVacuumFreezeError(Object.assign(new Error('deadlock'), { code: '40P01' }))).toBe(false);
    expect(isVacuumFreezeError(Object.assign(new Error('corrupt page'), { code: 'XX001' }))).toBe(false); // XX001 alone isn't enough
    expect(isVacuumFreezeError(null)).toBe(false);
    expect(isVacuumFreezeError('boom')).toBe(false);
  });

  it('isExpectedVacuumLimitation covers both the catalog and freeze cases', () => {
    expect(isExpectedVacuumLimitation(freezeByFields)).toBe(true);
    expect(isExpectedVacuumLimitation(Object.assign(new Error('dup'), { code: '23505', constraint: 'pg_class_relname_nsp_index' }))).toBe(true);
    expect(isExpectedVacuumLimitation(Object.assign(new Error('out of disk'), { code: '53100' }))).toBe(false);
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
