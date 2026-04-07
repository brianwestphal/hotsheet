import { expect, test } from './coverage-fixture.js';

/** POST helper that includes Origin header so the secret middleware allows the request. */
async function apiPost(page: import('@playwright/test').Page, path: string) {
  return page.request.post(path, {
    headers: { Origin: 'http://localhost:4190' },
  });
}

test.describe('Channel API endpoints', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('GET /api/channel/status returns expected structure', async ({ page }) => {
    const res = await page.request.get('/api/channel/status');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('enabled');
    expect(data).toHaveProperty('alive');
    expect(data).toHaveProperty('port');
    expect(data).toHaveProperty('done');
    expect(typeof data.enabled).toBe('boolean');
    expect(typeof data.alive).toBe('boolean');
    expect(typeof data.done).toBe('boolean');
  });

  test('POST /api/channel/done returns ok', async ({ page }) => {
    // Post to done endpoint
    const doneRes = await apiPost(page, '/api/channel/done');
    expect(doneRes.ok()).toBe(true);
    const doneData = await doneRes.json();
    expect(doneData).toEqual({ ok: true });

    // Note: the done flag is consumed on first read, but the UI's long-poll
    // may read it before our test does, so we just verify the POST succeeds.
    // The consume-on-read behavior is verified in unit tests.
  });

  test('GET /api/channel/claude-check returns expected structure', async ({ page }) => {
    const res = await page.request.get('/api/channel/claude-check');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('installed');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('meetsMinimum');
    expect(typeof data.installed).toBe('boolean');
    expect(typeof data.meetsMinimum).toBe('boolean');

    if (data.installed) {
      // When claude CLI is available, version should be a string
      expect(typeof data.version).toBe('string');
    } else {
      // When not available, version is null
      expect(data.version).toBeNull();
    }
  });

  test('GET /api/channel/permission returns response with pending field', async ({ page }) => {
    // Permission endpoint is a long-poll (30s timeout). Wake it immediately so the test doesn't block.
    const resPromise = page.request.get('/api/channel/permission');
    await page.waitForTimeout(100);
    await page.request.post('/api/channel/permission/notify');
    const res = await resPromise;
    expect(res.ok()).toBe(true);
    const data = await res.json();
    // No channel server running, so pending should be null
    expect(data).toHaveProperty('pending');
    expect(data.pending).toBeNull();
  });
});
