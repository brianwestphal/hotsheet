import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { createTicket } from '../db/queries.js';
import type { AppEnv } from '../types.js';

// Mock markdown sync to avoid side effects
vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(),
  scheduleWorklistSync: vi.fn(),
  scheduleOpenTicketsSync: vi.fn(),
  initMarkdownSync: vi.fn(),
}));

import { backupRoutes } from './backups.js';

let tempDir: string;
let app: Hono<AppEnv>;

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
    const data = await res.json();
    expect(data.backups).toBeInstanceOf(Array);
    expect(data.backups.length).toBe(0);
  });
});

describe('POST /api/backups/create', () => {
  it('creates a backup with 5min tier', async () => {
    const res = await app.request('/api/backups/create', post({ tier: '5min' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe('5min');
    expect(data.filename).toMatch(/^backup-.*\.tar\.gz$/);
    expect(data.ticketCount).toBeGreaterThanOrEqual(3);
    expect(typeof data.sizeBytes).toBe('number');
    expect(data.sizeBytes).toBeGreaterThan(0);
  });

  it('creates a backup with hourly tier', async () => {
    const res = await app.request('/api/backups/create', post({ tier: 'hourly' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe('hourly');
  });

  it('creates a backup with daily tier', async () => {
    const res = await app.request('/api/backups/create', post({ tier: 'daily' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe('daily');
  });
});

describe('GET /api/backups (after creation)', () => {
  it('lists all created backups', async () => {
    const res = await app.request('/api/backups');
    expect(res.status).toBe(200);
    const data = await res.json();
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
    const data = await res.json();
    const dates = data.backups.map((b: { createdAt: string }) => new Date(b.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });
});

describe('POST /api/backups/now', () => {
  it('triggers a manual backup', async () => {
    const res = await app.request('/api/backups/now', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    // triggerManualBackup creates a 5min tier backup
    expect(data.tier).toBe('5min');
    expect(data.filename).toMatch(/^backup-.*\.tar\.gz$/);
  });
});

describe('GET /api/backups/preview/:tier/:filename', () => {
  it('loads a backup for preview', async () => {
    // First get the list to find a backup filename
    const listRes = await app.request('/api/backups');
    const listData = await listRes.json();
    const backup = listData.backups[0];

    const res = await app.request(`/api/backups/preview/${backup.tier}/${backup.filename}`);
    expect(res.status).toBe(200);
    const data = await res.json();
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
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe('POST /api/backups/preview/cleanup', () => {
  it('cleans up preview resources', async () => {
    const res = await app.request('/api/backups/preview/cleanup', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

describe('POST /api/backups/restore', () => {
  it('restores from a backup', async () => {
    // Get a backup to restore from
    const listRes = await app.request('/api/backups');
    const listData = await listRes.json();
    const backup = listData.backups[0];

    const res = await app.request('/api/backups/restore', post({
      tier: backup.tier,
      filename: backup.filename,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('returns 500 for nonexistent backup file', async () => {
    const res = await app.request('/api/backups/restore', post({
      tier: '5min',
      filename: 'nonexistent.tar.gz',
    }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});
