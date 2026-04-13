/**
 * HS-5056: note/comment sync edit, delete, and dedup coverage.
 *
 * Before this suite, only note CREATE → comment was tested. The three other
 * paths (edit push, edit pull, delete push, delete pull) were completely
 * untested even though the plugin interface supports updateComment/deleteComment.
 * These tests also cover text-based dedup and idempotency on repeated syncs.
 *
 * User expectations:
 *   - Edit a note locally → the remote GitHub comment updates.
 *   - Delete a note locally → the remote comment is deleted.
 *   - Create a comment on GitHub → a new local note appears.
 *   - Edit a comment on GitHub → the local note text updates.
 *   - Syncing twice never duplicates anything.
 *   - Text-based dedup: creating a local note with the same text as an existing
 *     remote comment just maps them together instead of posting a duplicate.
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';

interface GhComment { id: number; body: string }

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
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getComments(remoteId: string): Promise<GhComment[]> {
  return (await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}/comments?per_page=100`)) as GhComment[];
}

test.describe('GitHub plugin — note sync edit/delete/dedup (HS-5056)', () => {
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
        await ghRequest('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${id}`, { state: 'closed' });
      } catch { /* ignore */ }
    }
  });

  /** Create a synced ticket with an initial note. Returns local + remote ids + the note id. */
  async function createSyncedTicketWithNote(
    request: APIRequestContext,
    title: string,
    noteText: string,
  ): Promise<{ localId: number; remoteId: string; noteId: string }> {
    const createRes = await request.post('/api/tickets', {
      headers, data: { title, defaults: { details: 'note sync ticket' } },
    });
    const ticket = await createRes.json() as { id: number };

    // Add the note via PUT /notes-bulk with a client-chosen id so we can look it up later.
    const noteId = `n_${Date.now().toString(36)}_hs5056`;
    const notesArray = [{ id: noteId, text: noteText, created_at: new Date().toISOString() }];
    await request.put(`/api/tickets/${ticket.id}/notes-bulk`, {
      headers, data: { notes: JSON.stringify(notesArray) },
    });

    // Push the ticket — push-ticket handler also runs syncSingleTicketContent
    // which pushes notes immediately.
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    const pushResult = await pushRes.json() as { remoteId: string };
    createdRemoteIds.push(pushResult.remoteId);

    return { localId: ticket.id, remoteId: pushResult.remoteId, noteId };
  }

  test('edit a note locally → the remote comment body updates', async ({ request }) => {
    const original = `HS5056 edit original ${Date.now()}`;
    const edited = `HS5056 edit updated ${Date.now()}`;
    const { localId, remoteId, noteId } = await createSyncedTicketWithNote(
      request, `note edit ${Date.now()}`, original,
    );

    // Baseline: comment exists with original text
    const commentsBefore = await getComments(remoteId);
    const matching = commentsBefore.find(c => c.body === original);
    expect(matching).toBeTruthy();

    // Edit locally
    await request.patch(`/api/tickets/${localId}/notes/${noteId}`, {
      headers, data: { text: edited },
    });

    // Sync to push the edit
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Read GitHub back — the SAME comment id should now have the edited body.
    const commentsAfter = await getComments(remoteId);
    const sameId = commentsAfter.find(c => c.id === matching!.id);
    expect(sameId).toBeTruthy();
    expect(sameId!.body).toBe(edited);
    // And no duplicate was posted.
    expect(commentsAfter.filter(c => c.body === edited).length).toBe(1);
  });

  test('delete a note locally → the remote comment is deleted', async ({ request }) => {
    const noteText = `HS5056 delete me ${Date.now()}`;
    const { localId, remoteId, noteId } = await createSyncedTicketWithNote(
      request, `note delete ${Date.now()}`, noteText,
    );

    // Baseline: comment exists
    const commentsBefore = await getComments(remoteId);
    const target = commentsBefore.find(c => c.body === noteText);
    expect(target).toBeTruthy();

    // Delete locally
    await request.delete(`/api/tickets/${localId}/notes/${noteId}`, { headers });

    // Sync to push the delete
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Verify comment is gone from GitHub
    const commentsAfter = await getComments(remoteId);
    expect(commentsAfter.find(c => c.id === target!.id)).toBeUndefined();
  });

  test('create a comment on GitHub → pull creates a local note', async ({ request }) => {
    const { localId, remoteId } = await createSyncedTicketWithNote(
      request, `note pull create ${Date.now()}`, `seed ${Date.now()}`,
    );
    // Sync once to baseline so the new remote comment registers as "new since last sync"
    await request.post('/api/plugins/github-issues/sync', { headers });
    await new Promise(r => setTimeout(r, 2000));

    // Create a brand new comment directly on GitHub
    const newText = `HS5056 from github ${Date.now()}`;
    await ghRequest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}/comments`, { body: newText });

    // Pull
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Read local ticket back and assert a new note with that text exists.
    const ticketRes = await request.get(`/api/tickets/${localId}`, { headers });
    const ticket = await ticketRes.json() as { notes: string };
    const notes = JSON.parse(ticket.notes) as { text: string }[];
    expect(notes.some(n => n.text === newText)).toBe(true);
  });

  test('edit a comment on GitHub → pull updates the local note text', async ({ request }) => {
    const initial = `HS5056 pull-edit initial ${Date.now()}`;
    const { localId, remoteId, noteId } = await createSyncedTicketWithNote(
      request, `note pull edit ${Date.now()}`, initial,
    );
    // Baseline sync
    await request.post('/api/plugins/github-issues/sync', { headers });
    await new Promise(r => setTimeout(r, 2000));

    // Find the mapped remote comment and edit it directly on GitHub.
    const comments = await getComments(remoteId);
    const target = comments.find(c => c.body === initial);
    expect(target).toBeTruthy();

    const edited = `HS5056 pull-edit updated ${Date.now()}`;
    await ghRequest('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/comments/${target!.id}`, { body: edited });

    // Sync to pull the edit
    await request.post('/api/plugins/github-issues/sync', { headers });

    // Read local ticket — the existing note (same id) should have the new text.
    const ticketRes = await request.get(`/api/tickets/${localId}`, { headers });
    const ticket = await ticketRes.json() as { notes: string };
    const notes = JSON.parse(ticket.notes) as { id: string; text: string }[];
    const local = notes.find(n => n.id === noteId);
    expect(local).toBeTruthy();
    expect(local!.text).toBe(edited);
  });

  test('repeated sync does not duplicate comments or note mappings', async ({ request }) => {
    const noteText = `HS5056 dedup ${Date.now()}`;
    const { remoteId } = await createSyncedTicketWithNote(
      request, `note dedup ${Date.now()}`, noteText,
    );

    const countBefore = (await getComments(remoteId)).filter(c => c.body === noteText).length;
    expect(countBefore).toBe(1);

    // Sync 3 more times — nothing should change
    await request.post('/api/plugins/github-issues/sync', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const countAfter = (await getComments(remoteId)).filter(c => c.body === noteText).length;
    expect(countAfter).toBe(1);
  });

  test('text-based dedup: local note matching existing remote comment maps instead of creating', async ({ request }) => {
    // Create a synced ticket with no notes, then post a comment on GitHub directly.
    const createRes = await request.post('/api/tickets', {
      headers, data: { title: `note textdedup ${Date.now()}`, defaults: { details: 'seed' } },
    });
    const ticket = await createRes.json() as { id: number };
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    const pushResult = await pushRes.json() as { remoteId: string };
    createdRemoteIds.push(pushResult.remoteId);

    const sharedText = `HS5056 shared ${Date.now()}`;
    // Post comment directly on GitHub first.
    await ghRequest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${pushResult.remoteId}/comments`, { body: sharedText });

    // Now add a local note with the identical text (without syncing first).
    const noteId = `n_${Date.now().toString(36)}_dedup`;
    const notesArray = [{ id: noteId, text: sharedText, created_at: new Date().toISOString() }];
    await request.put(`/api/tickets/${ticket.id}/notes-bulk`, {
      headers, data: { notes: JSON.stringify(notesArray) },
    });

    // Sync — the local note should be MAPPED to the existing remote comment,
    // not posted as a duplicate.
    await request.post('/api/plugins/github-issues/sync', { headers });

    const comments = await getComments(pushResult.remoteId);
    const matches = comments.filter(c => c.body === sharedText);
    expect(matches.length).toBe(1);
  });
});
