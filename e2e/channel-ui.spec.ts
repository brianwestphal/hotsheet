/**
 * HS-5188: Claude Channel UI tests that don't require a running channel server.
 *
 * Items 3-12 (play button click, auto mode, permissions overlay, etc.) need a
 * running Claude channel server and are covered in the manual test plan.
 * These tests cover the UI state management that can be tested without Claude.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Claude Channel UI (HS-5188)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  });

  test.afterAll(async ({ request }) => {
    // Disable channel after tests to clean up
    try {
      await request.post('/api/channel/disable', { headers });
    } catch { /* ignore */ }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('enabling channel makes play button visible in sidebar', async ({ page, request }) => {
    // Disable first to ensure a known state
    await request.post('/api/channel/disable', { headers });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Play section should be hidden when channel is disabled
    const playSection = page.locator('#channel-play-section');
    await expect(playSection).toBeHidden();

    // Enable the channel
    await request.post('/api/channel/enable', { headers });

    // Reload to pick up the new state
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Play section should now be visible (display != none)
    // Note: the play button visibility also depends on Claude CLI version check,
    // which may hide it if Claude isn't installed. Check both cases.
    const claudeCheck = await request.get('/api/channel/claude-check', { headers });
    const { meetsMinimum } = await claudeCheck.json() as { meetsMinimum: boolean };

    if (meetsMinimum) {
      await expect(playSection).toBeVisible({ timeout: 5000 });
      // The play button itself should be inside
      await expect(page.locator('#channel-play-btn')).toBeVisible();
    } else {
      // Claude CLI not installed or too old — play section may be hidden
      // This is correct behavior per §12 ("Channel hidden if Claude CLI < v2.1.80")
    }
  });

  test('channel status endpoint reflects enable/disable', async ({ request }) => {
    await request.post('/api/channel/enable', { headers });
    const enabled = await (await request.get('/api/channel/status', { headers })).json() as { enabled: boolean };
    expect(enabled.enabled).toBe(true);

    await request.post('/api/channel/disable', { headers });
    const disabled = await (await request.get('/api/channel/status', { headers })).json() as { enabled: boolean };
    expect(disabled.enabled).toBe(false);
  });

  test('channel version check reports Claude CLI availability', async ({ request }) => {
    const res = await request.get('/api/channel/claude-check', { headers });
    expect(res.ok()).toBe(true);
    const data = await res.json() as { installed: boolean; version: string | null; meetsMinimum: boolean };
    expect(typeof data.installed).toBe('boolean');
    expect(typeof data.meetsMinimum).toBe('boolean');
    // If installed, version should be a semver string
    if (data.installed) {
      expect(data.version).toBeTruthy();
      expect(data.version).toMatch(/\d+\.\d+/);
    }
  });
});
