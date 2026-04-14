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

  // Restore is not e2e-testable — it closes and replaces the live PGLite
  // database while the server is serving requests. Covered by unit tests
  // (src/routes/backups.test.ts) and manual test plan (docs/manual-test-plan.md §9).
});
