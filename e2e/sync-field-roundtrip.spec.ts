/**
 * HS-5054: per-field push/pull roundtrip coverage for the GitHub plugin.
 *
 * For each syncable field (title, details, category, priority, status, tags,
 * up_next, milestone), write a push test (edit locally → sync → read GitHub
 * API → assert remote has the new value) and a pull test (edit on GitHub →
 * sync → read local ticket → assert local has the new value).
 *
 * Read-back is mandatory: HS-5052 shipped because the existing push tests
 * trusted the local sync record instead of verifying the remote actually
 * received the data.
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: { name: string }[];
  milestone: { number: number; title: string } | null;
}

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

async function ghPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
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

/** Ensure a milestone exists in the test repo and return its number. */
async function ensureMilestone(title: string): Promise<number> {
  const existing = await ghGet(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/milestones?state=all&per_page=100`,
  ) as { number: number; title: string }[];
  const found = existing.find(m => m.title === title);
  if (found) return found.number;
  const created = await ghPost(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/milestones`,
    { title },
  ) as { number: number };
  return created.number;
}

test.describe('GitHub plugin — per-field roundtrip coverage (HS-5054)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  // Each test creates a fresh ticket + issue and hits the GitHub API several times.
  test.setTimeout(180_000);

  let projectSecret = '';
  let headers: Record<string, string> = {};
  const createdRemoteIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    projectSecret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projectSecret };

    await request.post('/api/plugins/github-issues/global-config', {
      headers, data: { key: 'token', value: GITHUB_TOKEN },
    });
    await request.patch('/api/settings', {
      headers,
      data: { 'plugin:github-issues:owner': GITHUB_OWNER, 'plugin:github-issues:repo': GITHUB_REPO },
    });
    // Intentionally NOT calling /reactivate — production endpoints should pick
    // up the new config on their own (HS-5017 regression guard).
  });

  test.afterAll(async () => {
    // Close every remote issue the suite created so the test repo stays tidy.
    for (const id of createdRemoteIds) {
      try {
        await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' });
      } catch { /* best effort */ }
    }
  });

  /** Create a local ticket and push it to GitHub. Returns local + remote IDs. */
  async function createAndPush(
    request: APIRequestContext,
    title: string,
    defaults: Record<string, unknown> = {},
  ): Promise<{ localId: number; remoteId: string }> {
    const createRes = await request.post('/api/tickets', {
      headers, data: { title, defaults },
    });
    const ticket = await createRes.json() as { id: number };
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    const pushResult = await pushRes.json() as { ok: boolean; remoteId: string };
    expect(pushResult.ok).toBe(true);
    createdRemoteIds.push(pushResult.remoteId);
    return { localId: ticket.id, remoteId: pushResult.remoteId };
  }

  /** Fetch and return a GitHub issue. */
  async function getIssue(remoteId: string): Promise<GitHubIssue> {
    return await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`) as GitHubIssue;
  }

  /** Run sync, auto-resolving any conflict by keeping remote (used when we
   *  deliberately edit GitHub after a baseline sync). */
  async function pullWithConflictResolve(request: APIRequestContext, localId: number) {
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const syncResult = await syncRes.json() as { conflicts?: number };
    if ((syncResult.conflicts ?? 0) > 0) {
      await request.post(`/api/sync/conflicts/${localId}/resolve`, {
        headers, data: { plugin_id: 'github-issues', resolution: 'keep_remote' },
      });
      await request.post('/api/plugins/github-issues/sync', { headers });
    }
  }

  // ---------- title ----------

  test('title: local edit pushes to GitHub; GitHub edit pulls into local', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `title rt ${Date.now()}`, { details: 'init' },
    );

    // Push side
    const newTitle = `title-pushed ${Date.now()}`;
    await request.patch(`/api/tickets/${localId}`, { headers, data: { title: newTitle } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    expect((await getIssue(remoteId)).title).toBe(newTitle);

    // Pull side
    await new Promise(r => setTimeout(r, 2000));
    const ghTitle = `title-from-gh ${Date.now()}`;
    await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`, { title: ghTitle });
    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { title: string };
    expect(local.title).toBe(ghTitle);
  });

  // ---------- details (body) ----------

  test('details: local edit pushes to GitHub; GitHub edit pulls into local', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `details rt ${Date.now()}`, { details: 'initial body' },
    );

    // Push side
    const newDetails = `body-pushed ${Date.now()}`;
    await request.patch(`/api/tickets/${localId}`, { headers, data: { details: newDetails } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    expect((await getIssue(remoteId)).body).toBe(newDetails);

    // Pull side
    await new Promise(r => setTimeout(r, 2000));
    const ghBody = `body-from-gh ${Date.now()}`;
    await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`, { body: ghBody });
    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { details: string };
    expect(local.details).toBe(ghBody);
  });

  // ---------- category ----------

  test('category: local edit pushes category:* label; remote label pulls into local', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `category rt ${Date.now()}`, { category: 'issue' },
    );

    // Push side: change category from issue → feature
    await request.patch(`/api/tickets/${localId}`, { headers, data: { category: 'feature' } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const issueAfterPush = await getIssue(remoteId);
    expect(issueAfterPush.labels.some(l => l.name === 'category:feature')).toBe(true);
    expect(issueAfterPush.labels.some(l => l.name === 'category:issue')).toBe(false);

    // Pull side: remove category:feature, add category:bug directly on GitHub
    await new Promise(r => setTimeout(r, 2000));
    const keptLabels = issueAfterPush.labels.map(l => l.name).filter(n => !n.startsWith('category:'));
    await ghPatch(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`,
      { labels: [...keptLabels, 'category:bug'] },
    );
    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { category: string };
    expect(local.category).toBe('bug');
  });

  // ---------- priority ----------

  test('priority: local non-default adds priority:* label; default adds none', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `priority rt ${Date.now()}`, { priority: 'default' },
    );

    // Default priority should NOT add a priority label on initial push.
    const afterCreate = await getIssue(remoteId);
    expect(afterCreate.labels.some(l => l.name.startsWith('priority:'))).toBe(false);

    // Bump to 'high' → priority:high label appears.
    await request.patch(`/api/tickets/${localId}`, { headers, data: { priority: 'high' } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const afterHigh = await getIssue(remoteId);
    expect(afterHigh.labels.some(l => l.name === 'priority:high')).toBe(true);

    // Back to default → priority:high label removed, no priority:* label present.
    await request.patch(`/api/tickets/${localId}`, { headers, data: { priority: 'default' } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const afterDefault = await getIssue(remoteId);
    expect(afterDefault.labels.some(l => l.name.startsWith('priority:'))).toBe(false);
  });

  test('priority: remote priority:* label pulls into local', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `priority pull ${Date.now()}`, { priority: 'default' },
    );
    // Sync to baseline so pull-side has a clean starting point
    await request.post('/api/plugins/github-issues/sync', { headers });
    await new Promise(r => setTimeout(r, 2000));

    // Add priority:lowest on GitHub
    const current = await getIssue(remoteId);
    const labels = [...current.labels.map(l => l.name), 'priority:lowest'];
    await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`, { labels });

    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { priority: string };
    expect(local.priority).toBe('lowest');
  });

  // ---------- status (state + label, lossless) ----------

  test('status: local edit sets both open/closed state AND status:* label', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `status rt ${Date.now()}`, { status: 'not_started' },
    );

    // not_started → open + status:not-started
    const initial = await getIssue(remoteId);
    expect(initial.state).toBe('open');
    expect(initial.labels.some(l => l.name === 'status:not-started')).toBe(true);

    // started → open + status:started
    await request.patch(`/api/tickets/${localId}`, { headers, data: { status: 'started' } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const started = await getIssue(remoteId);
    expect(started.state).toBe('open');
    expect(started.labels.some(l => l.name === 'status:started')).toBe(true);
    expect(started.labels.some(l => l.name === 'status:not-started')).toBe(false);

    // completed → closed + status:completed
    await request.patch(`/api/tickets/${localId}`, { headers, data: { status: 'completed' } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const completed = await getIssue(remoteId);
    expect(completed.state).toBe('closed');
    expect(completed.labels.some(l => l.name === 'status:completed')).toBe(true);
  });

  test('status: remote label change pulls into local (lossless read-back)', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `status pull ${Date.now()}`, { status: 'not_started' },
    );
    await request.post('/api/plugins/github-issues/sync', { headers });
    await new Promise(r => setTimeout(r, 2000));

    // Swap status:not-started → status:started on GitHub
    const current = await getIssue(remoteId);
    const labels = current.labels.map(l => l.name)
      .filter(n => n !== 'status:not-started')
      .concat('status:started');
    await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`, { labels });

    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { status: string };
    expect(local.status).toBe('started');
  });

  // ---------- tags (non-milestone) ----------

  test('tags: custom tags push as custom GitHub labels; new remote label pulls as tag', async ({ request }) => {
    const unique = Date.now().toString(36);
    const tagA = `hs5054-tag-a-${unique}`;
    const tagB = `hs5054-tag-b-${unique}`;
    const tagC = `hs5054-tag-c-${unique}`;

    const { localId, remoteId } = await createAndPush(
      request, `tags rt ${Date.now()}`, { tags: JSON.stringify([tagA, tagB]) },
    );

    // Push side: both tags should be present as labels on GitHub.
    const afterCreate = await getIssue(remoteId);
    const initialNames = afterCreate.labels.map(l => l.name);
    expect(initialNames).toContain(tagA);
    expect(initialNames).toContain(tagB);

    // Pull side: add tagC on GitHub, remove tagA.
    await new Promise(r => setTimeout(r, 2000));
    const keptLabels = initialNames.filter(n => n !== tagA);
    await ghPatch(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`,
      { labels: [...keptLabels, tagC] },
    );
    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { tags: string };
    const localTags = JSON.parse(local.tags) as string[];
    expect(localTags).toContain(tagB);
    expect(localTags).toContain(tagC);
    expect(localTags).not.toContain(tagA);
  });

  // ---------- up_next ----------

  test('up_next: local flag adds up-next label; remote label pulls into flag', async ({ request }) => {
    const { localId, remoteId } = await createAndPush(
      request, `upnext rt ${Date.now()}`, { up_next: false },
    );

    // Push side: set up_next=true → up-next label appears
    await request.patch(`/api/tickets/${localId}`, { headers, data: { up_next: true } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const afterSet = await getIssue(remoteId);
    expect(afterSet.labels.some(l => l.name === 'up-next')).toBe(true);

    // Push side: set up_next=false → up-next label removed
    await request.patch(`/api/tickets/${localId}`, { headers, data: { up_next: false } });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const afterUnset = await getIssue(remoteId);
    expect(afterUnset.labels.some(l => l.name === 'up-next')).toBe(false);

    // Pull side: add up-next on GitHub → local up_next becomes true
    await new Promise(r => setTimeout(r, 2000));
    const current = await getIssue(remoteId);
    await ghPatch(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`,
      { labels: [...current.labels.map(l => l.name), 'up-next'] },
    );
    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { up_next: boolean };
    expect(local.up_next).toBe(true);
  });

  // ---------- milestone ----------

  test('milestone: milestone:<name> tag sets/updates/clears GitHub milestone', async ({ request }) => {
    const ms1Name = `hs5054-ms1-${Date.now().toString(36)}`;
    const ms2Name = `hs5054-ms2-${Date.now().toString(36)}`;
    await ensureMilestone(ms1Name);
    await ensureMilestone(ms2Name);

    // Create a ticket with the first milestone tag
    const { localId, remoteId } = await createAndPush(
      request, `milestone rt ${Date.now()}`,
      { tags: JSON.stringify([`milestone:${ms1Name}`]) },
    );

    // After push: GitHub issue should have milestone set to ms1.
    const afterCreate = await getIssue(remoteId);
    expect(afterCreate.milestone?.title).toBe(ms1Name);

    // Update to ms2 locally, sync, verify remote milestone changes.
    await request.patch(`/api/tickets/${localId}`, {
      headers, data: { tags: JSON.stringify([`milestone:${ms2Name}`]) },
    });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const afterSwap = await getIssue(remoteId);
    expect(afterSwap.milestone?.title).toBe(ms2Name);

    // Clear milestone locally (empty tags), sync, verify remote milestone cleared.
    await request.patch(`/api/tickets/${localId}`, {
      headers, data: { tags: JSON.stringify([]) },
    });
    await request.post('/api/plugins/github-issues/sync', { headers });
    const afterClear = await getIssue(remoteId);
    expect(afterClear.milestone).toBeNull();
  });

  test('milestone: remote milestone change pulls into local tag', async ({ request }) => {
    const msName = `hs5054-pull-${Date.now().toString(36)}`;
    const msNum = await ensureMilestone(msName);

    const { localId, remoteId } = await createAndPush(
      request, `milestone pull ${Date.now()}`, {},
    );
    await request.post('/api/plugins/github-issues/sync', { headers });
    await new Promise(r => setTimeout(r, 2000));

    // Set the milestone directly on GitHub
    await ghPatch(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}`,
      { milestone: msNum },
    );

    await pullWithConflictResolve(request, localId);
    const local = await (await request.get(`/api/tickets/${localId}`, { headers })).json() as { tags: string };
    const localTags = JSON.parse(local.tags) as string[];
    expect(localTags).toContain(`milestone:${msName}`);
  });
});
