/**
 * HS-9136 — functional e2e for the worker-pool + in-flight panels (docs 89–92,
 * 100–106). These cover the UI wiring that does NOT require spawning real
 * worktree workers: the sidebar entry buttons gate on the channel, the pool
 * panel opens read-only (GET /workers/pool) with an empty state + correctly
 * disabled stepper/drain controls at target 0, and the in-flight panel opens
 * with its empty state. Real worker execution + the drain/launch reconcile loop
 * are manual-test-plan / integration territory.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Worker pool + in-flight panels (HS-9136)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  });

  test.afterAll(async ({ request }) => {
    try { await request.post('/api/channel/disable', { headers }); } catch { /* ignore */ }
  });

  test('worker-action buttons are hidden until the channel is enabled, then visible', async ({ page, request }) => {
    await request.post('/api/channel/disable', { headers });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#sidebar-worker-actions')).toBeHidden();

    await request.post('/api/channel/enable', { headers });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('#sidebar-worker-actions')).toBeVisible();
    await expect(page.locator('#sidebar-worker-pool-btn')).toBeVisible();
    await expect(page.locator('#sidebar-inflight-btn')).toBeVisible();
  });

  test('worker pool panel opens read-only with empty state + disabled controls at target 0', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#sidebar-worker-pool-btn').click();

    const overlay = page.locator('.worker-pool-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.worker-pool-title')).toHaveText('Worker Pool');
    await expect(overlay.locator('.worker-pool-empty')).toContainText('No workers');

    // At target 0: count shows 0, step-down + drain-all disabled, step-up enabled.
    await expect(overlay.locator('.worker-pool-target')).toHaveText('0');
    await expect(overlay.locator('.worker-pool-step-down')).toBeDisabled();
    await expect(overlay.locator('.worker-pool-drain-all')).toBeDisabled();
    await expect(overlay.locator('.worker-pool-step-up')).toBeEnabled();

    // Close button dismisses the overlay.
    await overlay.locator('.worker-pool-close').click();
    await expect(overlay).toBeHidden();
  });

  test('in-flight panel opens with its empty state', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#sidebar-inflight-btn').click();

    const overlay = page.locator('.inflight-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.inflight-title')).toHaveText('In-flight work');
    await expect(overlay.locator('.inflight-empty')).toContainText('No tickets are currently being worked');

    await overlay.locator('.inflight-close').click();
    await expect(overlay).toBeHidden();
  });
});
