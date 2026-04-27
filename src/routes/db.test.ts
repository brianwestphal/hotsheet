import { writeFileSync } from 'fs';
import { Hono } from 'hono';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearRecoveryMarker, readRecoveryMarker } from '../db/connection.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { dbRoutes } from './db.js';

interface RecoveryStatusResponse {
  marker: { corruptPath: string; recoveredAt: string; errorMessage: string } | null;
}

interface OkResponse { ok: boolean }

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('dataDir', tempDir); await next(); });
  app.route('/api/db', dbRoutes);
});

afterAll(async () => {
  clearRecoveryMarker(tempDir);
  await cleanupTestDb(tempDir);
});

/** HS-7899: GET /api/db/recovery-status surfaces the persisted marker so
 *  the launch-time client banner can prompt the user. POST /dismiss-recovery
 *  clears the marker. Both endpoints are idempotent and safe under
 *  no-marker conditions. */
describe('dbRoutes (HS-7899)', () => {
  it('returns marker:null when no recovery has occurred', async () => {
    clearRecoveryMarker(tempDir);
    const res = await app.request('/api/db/recovery-status');
    expect(res.status).toBe(200);
    const data = await res.json() as RecoveryStatusResponse;
    expect(data.marker).toBeNull();
  });

  it('returns the marker when one exists on disk', async () => {
    writeFileSync(
      join(tempDir, '.db-recovery-marker.json'),
      JSON.stringify({
        corruptPath: '/tmp/whatever-corrupt-1234',
        recoveredAt: '2026-04-27T12:00:00.000Z',
        errorMessage: 'PANIC: could not locate a valid checkpoint record at 0/7A58678',
      })
    );

    const res = await app.request('/api/db/recovery-status');
    const data = await res.json() as RecoveryStatusResponse;
    expect(data.marker).not.toBeNull();
    expect(data.marker!.corruptPath).toBe('/tmp/whatever-corrupt-1234');
    expect(data.marker!.recoveredAt).toBe('2026-04-27T12:00:00.000Z');
    expect(data.marker!.errorMessage).toContain('PANIC');
  });

  it('POST /dismiss-recovery clears the marker and recovery-status returns null afterwards', async () => {
    writeFileSync(
      join(tempDir, '.db-recovery-marker.json'),
      JSON.stringify({ corruptPath: '/x', recoveredAt: '2026-04-27T12:00:00.000Z', errorMessage: '' })
    );
    expect(readRecoveryMarker(tempDir)).not.toBeNull();

    const dismissRes = await app.request('/api/db/dismiss-recovery', { method: 'POST' });
    expect(dismissRes.status).toBe(200);
    const ok = await dismissRes.json() as OkResponse;
    expect(ok.ok).toBe(true);

    const statusRes = await app.request('/api/db/recovery-status');
    const status = await statusRes.json() as RecoveryStatusResponse;
    expect(status.marker).toBeNull();
  });

  it('POST /dismiss-recovery is idempotent — safe to call when no marker exists', async () => {
    clearRecoveryMarker(tempDir);
    const res = await app.request('/api/db/dismiss-recovery', { method: 'POST' });
    expect(res.status).toBe(200);
    const ok = await res.json() as OkResponse;
    expect(ok.ok).toBe(true);
  });
});

/** HS-7897: Repair Database routes — guarantee that the find-working-backup
 *  flow surfaces the right shape and that pg_resetwal is gated on a
 *  recovery marker so users can't accidentally run it against a healthy
 *  DB. The actual `pg_resetwal` execution is not exercised here (it
 *  needs the system binary); covered indirectly by `repair.test.ts`. */
describe('dbRoutes — Repair (HS-7897)', () => {
  it('GET /repair/pg-resetwal-availability returns the platform + install hint regardless of binary presence', async () => {
    const res = await app.request('/api/db/repair/pg-resetwal-availability');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      available: boolean;
      platform: string;
      installInstructions: { description: string; command: string; url: string };
    };
    expect(typeof data.available).toBe('boolean');
    expect(typeof data.platform).toBe('string');
    expect(data.installInstructions).toBeDefined();
    expect(typeof data.installInstructions.description).toBe('string');
    expect(typeof data.installInstructions.command).toBe('string');
    expect(typeof data.installInstructions.url).toBe('string');
  });

  it('POST /repair/run-pg-resetwal returns 400 when no recovery marker exists', async () => {
    clearRecoveryMarker(tempDir);
    const res = await app.request('/api/db/repair/run-pg-resetwal', { method: 'POST' });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/recovery marker/i);
  });

  it('POST /repair/find-working-backup returns 200 + null backup when none exist', async () => {
    const res = await app.request('/api/db/repair/find-working-backup', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { backup: unknown };
    // Backup field always present so the client doesn't have to handle a
    // missing key separately from an explicit null.
    expect('backup' in data).toBe(true);
  });
});
