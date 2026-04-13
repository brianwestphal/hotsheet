/**
 * HS-5061: per-route reactivation regression suite.
 *
 * HS-5017 shipped because the /action route didn't reactivate before invoking
 * the backend — closure-captured settings went stale. The fix was to call
 * reactivatePlugin() inside every backend-using route. These tests lock that
 * contract in: for each route that uses the backend, mutate a setting via
 * /api/settings WITHOUT calling /reactivate, then call the route, and assert
 * the route saw the new setting.
 *
 * If any of these tests fail, production has regressed and a plugin endpoint
 * is ignoring the user's latest config until they manually reactivate.
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

test.describe('Plugin endpoints reactivate before using the backend (HS-5061)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  test.setTimeout(120_000);

  let headers: Record<string, string> = {};
  const bogusOwner = 'definitely-not-a-real-owner-hs5061';

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };

    await request.post('/api/plugins/github-issues/global-config', {
      headers, data: { key: 'token', value: GITHUB_TOKEN },
    });
    await request.patch('/api/settings', {
      headers,
      data: { 'plugin:github-issues:owner': GITHUB_OWNER, 'plugin:github-issues:repo': GITHUB_REPO },
    });
  });

  test.afterEach(async ({ request }) => {
    // Each test deliberately corrupts a setting. Always restore before the next test.
    try {
      await request.patch('/api/settings', {
        headers,
        data: { 'plugin:github-issues:owner': GITHUB_OWNER, 'plugin:github-issues:repo': GITHUB_REPO },
      });
    } catch { /* ignore */ }
  });

  async function setBogusOwner(request: APIRequestContext) {
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:owner': bogusOwner },
    });
  }

  test('GET /plugins/:id/status sees fresh settings (no manual reactivate)', async ({ request }) => {
    // Baseline: should be connected.
    const before = await request.get('/api/plugins/github-issues/status', { headers });
    expect((await before.json() as { connected: boolean }).connected).toBe(true);

    // Mutate owner to a bogus value without reactivating.
    await setBogusOwner(request);

    // Status should now report disconnected — proving it re-read the setting.
    const after = await request.get('/api/plugins/github-issues/status', { headers });
    const afterBody = await after.json() as { connected: boolean };
    expect(afterBody.connected).toBe(false);
  });

  test('POST /plugins/:id/sync sees fresh settings (no manual reactivate)', async ({ request }) => {
    await setBogusOwner(request);

    // Sync must fail (owner is bogus → GitHub 404 or similar). The route
    // itself should reactivate before running sync. Old behavior: the cached
    // backend would still use the correct owner and the sync would succeed,
    // hiding the config change.
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const result = await syncRes.json() as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/404|Not Found|Pull failed|Push failed|gone|deleted/i);
  });

  test('POST /plugins/:id/action test_connection sees fresh settings (no manual reactivate)', async ({ request }) => {
    // Baseline assertion.
    const baseline = await request.post('/api/plugins/github-issues/action', {
      headers, data: { actionId: 'test_connection' },
    });
    expect((await baseline.json() as { result: { connected: boolean } }).result.connected).toBe(true);

    await setBogusOwner(request);

    const mutated = await request.post('/api/plugins/github-issues/action', {
      headers, data: { actionId: 'test_connection' },
    });
    const mutatedBody = await mutated.json() as { result: { connected: boolean } };
    expect(mutatedBody.result.connected).toBe(false);
  });

  test('POST /plugins/:id/push-ticket sees fresh settings (no manual reactivate)', async ({ request }) => {
    await setBogusOwner(request);

    // Create a local ticket and try to push. With the bogus owner, the
    // underlying createRemote call will 404 (repo doesn't exist). If push-ticket
    // isn't reactivating, it would use the old cached owner and succeed.
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `HS5061 push ${Date.now()}`, defaults: { details: 'should fail' } },
    });
    const ticket = await createRes.json() as { id: number };
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    // The route wraps createRemote in a try/catch for missing prefs, but not
    // for backend errors, so the response is 500 with the error message.
    expect(pushRes.ok()).toBe(false);
  });
});
