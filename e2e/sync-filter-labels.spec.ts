/**
 * HS-5060 part (a): filter_labels preference.
 *
 * User expectation: "if I set filter_labels to 'bug', only GitHub issues
 * tagged 'bug' come into Hot Sheet."
 *
 * Rate-limit handling (part b) is covered as a plugin-level unit test — see
 * plugins/github-issues/src/index.test.ts.
 */
import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

async function ghRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

test.describe('GitHub plugin — filter_labels preference (HS-5060)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  test.setTimeout(180_000);

  let headers: Record<string, string> = {};
  const createdRemoteIds: string[] = [];

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

  test.afterAll(async ({ request }) => {
    try {
      await request.patch('/api/settings', {
        headers, data: { 'plugin:github-issues:filter_labels': '' },
      });
      await request.post('/api/plugins/github-issues/reactivate', { headers });
    } catch { /* ignore */ }
    for (const id of createdRemoteIds) {
      try {
        await ghRequest('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' });
      } catch { /* ignore */ }
    }
  });

  test('filter_labels pulls only issues with the matching label; clearing pulls all', async ({ request }) => {
    const filterLabel = `hs5060-${Date.now().toString(36)}`;
    const matchTitle = `HS5060 match ${Date.now()}`;
    const noMatchTitle = `HS5060 nomatch ${Date.now()}`;

    // Create two issues directly on GitHub: one with the filter label, one without.
    const matching = await ghRequest(
      'POST',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
      { title: matchTitle, body: 'has filter', labels: [filterLabel] },
    ) as { number: number };
    createdRemoteIds.push(String(matching.number));

    const nonMatching = await ghRequest(
      'POST',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
      { title: noMatchTitle, body: 'no filter' },
    ) as { number: number };
    createdRemoteIds.push(String(nonMatching.number));

    // Set filter_labels and reactivate so the plugin picks it up.
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:filter_labels': filterLabel },
    });
    await request.post('/api/plugins/github-issues/reactivate', { headers });

    // Sync. Only the matching issue should appear locally.
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { title: string }[];
    expect(tickets.find(t => t.title === matchTitle), 'matching issue should pull').toBeTruthy();
    expect(tickets.find(t => t.title === noMatchTitle), 'non-matching issue should NOT pull').toBeUndefined();

    // Clear the filter, reactivate, sync again — both should now appear.
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:filter_labels': '' },
    });
    await request.post('/api/plugins/github-issues/reactivate', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ticketsRes2 = await request.get('/api/tickets', { headers });
    const tickets2 = await ticketsRes2.json() as { title: string }[];
    expect(tickets2.find(t => t.title === matchTitle)).toBeTruthy();
    expect(tickets2.find(t => t.title === noMatchTitle), 'non-matching issue should now pull').toBeTruthy();
  });
});
