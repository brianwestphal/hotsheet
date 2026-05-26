/**
 * HS-8636 — backups typed-API module. Verifies the callers hit the right
 * path + method, unwrap the list/info wrappers, and that the schemas accept a
 * real payload / reject a malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  BackupInfoSchema, BackupPreviewSchema, cleanupBackupPreview, createBackup,
  listBackups, previewBackup, restoreBackup, triggerManualBackup,
} from './backups.js';

const info = { tier: '5min', filename: 'backup-1.tar.gz', createdAt: 'x', ticketCount: 3, sizeBytes: 100 };
const preview = { tickets: [{ id: 1 }, {}], stats: { total: 2, open: 1, upNext: 0 } };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('backup schemas (HS-8636)', () => {
  it('accepts valid payloads and rejects malformed ones', () => {
    expect(BackupInfoSchema.safeParse(info).success).toBe(true);
    expect(BackupPreviewSchema.safeParse(preview).success).toBe(true);
    expect(BackupInfoSchema.safeParse({ ...info, tier: 'yearly' }).success).toBe(false); // bad tier enum
    expect(BackupInfoSchema.safeParse({ ...info, sizeBytes: '100' }).success).toBe(false); // wrong type
  });
});

describe('backup callers route to the right endpoint (HS-8636)', () => {
  it('listBackups → GET /backups, unwrapped', async () => {
    stub({ backups: [info] });
    expect(await listBackups()).toEqual([info]);
    expect(lastCall?.path).toBe('/backups');
  });

  it('createBackup → POST /backups/create with tier body', async () => {
    stub(info);
    await createBackup('hourly');
    expect(lastCall).toEqual({ path: '/backups/create', opts: { method: 'POST', body: { tier: 'hourly' } } });
  });

  it('triggerManualBackup → POST /backups/now', async () => {
    stub(info);
    await triggerManualBackup();
    expect(lastCall).toEqual({ path: '/backups/now', opts: { method: 'POST' } });
  });

  it('previewBackup → GET /backups/preview/:tier/:filename (encoded)', async () => {
    stub(preview);
    await previewBackup('5min', 'backup a.tar.gz');
    expect(lastCall?.path).toBe('/backups/preview/5min/backup%20a.tar.gz');
  });

  it('cleanupBackupPreview → POST /backups/preview/cleanup', async () => {
    stub({ ok: true });
    await cleanupBackupPreview();
    expect(lastCall).toEqual({ path: '/backups/preview/cleanup', opts: { method: 'POST' } });
  });

  it('restoreBackup → POST /backups/restore with tier + filename body', async () => {
    stub({ ok: true });
    await restoreBackup('daily', 'b.tar.gz');
    expect(lastCall).toEqual({ path: '/backups/restore', opts: { method: 'POST', body: { tier: 'daily', filename: 'b.tar.gz' } } });
  });

  it('rejects a list response that fails schema validation', async () => {
    stub({ backups: [{ ...info, tier: 'nope' }] });
    await expect(listBackups()).rejects.toThrow(/response shape mismatch/);
  });
});
