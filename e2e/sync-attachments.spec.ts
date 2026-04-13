/**
 * HS-5057: attachment sync — image vs file markdown, read-back, dedup.
 *
 * User expectation: "my attachments end up on GitHub — images render inline,
 * files are linked, and they don't get re-uploaded every time I sync."
 *
 * The HS-5052 fix asserted an attachment comment exists but never verified
 * (a) the file really lives in the attachment_repo at the expected path,
 * (b) image vs file markdown, or (c) that repeated syncs don't re-upload.
 *
 * These tests require a configured attachment_repo. If GITHUB_PLUGIN_ATTACHMENT_REPO
 * is unset, the attachment upload tests skip but the "silent skip when unset"
 * test still runs (since it needs attachment_repo to be empty).
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';
const GITHUB_TOKEN = process.env.GITHUB_PLUGIN_TOKEN ?? '';
const GITHUB_OWNER = process.env.GITHUB_PLUGIN_OWNER ?? '';
const GITHUB_REPO = process.env.GITHUB_PLUGIN_REPO ?? '';
const ATTACHMENT_REPO = process.env.GITHUB_PLUGIN_ATTACHMENT_REPO ?? '';
const hasGithubCreds = GITHUB_TOKEN !== '' && GITHUB_OWNER !== '' && GITHUB_REPO !== '';
const hasAttachmentRepo = ATTACHMENT_REPO !== '';

/** 1x1 transparent PNG — smallest valid PNG. */
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000097048' +
  '597300002e1300002e1301784a402a0000000a49444154789c636000000002000181cdfec10000' +
  '000049454e44ae426082',
  'hex',
);

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
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getComments(remoteId: string): Promise<GhComment[]> {
  return (await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${remoteId}/comments?per_page=100`)) as GhComment[];
}

/** Download a raw URL (e.g. a GitHub raw.githubusercontent.com link). Returns byte length. */
async function downloadSize(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = await res.arrayBuffer();
  return buf.byteLength;
}

test.describe('GitHub plugin — attachment sync (HS-5057)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.skip(!hasGithubCreds, 'GitHub credentials not set');
  test.setTimeout(180_000);

  let headers: Record<string, string> = {};
  const createdRemoteIds: string[] = [];
  const uploadedPaths: string[] = [];

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
    // Best-effort cleanup of uploaded attachment files.
    if (!hasAttachmentRepo) return;
    const [attOwner, attRepo] = ATTACHMENT_REPO.split('/');
    for (const path of uploadedPaths) {
      try {
        const info = await ghRequest('GET', `/repos/${attOwner}/${attRepo}/contents/${encodeURIComponent(path)}`) as { sha: string };
        await ghRequest('DELETE', `/repos/${attOwner}/${attRepo}/contents/${encodeURIComponent(path)}`, {
          message: `cleanup HS5057 ${path}`, sha: info.sha,
        });
      } catch { /* ignore */ }
    }
  });

  async function setAttachmentRepo(
    request: APIRequestContext,
    repo: string,
    folder = 'hotsheet-attachments',
    branch = 'main',
  ) {
    await request.patch('/api/settings', {
      headers,
      data: {
        'plugin:github-issues:attachment_repo': repo,
        'plugin:github-issues:attachment_folder': folder,
        'plugin:github-issues:attachment_branch': branch,
      },
    });
  }

  /** Create a ticket, upload an attachment, then push-ticket. */
  async function createTicketWithAttachment(
    request: APIRequestContext,
    title: string,
    filename: string,
    content: Buffer,
    mimeType: string,
  ): Promise<{ localId: number; remoteId: string }> {
    const createRes = await request.post('/api/tickets', {
      headers, data: { title, defaults: { details: 'attachment test' } },
    });
    const ticket = await createRes.json() as { id: number };
    const headersNoCT: Record<string, string> = { 'X-Hotsheet-Secret': headers['X-Hotsheet-Secret'] };
    const attachRes = await request.post(`/api/tickets/${ticket.id}/attachments`, {
      headers: headersNoCT,
      multipart: { file: { name: filename, mimeType, buffer: content } },
    });
    expect(attachRes.ok()).toBe(true);
    const pushRes = await request.post(
      `/api/plugins/github-issues/push-ticket/${ticket.id}`,
      { headers },
    );
    const pushResult = await pushRes.json() as { remoteId: string };
    createdRemoteIds.push(pushResult.remoteId);
    return { localId: ticket.id, remoteId: pushResult.remoteId };
  }

  test('image attachment uses image markdown and the file exists in the attachment repo', async ({ request }) => {
    test.skip(!hasAttachmentRepo, 'GITHUB_PLUGIN_ATTACHMENT_REPO not set');
    await setAttachmentRepo(request, ATTACHMENT_REPO);

    const filename = `hs5057-${Date.now()}.png`;
    const { remoteId } = await createTicketWithAttachment(
      request, `img attachment ${Date.now()}`, filename, PNG_1X1, 'image/png',
    );

    // Read the GitHub comment body
    const comments = await getComments(remoteId);
    const attComment = comments.find(c => c.body.includes(filename));
    expect(attComment, `Expected a comment containing ${filename}`).toBeTruthy();

    // Image syntax: starts with ![
    expect(attComment!.body.startsWith('![')).toBe(true);
    expect(attComment!.body).toContain(`![${filename}]`);

    // Extract the URL from the markdown and verify the file exists.
    const urlMatch = attComment!.body.match(/\]\(([^)]+)\)/);
    expect(urlMatch).toBeTruthy();
    const url = urlMatch![1];
    const size = await downloadSize(url);
    expect(size).toBe(PNG_1X1.length);

    // Track for cleanup.
    const pathMatch = url.match(/hotsheet-attachments\/[^?]+/);
    if (pathMatch) uploadedPaths.push(pathMatch[0]);
  });

  test('non-image attachment uses link markdown and the file exists in the attachment repo', async ({ request }) => {
    test.skip(!hasAttachmentRepo, 'GITHUB_PLUGIN_ATTACHMENT_REPO not set');
    await setAttachmentRepo(request, ATTACHMENT_REPO);

    const filename = `hs5057-${Date.now()}.txt`;
    const contents = Buffer.from(`HS-5057 text attachment payload ${Date.now()}`);
    const { remoteId } = await createTicketWithAttachment(
      request, `file attachment ${Date.now()}`, filename, contents, 'text/plain',
    );

    const comments = await getComments(remoteId);
    const attComment = comments.find(c => c.body.includes(filename));
    expect(attComment).toBeTruthy();

    // Link syntax: starts with [ but NOT ![
    expect(attComment!.body.startsWith('[')).toBe(true);
    expect(attComment!.body.startsWith('![')).toBe(false);
    expect(attComment!.body).toContain(`[${filename}]`);

    const urlMatch = attComment!.body.match(/\]\(([^)]+)\)/);
    expect(urlMatch).toBeTruthy();
    const url = urlMatch![1];
    const size = await downloadSize(url);
    expect(size).toBe(contents.length);

    const pathMatch = url.match(/hotsheet-attachments\/[^?]+/);
    if (pathMatch) uploadedPaths.push(pathMatch[0]);
  });

  test('repeated syncs do not re-upload attachments or post duplicate comments', async ({ request }) => {
    test.skip(!hasAttachmentRepo, 'GITHUB_PLUGIN_ATTACHMENT_REPO not set');
    await setAttachmentRepo(request, ATTACHMENT_REPO);

    const filename = `hs5057-dedup-${Date.now()}.txt`;
    const { remoteId } = await createTicketWithAttachment(
      request, `att dedup ${Date.now()}`, filename, Buffer.from('dedup test'), 'text/plain',
    );

    // Count comments containing the filename before extra syncs
    const before = (await getComments(remoteId)).filter(c => c.body.includes(filename)).length;
    expect(before).toBe(1);

    // Sync 3 more times
    await request.post('/api/plugins/github-issues/sync', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });
    await request.post('/api/plugins/github-issues/sync', { headers });

    const after = (await getComments(remoteId)).filter(c => c.body.includes(filename)).length;
    expect(after).toBe(1);
  });

  test('attachment_repo unset → attachment is silently skipped, no error, no comment', async ({ request }) => {
    // Explicitly clear attachment_repo
    await request.patch('/api/settings', {
      headers, data: { 'plugin:github-issues:attachment_repo': '' },
    });

    const filename = `hs5057-skip-${Date.now()}.txt`;
    // createTicketWithAttachment itself pushes — if this throws, the test fails.
    const { remoteId } = await createTicketWithAttachment(
      request, `att skip ${Date.now()}`, filename, Buffer.from('skip test'), 'text/plain',
    );

    // Sync explicitly as well (push-ticket already runs syncSingleTicketContent).
    const syncRes = await request.post('/api/plugins/github-issues/sync', { headers });
    const syncResult = await syncRes.json() as { ok: boolean };
    expect(syncResult.ok).toBe(true);

    // No comment referencing the filename should exist.
    const comments = await getComments(remoteId);
    expect(comments.find(c => c.body.includes(filename))).toBeUndefined();
  });

  test('attachment_folder setting is respected — file lands under the configured folder', async ({ request }) => {
    test.skip(!hasAttachmentRepo, 'GITHUB_PLUGIN_ATTACHMENT_REPO not set');
    const folder = `hs5057-folder-${Date.now().toString(36)}`;
    await setAttachmentRepo(request, ATTACHMENT_REPO, folder);

    const filename = `hs5057-${Date.now()}.txt`;
    const { remoteId } = await createTicketWithAttachment(
      request, `att folder ${Date.now()}`, filename, Buffer.from('folder test'), 'text/plain',
    );

    const comments = await getComments(remoteId);
    const attComment = comments.find(c => c.body.includes(filename));
    expect(attComment).toBeTruthy();
    const urlMatch = attComment!.body.match(/\]\(([^)]+)\)/);
    expect(urlMatch).toBeTruthy();
    // URL should contain the configured folder name.
    expect(urlMatch![1]).toContain(`/${folder}/`);

    const pathMatch = urlMatch![1].match(new RegExp(`${folder}/[^?]+`));
    if (pathMatch) uploadedPaths.push(pathMatch[0]);

    // Reset to default folder for subsequent tests.
    await setAttachmentRepo(request, ATTACHMENT_REPO);
  });
});
