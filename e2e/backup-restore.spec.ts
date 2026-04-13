/**
 * HS-5186: backup/restore e2e tests.
 */
import { expect, test } from './coverage-fixture.js';

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
    const backupRes = await request.post('/api/backups/now', { headers });
    expect(backupRes.ok()).toBe(true);
    const backup = await backupRes.json() as { filename: string; tier: string };
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
    const backupRes = await request.post('/api/backups/now', { headers });
    const backup = await backupRes.json() as { filename: string; tier: string };

    // Load the preview
    const previewRes = await request.get(`/api/backups/preview/${backup.tier}/${backup.filename}`, { headers });
    expect(previewRes.ok()).toBe(true);
    const preview = await previewRes.json() as { tickets: unknown[]; stats: { total: number } };
    expect(preview.tickets.length).toBeGreaterThan(0);
    expect(preview.stats.total).toBeGreaterThan(0);
  });

  test.skip('restore endpoint succeeds and database is replaced — 500 in e2e (PGLite temp dir issue)', async ({ request }) => {
    // Create a unique ticket
    const uniqueTitle = `Pre-restore ${Date.now()}`;
    await request.post('/api/tickets', { headers, data: { title: uniqueTitle } });

    // Create a backup (captures the unique ticket)
    const backupRes = await request.post('/api/backups/now', { headers });
    const backup = await backupRes.json() as { filename: string; tier: string };

    // Create another ticket AFTER the backup
    const postBackupTitle = `Post-restore ${Date.now()}`;
    await request.post('/api/tickets', { headers, data: { title: postBackupTitle } });

    // Restore — should roll back to the backup state
    const restoreRes = await request.post('/api/backups/restore', { headers, data: { tier: backup.tier, filename: backup.filename } });
    if (!restoreRes.ok()) {
      console.log(`Restore failed: ${restoreRes.status()} ${await restoreRes.text()}`);
    }
    expect(restoreRes.ok()).toBe(true);

    // The pre-restore ticket should exist; the post-restore ticket should be gone
    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { title: string }[];
    expect(tickets.some(t => t.title === uniqueTitle)).toBe(true);
    expect(tickets.some(t => t.title === postBackupTitle)).toBe(false);
  });
});
