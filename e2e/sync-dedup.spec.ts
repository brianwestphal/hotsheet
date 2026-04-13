/**
 * HS-5058 part (a): title-based dedup on pull.
 *
 * User expectation: "if a GitHub issue is already in my Hot Sheet by title,
 * pulling shouldn't create a duplicate."
 *
 * Part (b) and (c) live in src/plugins/syncEngine.test.ts as unit tests
 * against the mock backend, since they're cleaner to exercise with stubs.
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

test.describe('GitHub plugin — title-based dedup on pull (HS-5058)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  test.setTimeout(120_000);

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

  test.afterAll(async () => {
    for (const id of createdRemoteIds) {
      try {
        await ghRequest('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' });
      } catch { /* ignore */ }
    }
  });

  test('existing local ticket with matching title links instead of duplicating on pull', async ({ request }) => {
    // 1. Create a local ticket (NOT synced).
    const sharedTitle = `HS5058 dedup ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: sharedTitle, defaults: { details: 'local first' } },
    });
    const localTicket = await createRes.json() as { id: number };

    // 2. Create a GitHub issue directly via the API with the same title.
    const issue = await ghRequest(
      'POST',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
      { title: sharedTitle, body: 'remote version' },
    ) as { number: number };
    createdRemoteIds.push(String(issue.number));

    // 3. Pull — the dedup logic should link the existing local ticket to the
    // new remote issue instead of creating a second local ticket.
    await request.post('/api/plugins/github-issues/sync', { headers });

    // 4. Verify: still only one local ticket with this title.
    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number; title: string }[];
    const matching = tickets.filter(t => t.title === sharedTitle);
    expect(matching.length).toBe(1);
    expect(matching[0].id).toBe(localTicket.id);

    // 5. Verify: the existing local ticket now has a sync record linking to the remote.
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === localTicket.id);
    expect(record).toBeTruthy();
    expect(record!.remote_id).toBe(String(issue.number));
  });
});
