import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTicket } from '../db/queries.js';
import { writeFileSettings } from '../file-settings.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { backupRoutes } from './backups.js';

// Mock markdown sync to avoid side effects
vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(),
  scheduleWorklistSync: vi.fn(),
  scheduleOpenTicketsSync: vi.fn(),
  initMarkdownSync: vi.fn(),
}));

// HS-8720 — these route cases drive REAL PGLite backup work through the handlers
// (CHECKPOINT + dumpDataDir + fsync per tier). In isolation that's fast, but
// under the full merged-coverage run (200+ files in parallel + V8 instrumentation)
// CPU starvation can push a single /create body past vitest's 30s default. When
// the first case times out mid-backup, the still-running promise keeps the
// per-project `backupInProgress` gate held, so every later /create returns 409 —
// a one-timeout-into-many-409s cascade. Scope generous timeouts to THIS file
// (same mitigation as backup.test.ts) rather than bumping the global config and
// masking real hangs elsewhere.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let tempDir: string;
let app: Hono<AppEnv>;

interface BackupEntry {
  tier: string;
  filename: string;
  ticketCount: number;
  sizeBytes: number;
  createdAt: string;
}

interface BackupListResponse {
  backups: BackupEntry[];
}

interface PreviewResponse {
  tickets: unknown[];
  stats: { total: number; open: number; upNext: number };
}

interface OkResponse {
  ok: boolean;
}

interface ErrorResponse {
  error: string;
}

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    await next();
  });
  app.route('/api/backups', backupRoutes);

  // Create some tickets so backups have data
  await createTicket('Backup test 1');
  await createTicket('Backup test 2');
  await createTicket('Backup test 3');
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

function post(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('GET /api/backups', () => {
  it('returns an empty array when no backups exist', async () => {
    const res = await app.request('/api/backups');
    expect(res.status).toBe(200);
    const data = await res.json() as BackupListResponse;
    expect(data.backups).toBeInstanceOf(Array);
    expect(data.backups.length).toBe(0);
  });
});

describe('POST /api/backups/create', () => {
  it('creates a backup with 5min tier', async () => {
    const res = await app.request('/api/backups/create', post({ tier: '5min' }));
    expect(res.status).toBe(200);
    const data = await res.json() as BackupEntry;
    expect(data.tier).toBe('5min');
    expect(data.filename).toMatch(/^backup-.*\.tar\.gz$/);
    expect(data.ticketCount).toBeGreaterThanOrEqual(3);
    expect(typeof data.sizeBytes).toBe('number');
    expect(data.sizeBytes).toBeGreaterThan(0);
  });

  it('creates a backup with hourly tier', async () => {
    const res = await app.request('/api/backups/create', post({ tier: 'hourly' }));
    expect(res.status).toBe(200);
    const data = await res.json() as BackupEntry;
    expect(data.tier).toBe('hourly');
  });

  it('creates a backup with daily tier', async () => {
    const res = await app.request('/api/backups/create', post({ tier: 'daily' }));
    expect(res.status).toBe(200);
    const data = await res.json() as BackupEntry;
    expect(data.tier).toBe('daily');
  });
});

describe('GET /api/backups (after creation)', () => {
  it('lists all created backups', async () => {
    const res = await app.request('/api/backups');
    expect(res.status).toBe(200);
    const data = await res.json() as BackupListResponse;
    expect(data.backups.length).toBeGreaterThanOrEqual(3);

    // Verify structure of backup entries
    for (const backup of data.backups) {
      expect(backup.tier).toMatch(/^(5min|hourly|daily)$/);
      expect(backup.filename).toMatch(/\.tar\.gz$/);
      expect(backup.createdAt).toBeDefined();
      expect(typeof backup.sizeBytes).toBe('number');
    }
  });

  it('returns backups sorted by creation date (newest first)', async () => {
    const res = await app.request('/api/backups');
    const data = await res.json() as BackupListResponse;
    const dates = data.backups.map((b) => new Date(b.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });
});

describe('POST /api/backups/now', () => {
  it('triggers a manual backup', async () => {
    const res = await app.request('/api/backups/now', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as BackupEntry;
    // triggerManualBackup creates a 5min tier backup
    expect(data.tier).toBe('5min');
    expect(data.filename).toMatch(/^backup-.*\.tar\.gz$/);
  });
});

describe('GET /api/backups/preview/:tier/:filename', () => {
  it('loads a backup for preview', async () => {
    // First get the list to find a backup filename
    const listRes = await app.request('/api/backups');
    const listData = await listRes.json() as BackupListResponse;
    const backup = listData.backups[0];

    const res = await app.request(`/api/backups/preview/${backup.tier}/${backup.filename}`);
    expect(res.status).toBe(200);
    const data = await res.json() as PreviewResponse;
    expect(data.tickets).toBeInstanceOf(Array);
    expect(data.stats).toBeDefined();
    expect(typeof data.stats.total).toBe('number');
    expect(typeof data.stats.open).toBe('number');
    expect(typeof data.stats.upNext).toBe('number');
    expect(data.stats.total).toBeGreaterThanOrEqual(3);
  });

  it('returns 400 for nonexistent backup file', async () => {
    const res = await app.request('/api/backups/preview/5min/nonexistent.tar.gz');
    expect(res.status).toBe(400);
    const data = await res.json() as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe('POST /api/backups/preview/cleanup', () => {
  it('cleans up preview resources', async () => {
    const res = await app.request('/api/backups/preview/cleanup', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);
  });
});

describe('POST /api/backups/restore', () => {
  it('restores from a backup', async () => {
    // Get a backup to restore from
    const listRes = await app.request('/api/backups');
    const listData = await listRes.json() as BackupListResponse;
    const backup = listData.backups[0];

    const res = await app.request('/api/backups/restore', post({
      tier: backup.tier,
      filename: backup.filename,
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);
  });

  it('returns 500 for nonexistent backup file', async () => {
    const res = await app.request('/api/backups/restore', post({
      tier: '5min',
      filename: 'nonexistent.tar.gz',
    }));
    expect(res.status).toBe(500);
    const data = await res.json() as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

/**
 * HS-9536 — the stranded-roots endpoint.
 *
 * The dangerous output is a path presented as "abandoned". These assert it stays
 * silent whenever that claim is not provable.
 */
describe('GET /api/backups/stranded', () => {
  it('reports nothing when backupDir has never changed', async () => {
    const res = await app.request('/api/backups/stranded');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roots: unknown[] }).roots).toEqual([]);
  });

  it('reports a genuinely abandoned root, with its size', async () => {
    const abandoned = mkdtempSync(join(tmpdir(), 'hs-abandoned-'));
    const current = mkdtempSync(join(tmpdir(), 'hs-current-'));
    try {
      mkdirSync(join(abandoned, '5min'), { recursive: true });
      writeFileSync(join(abandoned, '5min', 'backup-2026-06-29T00-00-00Z.tar.gz'), Buffer.alloc(2048));

      // Two writes: the first establishes a root, the second abandons it.
      writeFileSettings(tempDir, { backupDir: abandoned });
      writeFileSettings(tempDir, { backupDir: current });

      const roots = ((await (await app.request('/api/backups/stranded')).json()) as { roots: { path: string; sizeBytes: number }[] }).roots;
      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(abandoned);
      expect(roots[0].sizeBytes).toBe(2048);
    } finally {
      rmSync(abandoned, { recursive: true, force: true });
      rmSync(current, { recursive: true, force: true });
    }
  });

  it('stays SILENT when the new root is nested inside the old one', async () => {
    // The maintainer's containment case, end to end. The "abandoned" tree
    // contains the live backups; reporting it invites deleting them.
    const outer = mkdtempSync(join(tmpdir(), 'hs-outer-'));
    try {
      mkdirSync(join(outer, '5min'), { recursive: true });
      writeFileSync(join(outer, '5min', 'backup-2026-06-29T00-00-00Z.tar.gz'), Buffer.alloc(512));
      const inner = join(outer, 'nested');
      mkdirSync(inner, { recursive: true });

      writeFileSettings(tempDir, { backupDir: outer });
      writeFileSettings(tempDir, { backupDir: inner });

      expect(((await (await app.request('/api/backups/stranded')).json()) as { roots: unknown[] }).roots).toEqual([]);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('stays silent for an abandoned root that no longer holds backups', async () => {
    // After the user cleans up by hand, the notice must stop appearing.
    const empty = mkdtempSync(join(tmpdir(), 'hs-empty-'));
    const current = mkdtempSync(join(tmpdir(), 'hs-cur2-'));
    try {
      writeFileSettings(tempDir, { backupDir: empty });
      writeFileSettings(tempDir, { backupDir: current });
      expect(((await (await app.request('/api/backups/stranded')).json()) as { roots: unknown[] }).roots).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(current, { recursive: true, force: true });
    }
  });
});
