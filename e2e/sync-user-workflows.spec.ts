/**
 * User workflow tests for GitHub sync.
 *
 * These tests follow the actual sequences a real user performs, crossing
 * multiple internal features (onTicketCreated, push-ticket, outbox, runSync,
 * syncComments, syncAttachments). Per-feature tests can't catch interaction
 * bugs between features that work fine in isolation — these tests can.
 *
 * HS-5083 shipped because no test followed the basic "create → push → edit →
 * sync" workflow. These tests exist to prevent that class of bug.
 */
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

async function ghPatch(path: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
}

test.describe('GitHub sync — user workflow tests', () => {
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
      headers, data: { 'plugin:github-issues:owner': GITHUB_OWNER, 'plugin:github-issues:repo': GITHUB_REPO },
    });
  });

  test.afterAll(async () => {
    for (const id of createdRemoteIds) {
      try { await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' }); } catch { /* */ }
    }
  });

  test('create → push → add note → sync: note appears on GitHub, no duplicate issue (HS-5083 repro)', async ({ request }) => {
    // Step 1: Create a ticket. This internally triggers onTicketCreated which
    // may queue an outbox create entry.
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `workflow note ${Date.now()}`, defaults: { details: 'initial details' } },
    });
    const ticket = await createRes.json() as { id: number };

    // Step 2: Push to GitHub via push-ticket.
    const pushRes = await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });
    const pushResult = await pushRes.json() as { ok: boolean; remoteId: string };
    expect(pushResult.ok).toBe(true);
    const remoteId = pushResult.remoteId;
    createdRemoteIds.push(remoteId);

    // Step 3: Add a note.
    const noteText = `workflow note text ${Date.now()}`;
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { notes: noteText } });

    // Step 4: Sync.
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const syncResult = await syncRes.json();
    expect(syncResult.ok).toBe(true);

    // Assertions — all verified by reading GitHub directly:
    // (a) The note appears as a comment on the ORIGINAL issue.
    const comments = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}/comments`) as { body: string }[];
    expect(comments.some(c => c.body === noteText), 'note should appear as comment on original issue').toBe(true);

    // (b) The sync record still points to the original issue (no re-link).
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    const record = records.find(r => r.ticket_id === ticket.id);
    expect(record!.remote_id).toBe(remoteId);

    // (c) The local note still exists.
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const local = await ticketRes.json() as { notes: string };
    const notes = JSON.parse(local.notes) as { text: string }[];
    expect(notes.some(n => n.text === noteText), 'local note should still exist').toBe(true);
  });

  test('create → push → add attachment → sync: attachment on original issue, note preserved (HS-5083 variant)', async ({ request }) => {
    // Same workflow but with an attachment instead of a note.
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `workflow att ${Date.now()}`, defaults: { details: 'with attachment' } },
    });
    const ticket = await createRes.json() as { id: number };

    // Add a note BEFORE pushing so we can verify it survives.
    const noteText = `pre-push note ${Date.now()}`;
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { notes: noteText } });

    // Push.
    const pushRes = await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });
    const pushResult = await pushRes.json() as { ok: boolean; remoteId: string };
    expect(pushResult.ok).toBe(true);
    const remoteId = pushResult.remoteId;
    createdRemoteIds.push(remoteId);

    // Add an attachment after pushing.
    const headersNoCT: Record<string, string> = { 'X-Hotsheet-Secret': headers['X-Hotsheet-Secret'] };
    await request.post(`/api/tickets/${ticket.id}/attachments`, {
      headers: headersNoCT,
      multipart: { file: { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') } },
    });

    // Sync.
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    expect((await syncRes.json() as { ok: boolean }).ok).toBe(true);

    // (a) Sync record still points to original issue.
    const recordsRes = await request.get('/api/plugins/github-issues/sync', { headers });
    const records = await recordsRes.json() as { ticket_id: number; remote_id: string }[];
    expect(records.find(r => r.ticket_id === ticket.id)!.remote_id).toBe(remoteId);

    // (b) The pre-push note still exists locally.
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const local = await ticketRes.json() as { notes: string };
    const notes = JSON.parse(local.notes) as { text: string }[];
    expect(notes.some(n => n.text === noteText), 'pre-push note must survive attachment sync').toBe(true);

    // (c) The note still exists on GitHub as a comment.
    const comments = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}/comments`) as { body: string }[];
    expect(comments.some(c => c.body === noteText), 'note comment should still exist on original issue').toBe(true);
  });

  test('create → push → edit title → sync → verify GitHub title updated', async ({ request }) => {
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `workflow title ${Date.now()}`, defaults: { details: 'v1' } },
    });
    const ticket = await createRes.json() as { id: number };

    const pushRes = await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });
    const pushResult = await pushRes.json() as { remoteId: string };
    createdRemoteIds.push(pushResult.remoteId);

    const newTitle = `updated title ${Date.now()}`;
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { title: newTitle } });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${pushResult.remoteId}`) as { title: string };
    expect(ghIssue.title).toBe(newTitle);
  });

  test('pull → edit locally → sync → verify GitHub updated', async ({ request }) => {
    // Create issue directly on GitHub.
    const ghTitle = `workflow pull ${Date.now()}`;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
      body: JSON.stringify({ title: ghTitle, body: 'from GitHub' }),
    });
    const issue = await res.json() as { number: number };
    createdRemoteIds.push(String(issue.number));

    // Pull.
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Find the local ticket.
    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number; title: string }[];
    const local = tickets.find(t => t.title === ghTitle);
    expect(local, 'pulled issue should create a local ticket').toBeTruthy();

    // Edit locally.
    const editedDetails = `edited locally ${Date.now()}`;
    await request.patch(`/api/tickets/${local!.id}`, { headers, data: { details: editedDetails } });

    // Sync to push the edit.
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Verify GitHub has the edited details.
    const ghIssue = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${issue.number}`) as { body: string };
    expect(ghIssue.body).toBe(editedDetails);
  });

  test('push → edit on GitHub → sync → verify local updated', async ({ request }) => {
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `workflow gh-edit ${Date.now()}`, defaults: { details: 'original' } },
    });
    const ticket = await createRes.json() as { id: number };
    const pushRes = await request.post(`/api/plugins/github-issues/push-ticket/${ticket.id}`, { headers });
    const pushResult = await pushRes.json() as { remoteId: string };
    createdRemoteIds.push(pushResult.remoteId);

    // Baseline sync so timestamps are stable.
    await request.post('/api/plugins/github-issues/sync', { headers });
    await new Promise(r => setTimeout(r, 2000));

    // Edit on GitHub.
    const ghDetails = `edited on github ${Date.now()}`;
    await ghPatch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${pushResult.remoteId}`, { body: ghDetails });

    // Sync to pull.
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const syncResult = await syncRes.json() as { conflicts?: number };

    // If conflict, resolve keep_remote.
    if ((syncResult.conflicts ?? 0) > 0) {
      await request.post(`/api/sync/conflicts/${ticket.id}/resolve`, {
        headers, data: { plugin_id: 'github-issues', resolution: 'keep_remote' },
      });
      await request.post('/api/plugins/github-issues/sync', { headers });
    }

    // Verify local.
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const local = await ticketRes.json() as { details: string };
    expect(local.details).toBe(ghDetails);
  });
});
