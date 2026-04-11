/**
 * Comprehensive sync verification tests.
 * These tests verify data integrity between Hot Sheet and GitHub after sync operations.
 * They read the actual GitHub API to confirm changes were applied correctly.
 */
import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

/** Direct GitHub API helper (bypasses the plugin, reads the truth). */
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
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

test.describe('Sync data integrity', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  // These tests make multiple GitHub API calls — need more time
  test.setTimeout(120_000);

  let projectSecret = '';
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    projectSecret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projectSecret };

    // Configure plugin
    await request.post('/api/plugins/github-issues/global-config', {
      headers, data: { key: 'token', value: GITHUB_TOKEN },
    });
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:owner': GITHUB_OWNER, 'plugin:github-issues:repo': GITHUB_REPO },
    });
    await request.post('/api/plugins/github-issues/reactivate', { headers });
  });

  test('push title change is reflected on GitHub', async ({ request }) => {
    // Sync to establish baseline
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Find a synced ticket
    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number; title: string }[];
    const syncMapRes = await request.get('/api/sync/tickets', { headers });
    const syncMap = await syncMapRes.json() as Record<string, { pluginId: string }>;
    const syncedTicket = tickets.find(t => syncMap[t.id]);
    if (!syncedTicket) { test.skip(); return; }

    // Get remote ID
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === syncedTicket.id);
    if (!record) { test.skip(); return; }

    // Change title locally
    const newTitle = `Sync verify title ${Date.now()}`;
    await request.patch(`/api/tickets/${syncedTicket.id}`, { headers, data: { title: newTitle } });

    // Sync to push
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const result = await syncRes.json();
    expect(result.ok).toBe(true);
    expect(result.pushed).toBeGreaterThanOrEqual(1);

    // Verify on GitHub directly
    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}`) as { title: string };
    expect(ghIssue.title).toBe(newTitle);
  });

  test('push details change is reflected on GitHub', async ({ request }) => {
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number }[];
    const syncMapRes = await request.get('/api/sync/tickets', { headers });
    const syncMap = await syncMapRes.json() as Record<string, { pluginId: string }>;
    const syncedTicket = tickets.find(t => syncMap[t.id]);
    if (!syncedTicket) { test.skip(); return; }

    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === syncedTicket.id);
    if (!record) { test.skip(); return; }

    const newDetails = `Sync verify details ${Date.now()}`;
    await request.patch(`/api/tickets/${syncedTicket.id}`, { headers, data: { details: newDetails } });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}`) as { body: string };
    expect(ghIssue.body).toBe(newDetails);
  });

  test('push status change sets correct labels and open/closed state', async ({ request }) => {
    // Create a fresh ticket to avoid state pollution from other tests
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `Status test ${Date.now()}`, defaults: { category: 'issue' } },
    });
    const ticket = await createRes.json() as { id: number };

    // Push to GitHub
    await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === ticket.id);
    if (!record) { test.skip(); return; }

    // Set to "completed" (should close the issue and set status:completed label)
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { status: 'completed' } });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}`) as {
      state: string; labels: { name: string }[];
    };
    expect(ghIssue.state).toBe('closed');
    expect(ghIssue.labels.some(l => l.name === 'status:completed')).toBe(true);
    // Category label should still be present
    expect(ghIssue.labels.some(l => l.name === 'category:issue')).toBe(true);
  });

  test('push preserves category label when only status changes', async ({ request }) => {
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number; category: string }[];
    const syncMapRes = await request.get('/api/sync/tickets', { headers });
    const syncMap = await syncMapRes.json() as Record<string, { pluginId: string }>;
    const syncedTicket = tickets.find(t => syncMap[t.id]);
    if (!syncedTicket) { test.skip(); return; }

    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === syncedTicket.id);
    if (!record) { test.skip(); return; }

    // Set category to "bug" first
    await request.patch(`/api/tickets/${syncedTicket.id}`, { headers, data: { category: 'bug' } });
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Now change only status
    await request.patch(`/api/tickets/${syncedTicket.id}`, { headers, data: { status: 'started' } });
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Verify category label is STILL present
    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}`) as {
      labels: { name: string }[];
    };
    expect(ghIssue.labels.some(l => l.name === 'category:bug')).toBe(true);
    expect(ghIssue.labels.some(l => l.name === 'status:started')).toBe(true);
  });

  test('pull remote title change updates local ticket', async ({ request }) => {
    // Create a fresh ticket and push to establish a clean sync record
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `Pull test ${Date.now()}`, defaults: { details: 'Initial' } },
    });
    const ticket = await createRes.json() as { id: number };
    await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });

    // Sync to update the sync record timestamps
    await request.post('/api/plugins/github-issues/sync', { headers });

    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === ticket.id);
    if (!record) { test.skip(); return; }

    // Wait briefly to ensure GitHub's updated_at advances past our sync timestamp
    await new Promise(r => setTimeout(r, 2000));

    // Change title directly on GitHub
    const ghTitle = `GitHub edit ${Date.now()}`;
    await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}`, { title: ghTitle });

    // Sync to pull the change
    const pullRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const pullResult = await pullRes.json();

    // If there was a conflict, the pull won't apply. Check and log.
    if ((pullResult.conflicts ?? 0) > 0) {
      // Resolve conflict by keeping remote
      await request.post(`/api/sync/conflicts/${ticket.id}/resolve`, {
        headers, data: { plugin_id: 'github-issues', resolution: 'keep_remote' },
      });
      // Sync again to apply
      await request.post('/api/plugins/github-issues/sync', { headers });
    }

    // Verify local ticket updated
    const updatedRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await updatedRes.json() as { title: string };
    expect(updated.title).toBe(ghTitle);
  });

  test('consecutive syncs without changes produce 0 conflicts and 0 pushes', async ({ request }) => {
    // First sync establishes baseline
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Second sync — nothing changed
    const sync2Res = await request.post('/api/plugins/github-issues/sync', { headers });
    const sync2 = await sync2Res.json();
    expect(sync2.ok).toBe(true);
    expect(sync2.conflicts ?? 0).toBe(0);
    expect(sync2.pushed ?? 0).toBe(0);

    // Third sync — still nothing
    const sync3Res = await request.post('/api/plugins/github-issues/sync', { headers });
    const sync3 = await sync3Res.json();
    expect(sync3.ok).toBe(true);
    expect(sync3.conflicts ?? 0).toBe(0);
    expect(sync3.pushed ?? 0).toBe(0);
  });

  test('push-then-pull roundtrip preserves all fields', async ({ request }) => {
    // Create a ticket with specific fields
    const createRes = await request.post('/api/tickets', {
      headers, data: {
        title: `Roundtrip test ${Date.now()}`,
        defaults: { details: 'Roundtrip details', category: 'bug', priority: 'high', status: 'started' },
      },
    });
    const ticket = await createRes.json() as { id: number };

    // Push to GitHub
    const pushRes = await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });
    expect(pushRes.ok()).toBe(true);

    // Sync to push field values
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Get remote ID
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === ticket.id);
    expect(record).toBeTruthy();

    // Verify on GitHub
    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record!.remote_id}`) as {
      title: string; body: string; state: string; labels: { name: string }[];
    };
    expect(ghIssue.body).toBe('Roundtrip details');
    expect(ghIssue.state).toBe('open'); // "started" maps to open
    expect(ghIssue.labels.some(l => l.name === 'category:bug')).toBe(true);
    expect(ghIssue.labels.some(l => l.name === 'priority:high')).toBe(true);
    expect(ghIssue.labels.some(l => l.name === 'status:started')).toBe(true);

    // Now pull — local should still match what we set
    await request.post('/api/plugins/github-issues/sync', { headers });
    const localRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const local = await localRes.json() as { title: string; details: string; category: string; priority: string; status: string };
    expect(local.details).toBe('Roundtrip details');
    expect(local.category).toBe('bug');
    expect(local.priority).toBe('high');
    expect(local.status).toBe('started');
  });

  test('note pushed as GitHub comment and visible', async ({ request }) => {
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number }[];
    const syncMapRes = await request.get('/api/sync/tickets', { headers });
    const syncMap = await syncMapRes.json() as Record<string, { pluginId: string }>;
    const syncedTicket = tickets.find(t => syncMap[t.id]);
    if (!syncedTicket) { test.skip(); return; }

    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === syncedTicket.id);
    if (!record) { test.skip(); return; }

    // Add a note locally
    const noteText = `E2E note ${Date.now()}`;
    await request.patch(`/api/tickets/${syncedTicket.id}`, { headers, data: { notes: noteText } });

    // Sync to push the note as a comment
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Verify comment exists on GitHub
    const comments = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}/comments`) as { body: string }[];
    expect(comments.some(c => c.body === noteText)).toBe(true);
  });

  test('sync does not duplicate comments on repeated syncs', async ({ request }) => {
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number }[];
    const syncMapRes = await request.get('/api/sync/tickets', { headers });
    const syncMap = await syncMapRes.json() as Record<string, { pluginId: string }>;
    const syncedTicket = tickets.find(t => syncMap[t.id]);
    if (!syncedTicket) { test.skip(); return; }

    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === syncedTicket.id);
    if (!record) { test.skip(); return; }

    // Count comments before
    const commentsBefore = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}/comments`) as unknown[];
    const countBefore = commentsBefore.length;

    // Sync three more times without changes
    await request.post('/api/plugins/github-issues/sync', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Count should be the same
    const commentsAfter = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${record.remote_id}/comments`) as unknown[];
    expect(commentsAfter.length).toBe(countBefore);
  });
});
