/**
 * HS-5059: sync_direction modes, auto_sync_new preference.
 * Scheduled-sync firing is covered as a unit test in syncEngine.test.ts
 * (short interval, deterministic) since 1-minute minimum via the public
 * schedule endpoint is too slow for e2e.
 */
import type { APIRequestContext } from '@playwright/test';

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

test.describe('GitHub plugin — sync triggers & direction modes (HS-5059)', () => {
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
    // Reset sync_direction to default and auto_sync_new to default so we don't
    // pollute later test runs.
    try {
      await request.patch('/api/settings', {
        headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': headers['X-Hotsheet-Secret'] },
        data: {
          'plugin:github-issues:sync_direction': 'bidirectional',
          'plugin:github-issues:auto_sync_new': 'false',
        },
      });
      await request.post('/api/plugins/github-issues/reactivate', { headers });
    } catch { /* ignore */ }

    for (const id of createdRemoteIds) {
      try {
        await ghRequest('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' });
      } catch { /* ignore */ }
    }
  });

  async function setSyncDirection(request: APIRequestContext, mode: 'bidirectional' | 'pull_only' | 'push_only') {
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:sync_direction': mode },
    });
    // Force reactivation so the backend picks up the new capabilities.
    await request.post('/api/plugins/github-issues/reactivate', { headers });
  }

  // --- sync_direction ---

  test('pull_only: push-ticket is rejected; local edits do not reach GitHub', async ({ request }) => {
    await setSyncDirection(request, 'pull_only');

    // Creating a new local ticket and attempting push-ticket must fail —
    // the route's capabilities.create guard returns 400.
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `pull_only push ${Date.now()}`, defaults: { details: 'rejected' } },
    });
    const ticket = await createRes.json() as { id: number };
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    expect(pushRes.status()).toBe(400);
    const body = await pushRes.json() as { error?: string };
    expect(body.error ?? '').toMatch(/does not support creating|push disabled/i);

    // A full sync in pull_only mode must also not push local edits.
    // Create a synced ticket under bidirectional first, then flip to pull_only.
    await setSyncDirection(request, 'bidirectional');
    const create2 = await request.post('/api/tickets', {
      headers, data: { title: `pull_only edit ${Date.now()}`, defaults: { details: 'seed' } },
    });
    const ticket2 = await create2.json() as { id: number };
    const push2 = await request.post(`/api/plugins/github-issues/push-ticket/${ticket2.id}`, { headers });
    const push2Result = await push2.json() as { remoteId: string };
    createdRemoteIds.push(push2Result.remoteId);

    // Flip to pull_only and edit locally
    await setSyncDirection(request, 'pull_only');
    const editedDetails = `pull_only should not propagate ${Date.now()}`;
    await request.patch(`/api/tickets/${ticket2.id}`, {
      headers, data: { details: editedDetails },
    });
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const syncResult = await syncRes.json() as { pushed?: number };
    expect(syncResult.pushed ?? 0).toBe(0);

    // GitHub should still show the original body.
    const ghIssue = await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${push2Result.remoteId}`) as { body: string };
    expect(ghIssue.body).not.toBe(editedDetails);

    // Reset
    await setSyncDirection(request, 'bidirectional');
  });

  test('push_only: pullChanges returns empty even with new remote issues', async ({ request }) => {
    await setSyncDirection(request, 'push_only');

    // Create a brand-new GitHub issue directly
    const uniqueTitle = `HS5059 push_only ${Date.now()}`;
    const issue = await ghRequest(
      'POST',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
      { title: uniqueTitle, body: 'should not pull' },
    ) as { number: number };
    createdRemoteIds.push(String(issue.number));

    // Sync — in push_only mode, pullChanges returns [], so pulled=0 and no
    // local ticket should appear with this title.
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const syncResult = await syncRes.json() as { pulled?: number };
    expect(syncResult.pulled ?? 0).toBe(0);

    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { title: string }[];
    expect(tickets.find(t => t.title === uniqueTitle)).toBeUndefined();

    await setSyncDirection(request, 'bidirectional');
  });

  // --- auto_sync_new ---

  test('auto_sync_new=true: new local tickets are auto-queued and pushed on next sync', async ({ request }) => {
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:auto_sync_new': 'true' },
    });
    await request.post('/api/plugins/github-issues/reactivate', { headers });

    // Seed a sync record so onTicketCreated's "only auto-create if there are
    // already synced tickets" legacy branch doesn't apply — with shouldAutoSync
    // returning true, auto_sync_new runs regardless. Either way we need at
    // least one sync to have happened. Just do a sync to baseline.
    await request.post('/api/plugins/github-issues/sync', { headers });

    const uniqueTitle = `auto_sync true ${Date.now()}`;
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: uniqueTitle, defaults: { details: 'auto' } },
    });
    const ticket = await createRes.json() as { id: number };

    // Sync — the outbox create entry queued by onTicketCreated should fire.
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Verify a sync record now exists for this ticket.
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === ticket.id);
    expect(record, 'auto_sync_new=true should have pushed the new ticket on next sync').toBeTruthy();
    if (record) createdRemoteIds.push(record.remote_id);
  });

  test('auto_sync_new=false: new local tickets are NOT auto-pushed', async ({ request }) => {
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:auto_sync_new': 'false' },
    });
    await request.post('/api/plugins/github-issues/reactivate', { headers });

    const uniqueTitle = `auto_sync false ${Date.now()}`;
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: uniqueTitle, defaults: { details: 'manual only' } },
    });
    const ticket = await createRes.json() as { id: number };

    await request.post('/api/plugins/github-issues/sync', { headers });

    // Verify NO sync record for this ticket.
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number }[];
    expect(records.find(r => r.ticket_id === ticket.id)).toBeUndefined();
  });
});
