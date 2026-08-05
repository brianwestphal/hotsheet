/**
 * HS-5186: backup/restore e2e tests.
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

interface BackupInfo { filename: string; tier: string }

/**
 * HS-9589 — ask for a manual backup, tolerating the genuine
 * "Backup already in progress" 409.
 *
 * These tests assumed a manual backup always succeeds. On the HS-9352 per-worker
 * server — spawned fresh moments before the spec — it usually collides with the
 * server's OWN startup backup and 409s, so both tests failed on a cold server.
 * Measured across three attempts 1.5 s apart: 409, 200, 409.
 *
 * The error string is asserted rather than ignored, so a 409 for any OTHER
 * reason still fails the test loudly — that matters now that HS-9576 made this
 * endpoint report the empty-cluster guard's refusal with the same status.
 */
async function backupNow(request: APIRequestContext, headers: Record<string, string>): Promise<BackupInfo> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request.post('/api/backups/now', { headers });
    if (res.ok()) return await res.json() as BackupInfo;
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Backup already in progress');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('HS-9589 — the in-flight backup never cleared after 10s');
}

test.describe('Backup and restore (HS-5186)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('manual backup creates a backup and it appears in the list', async ({ request }) => {
    const backup = await backupNow(request, headers);
    expect(backup.filename).toBeTruthy();
    expect(backup.tier).toBe('5min');

    // Verify it appears in the list
    const listRes = await request.get('/api/backups', { headers });
    const { backups } = await listRes.json() as { backups: { filename: string }[] };
    expect(backups.some(b => b.filename === backup.filename)).toBe(true);
  });

  test('preview endpoint returns tickets and stats from the backup', async ({ request }) => {
    // Create a ticket so there's data
    await request.post('/api/tickets', { headers, data: { title: 'Backup content test' } });

    // Create a backup
    const backup = await backupNow(request, headers);

    // Load the preview
    const previewRes = await request.get(`/api/backups/preview/${backup.tier}/${backup.filename}`, { headers });
    expect(previewRes.ok()).toBe(true);
    const preview = await previewRes.json() as { tickets: unknown[]; stats: { total: number } };
    expect(preview.tickets.length).toBeGreaterThan(0);
    expect(preview.stats.total).toBeGreaterThan(0);
  });

  // Restore is not e2e-testable — it closes and replaces the live PGLite
  // database while the server is serving requests. Covered by unit tests
  // (src/routes/backups.test.ts) and manual test plan (docs/manual-test-plan.md §9).
});
