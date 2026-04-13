/**
 * HS-5055: end-to-end conflict resolution.
 *
 * User expectation: "if I edit a ticket and someone else edits the same field
 * on GitHub, Hot Sheet shows me a conflict and lets me choose which side wins,
 * and the choice actually sticks on both sides."
 *
 * The existing sync-verify tests DETECT a conflict but never exercise either
 * resolution path. These tests cover the full lifecycle:
 *   - conflict detection stores conflict_data + surfaces via /sync/conflicts
 *   - keep_local immediately pushes local value to GitHub and clears the conflict
 *   - keep_remote applies remote value locally without pushing it back (no churn)
 *   - resolved conflicts disappear from /sync/conflicts
 *   - subsequent no-op syncs produce 0 conflicts and 0 pushes
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

async function ghGet(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghPatch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

test.describe('GitHub plugin — conflict resolution end-to-end (HS-5055)', () => {
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

  test.afterAll(async () => {
    for (const id of createdRemoteIds) {
      try {
        await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' });
      } catch { /* ignore */ }
    }
  });

  /** Create a ticket, push to GitHub, sync to baseline. Returns ids + baseline title. */
  async function createSyncedTicket(
    request: APIRequestContext,
    baselineTitle: string,
  ): Promise<{ localId: number; remoteId: string }> {
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: baselineTitle, defaults: { details: 'baseline' } },
    });
    const ticket = await createRes.json() as { id: number };
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    const pushResult = await pushRes.json() as { remoteId: string };
    createdRemoteIds.push(pushResult.remoteId);
    // Sync once to stabilize timestamps before we force a conflict.
    await request.post('/api/plugins/github-issues/sync', { headers });
    return { localId: ticket.id, remoteId: pushResult.remoteId };
  }

  /** Force a conflict by editing local + remote in parallel, then sync. */
  async function forceConflict(
    request: APIRequestContext,
    localId: number,
    remoteId: string,
    localTitle: string,
    remoteTitle: string,
  ): Promise<void> {
    await request.patch(`/api/tickets/${localId}`, { headers, data: { title: localTitle } });
    // Wait so GitHub's updated_at advances past our last_synced_at
    await new Promise(r => setTimeout(r, 2000));
    await ghPatch(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`,
      { title: remoteTitle },
    );
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const result = await syncRes.json() as { conflicts?: number };
    expect(result.conflicts ?? 0).toBeGreaterThanOrEqual(1);
  }

  test('conflict detection surfaces via /sync/conflicts with both sides captured', async ({ request }) => {
    const { localId, remoteId } = await createSyncedTicket(request, `conflict detect ${Date.now()}`);
    const localTitle = `local-edit ${Date.now()}`;
    const remoteTitle = `remote-edit ${Date.now()}`;
    await forceConflict(request, localId, remoteId, localTitle, remoteTitle);

    // Conflict appears in the list endpoint
    const conflictsRes = await request.get('/api/sync/conflicts', { headers });
    const conflicts = await conflictsRes.json() as {
      ticket_id: number; plugin_id: string; sync_status: string; conflict_data: string;
    }[];
    const conflict = conflicts.find(c => c.ticket_id === localId);
    expect(conflict).toBeTruthy();
    expect(conflict!.plugin_id).toBe('github-issues');
    expect(conflict!.sync_status).toBe('conflict');

    // Conflict data includes both local and remote snapshots.
    const data = JSON.parse(conflict!.conflict_data) as {
      local: { title: string }; remote: { title: string };
    };
    expect(data.local.title).toBe(localTitle);
    expect(data.remote.title).toBe(remoteTitle);
  });

  test('keep_local pushes local value to GitHub immediately and clears conflict', async ({ request }) => {
    const { localId, remoteId } = await createSyncedTicket(request, `keep-local baseline ${Date.now()}`);
    const localTitle = `keep-local wins ${Date.now()}`;
    const remoteTitle = `keep-local loses ${Date.now()}`;
    await forceConflict(request, localId, remoteId, localTitle, remoteTitle);

    // Resolve keep_local
    const resolveRes = await request.post(`/api/sync/conflicts/${localId}/resolve`, {
      headers, data: { plugin_id: 'github-issues', resolution: 'keep_local' },
    });
    expect(resolveRes.ok()).toBe(true);

    // GitHub now reflects the local value.
    // Allow a moment for GitHub to process the PATCH.
    await new Promise(r => setTimeout(r, 1000));
    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`) as { title: string };
    expect(ghIssue.title).toBe(localTitle);

    // Sync status is no longer 'conflict'
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; sync_status: string }[];
    const record = records.find(r => r.ticket_id === localId);
    expect(record!.sync_status).toBe('synced');

    // The conflict is gone from the list
    const conflictsRes = await request.get('/api/sync/conflicts', { headers });
    const remainingConflicts = await conflictsRes.json() as { ticket_id: number }[];
    expect(remainingConflicts.find(c => c.ticket_id === localId)).toBeUndefined();

    // Subsequent no-op sync: 0 new conflicts, 0 pushes.
    const noop = await (await request.post('/api/plugins/github-issues/sync', { headers })).json() as { conflicts?: number; pushed?: number };
    expect(noop.conflicts ?? 0).toBe(0);
    expect(noop.pushed ?? 0).toBe(0);
  });

  test('keep_remote applies remote value locally without pushing back (no churn)', async ({ request }) => {
    const { localId, remoteId } = await createSyncedTicket(request, `keep-remote baseline ${Date.now()}`);
    const localTitle = `keep-remote loses ${Date.now()}`;
    const remoteTitle = `keep-remote wins ${Date.now()}`;
    await forceConflict(request, localId, remoteId, localTitle, remoteTitle);

    // Resolve keep_remote
    const resolveRes = await request.post(`/api/sync/conflicts/${localId}/resolve`, {
      headers, data: { plugin_id: 'github-issues', resolution: 'keep_remote' },
    });
    expect(resolveRes.ok()).toBe(true);

    // Local ticket now shows the remote title.
    const localRes = await request.get(`/api/tickets/${localId}`, { headers });
    const local = await localRes.json() as { title: string };
    expect(local.title).toBe(remoteTitle);

    // The conflict is gone.
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; sync_status: string }[];
    expect(records.find(r => r.ticket_id === localId)!.sync_status).toBe('synced');

    // GitHub still shows remote title (not pushed back).
    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`) as { title: string };
    expect(ghIssue.title).toBe(remoteTitle);

    // Crucially: next sync should NOT push anything back (no churn).
    // If the sync record wasn't re-baselined after keep_remote, direct-compare
    // would see local_updated_at stale and re-push the same values.
    const noop1 = await (await request.post('/api/plugins/github-issues/sync', { headers })).json() as { conflicts?: number; pushed?: number };
    expect(noop1.pushed ?? 0).toBe(0);
    expect(noop1.conflicts ?? 0).toBe(0);

    // And one more to prove steady state.
    const noop2 = await (await request.post('/api/plugins/github-issues/sync', { headers })).json() as { conflicts?: number; pushed?: number };
    expect(noop2.pushed ?? 0).toBe(0);
    expect(noop2.conflicts ?? 0).toBe(0);
  });
});
