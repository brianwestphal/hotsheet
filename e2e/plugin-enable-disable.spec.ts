/**
 * HS-5064: plugin enable/disable per project + bulk operations + cleanup.
 *
 * User expectation: "each project decides for itself which plugins are active.
 * When I disable a plugin, its junk is cleaned up for that project but other
 * projects are unaffected."
 */
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

test.describe('Plugin enable/disable per project + bulk (HS-5064)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  test.setTimeout(120_000);

  let headersA: Record<string, string> = {};
  let secretA = '';
  let secretB = '';
  let tempDirB = '';

  test.beforeAll(async ({ request }) => {
    // Project A: the main test project (already registered)
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string; dataDir: string }[];
    secretA = projects[0]?.secret ?? '';
    headersA = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secretA };

    // Configure plugin for Project A
    await request.post('/api/plugins/github-issues/global-config', {
      headers: headersA, data: { key: 'token', value: GITHUB_TOKEN },
    });
    await request.patch('/api/settings', {
      headers: headersA,
      data: { 'plugin:github-issues:owner': GITHUB_OWNER, 'plugin:github-issues:repo': GITHUB_REPO },
    });

    // Register Project B (temp dir)
    tempDirB = join(tmpdir(), `hs-test-projB-${Date.now()}`);
    mkdirSync(join(tempDirB, '.hotsheet'), { recursive: true });
    const regRes = await request.post('/api/projects/register', {
      headers: headersA, data: { dataDir: join(tempDirB, '.hotsheet') },
    });
    expect(regRes.ok()).toBe(true);
    const regBody = await regRes.json() as { secret: string };
    secretB = regBody.secret;
  });

  test.afterAll(async ({ request }) => {
    // Re-enable plugin on Project A in case tests left it disabled
    try {
      await request.post('/api/plugins/github-issues/enable', { headers: headersA });
    } catch { /* ignore */ }
    // Unregister Project B
    if (secretB) {
      try {
        await request.delete(`/api/projects/${encodeURIComponent(secretB)}`, { headers: headersA });
      } catch { /* ignore */ }
    }
    if (tempDirB) {
      try { rmSync(tempDirB, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function headersFor(secret: string): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  }

  test('disable on Project A cleans up sync records; Project B is unaffected', async ({ request }) => {
    const hA = headersFor(secretA);
    const hB = headersFor(secretB);

    // Ensure enabled on both projects
    await request.post('/api/plugins/github-issues/enable', { headers: hA });
    await request.post('/api/plugins/github-issues/enable', { headers: hB });

    // Sync Project A so it has sync records
    await request.post('/api/plugins/github-issues/sync', { headers: hA });

    // Verify Project A has sync records
    const recordsBeforeA = await request.get('/api/plugins/github-issues/sync', { headers: hA });
    const recsA = await recordsBeforeA.json() as unknown[];
    expect(recsA.length).toBeGreaterThan(0);

    // Disable on Project A
    await request.post('/api/plugins/github-issues/disable', { headers: hA });

    // Project A: sync records should be cleaned up
    const recordsAfterA = await request.get('/api/plugins/github-issues/sync', { headers: hA });
    const recsAfterA = await recordsAfterA.json() as unknown[];
    expect(recsAfterA.length).toBe(0);

    // Project A: sync map should be empty
    const mapA = await request.get('/api/sync/tickets', { headers: hA });
    expect(Object.keys(await mapA.json() as Record<string, unknown>).length).toBe(0);

    // Project B: plugin should still be enabled
    const pluginB = await request.get('/api/plugins/github-issues', { headers: hB });
    const pluginBData = await pluginB.json() as { enabled: boolean };
    expect(pluginBData.enabled).toBe(true);

    // Re-enable A for subsequent tests
    await request.post('/api/plugins/github-issues/enable', { headers: hA });
  });

  test('enable-all enables the plugin across all projects', async ({ request }) => {
    const hA = headersFor(secretA);
    const hB = headersFor(secretB);

    // Disable on both first
    await request.post('/api/plugins/github-issues/disable', { headers: hA });
    await request.post('/api/plugins/github-issues/disable', { headers: hB });

    // Verify both disabled
    const beforeA = await (await request.get('/api/plugins/github-issues', { headers: hA })).json() as { enabled: boolean };
    const beforeB = await (await request.get('/api/plugins/github-issues', { headers: hB })).json() as { enabled: boolean };
    expect(beforeA.enabled).toBe(false);
    expect(beforeB.enabled).toBe(false);

    // Enable all
    await request.post('/api/plugins/github-issues/enable-all', { headers: hA });

    // Both should now be enabled
    const afterA = await (await request.get('/api/plugins/github-issues', { headers: hA })).json() as { enabled: boolean };
    const afterB = await (await request.get('/api/plugins/github-issues', { headers: hB })).json() as { enabled: boolean };
    expect(afterA.enabled).toBe(true);
    expect(afterB.enabled).toBe(true);
  });

  test('disable-all disables the plugin across all projects', async ({ request }) => {
    const hA = headersFor(secretA);
    const hB = headersFor(secretB);

    // Ensure enabled on both
    await request.post('/api/plugins/github-issues/enable', { headers: hA });
    await request.post('/api/plugins/github-issues/enable', { headers: hB });

    // Disable all
    await request.post('/api/plugins/github-issues/disable-all', { headers: hA });

    // Both should be disabled
    const afterA = await (await request.get('/api/plugins/github-issues', { headers: hA })).json() as { enabled: boolean };
    const afterB = await (await request.get('/api/plugins/github-issues', { headers: hB })).json() as { enabled: boolean };
    expect(afterA.enabled).toBe(false);
    expect(afterB.enabled).toBe(false);

    // Re-enable for cleanup
    await request.post('/api/plugins/github-issues/enable', { headers: hA });
  });

  test('disabled state persists across page reloads', async ({ page, request }) => {
    const hA = headersFor(secretA);

    // Disable
    await request.post('/api/plugins/github-issues/disable', { headers: hA });

    // Reload page and check via API (simulates "persist across restart")
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const pluginRes = await request.get('/api/plugins/github-issues', { headers: hA });
    const plugin = await pluginRes.json() as { enabled: boolean };
    expect(plugin.enabled).toBe(false);

    // Re-enable
    await request.post('/api/plugins/github-issues/enable', { headers: hA });
  });
});
