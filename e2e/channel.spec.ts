import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/** POST helper that includes Origin header so the secret middleware allows the request. */
async function apiPost(page: Page, path: string) {
  // HS-9352 — derive the Origin from the page's actual URL (the per-worker
  // server's port), not a hard-coded 4190, so the CSRF Origin check matches.
  return page.request.post(path, {
    headers: { Origin: new URL(page.url()).origin },
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
    const data = await res.json() as { alive?: boolean; done?: boolean; enabled?: boolean; installed?: boolean; meetsMinimum?: boolean; version?: string; pending?: unknown };
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
    const doneData: unknown = await doneRes.json();
    expect(doneData).toEqual({ ok: true });

    // Note: the done flag is consumed on first read, but the UI's long-poll
    // may read it before our test does, so we just verify the POST succeeds.
    // The consume-on-read behavior is verified in unit tests.
  });

  test('GET /api/channel/claude-check returns expected structure', async ({ page }) => {
    const res = await page.request.get('/api/channel/claude-check');
    expect(res.ok()).toBe(true);
    const data = await res.json() as { alive?: boolean; done?: boolean; enabled?: boolean; installed?: boolean; meetsMinimum?: boolean; version?: string; pending?: unknown };
    expect(data).toHaveProperty('installed');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('meetsMinimum');
    expect(typeof data.installed).toBe('boolean');
    expect(typeof data.meetsMinimum).toBe('boolean');

    if (data.installed === true) {
      // When claude CLI is available, version should be a string
      expect(typeof data.version).toBe('string');
    } else {
      // When not available, version is null
      expect(data.version).toBeNull();
    }
  });

  test('GET /api/channel/permission returns response with pending field', async ({ page }) => {
    // Permission endpoint is a long-poll (3s timeout). Wake it immediately so the test doesn't block.
    const resPromise = page.request.get('/api/channel/permission');
    await page.waitForTimeout(100);
    await page.request.post('/api/channel/permission/notify');
    const res = await resPromise;
    expect(res.ok()).toBe(true);
    const data = await res.json() as { alive?: boolean; done?: boolean; enabled?: boolean; installed?: boolean; meetsMinimum?: boolean; version?: string; pending?: unknown };
    // No channel server running, so pending should be null
    expect(data).toHaveProperty('pending');
    expect(data.pending).toBeNull();
  });
});
