/**
 * HS-5060 part (b): rate-limit handling in the github-issues plugin.
 *
 * These tests stub global.fetch so we can assert the plugin's behavior under
 * simulated GitHub rate-limit responses without hitting the real API.
 *
 * User expectations:
 *   - If GitHub reports "remaining < 10" on a response, the plugin logs a
 *     warning and waits until the reset time before the next call.
 *   - If GitHub returns 403 with "remaining = 0", the plugin throws a clear
 *     "rate limit exceeded" error.
 *   - Under normal conditions (remaining well above 10), nothing is logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext } from './types.js';

// Import the plugin entry point after we've set up fetch stubs per test.
// Because activate() captures global.fetch at call time (via ghFetch's
// closure), we can swap fetch out before each test.
import { activate } from './index.js';

interface MockFetchCall { url: string; init: RequestInit | undefined }
let fetchCalls: MockFetchCall[];
const _realFetch = global.fetch;

function installFetchStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = _realFetch;
}

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeContext(settings: Record<string, string>): {
  context: PluginContext;
  logs: { level: string; message: string }[];
} {
  const logs: { level: string; message: string }[] = [];
  const context: PluginContext = {
    config: {},
    log: (level, message) => logs.push({ level, message }),
    getSetting: async (key) => settings[key] ?? null,
    setSetting: async () => { /* no-op */ },
    registerUI: () => { /* no-op */ },
    updateConfigLabel: () => { /* no-op */ },
  };
  return { context, logs };
}

describe('github-issues plugin — rate-limit handling (HS-5060)', () => {
  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    restoreFetch();
  });

  it('logs a warning and waits when x-ratelimit-remaining < 10', async () => {
    // First fetch (inside checkConnection) returns a response with low remaining
    // and a near-future reset time. Second fetch returns a normal response.
    let callIndex = 0;
    installFetchStub((_url) => {
      callIndex++;
      if (callIndex === 1) {
        // Simulated near-future reset: now + 50ms (in seconds since epoch)
        const resetSec = Math.floor((Date.now() + 50) / 1000);
        return makeResponse(200, { id: 1, name: 'repo' }, {
          'x-ratelimit-remaining': '5',
          'x-ratelimit-reset': String(resetSec),
        });
      }
      return makeResponse(200, { id: 1, name: 'repo' }, {
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
    });

    const { context, logs } = makeContext({
      token: 'ghp_test',
      owner: 'octocat',
      repo: 'hello-world',
    });

    const backend = await activate(context);
    expect(backend).toBeTruthy();

    const start = Date.now();
    const status = await backend!.checkConnection();
    const elapsed = Date.now() - start;

    expect(status.connected).toBe(true);
    expect(logs.some(l => l.level === 'warn' && l.message.includes('Rate limit low'))).toBe(true);
    // The plugin's wait is waitMs = max(0, resetTime - now) + 1000, so at
    // least ~1s of delay. Use a generous lower bound to avoid flakiness.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('throws "rate limit exceeded" on 403 with remaining=0', async () => {
    // Note: because remaining=0 is also <10, ghFetch first takes the "wait for
    // reset" branch before throwing. Use a near-future reset so the test
    // doesn't sit for an hour. (This does mean the test exercises both the
    // wait AND the throw in one run.)
    installFetchStub(() => makeResponse(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor((Date.now() + 50) / 1000)),
    }));

    const { context } = makeContext({
      token: 'ghp_test',
      owner: 'octocat',
      repo: 'hello-world',
    });

    const backend = await activate(context);
    const status = await backend!.checkConnection();
    // checkConnection catches the throw and reports connected: false with the message.
    expect(status.connected).toBe(false);
    expect(status.error ?? '').toContain('rate limit exceeded');
  });

  it('does not log a warning when remaining is well above 10', async () => {
    installFetchStub(() => makeResponse(200, { id: 1, name: 'repo' }, {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    }));

    const { context, logs } = makeContext({
      token: 'ghp_test',
      owner: 'octocat',
      repo: 'hello-world',
    });

    const backend = await activate(context);
    await backend!.checkConnection();

    expect(logs.some(l => l.message.includes('Rate limit low'))).toBe(false);
  });
});

// ---- Helpers shared across all new test sections ----

/** Normal 200 response headers (plenty of rate limit remaining). */
const okHeaders = {
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

/** Standard settings for a writable GitHub Issues plugin. */
const defaultSettings: Record<string, string> = {
  token: 'ghp_test',
  owner: 'octocat',
  repo: 'hello-world',
};

/** Activate the plugin with the given settings and fetch handler. Returns the backend and logs. */
async function activateWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  settings: Record<string, string> = defaultSettings,
) {
  installFetchStub(handler);
  const { context, logs } = makeContext(settings);
  const backend = await activate(context);
  fetchCalls = []; // Reset calls from activate() itself
  return { backend: backend!, logs, context };
}

// ---- checkConnection ----

describe('github-issues plugin — checkConnection', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('returns connected:false when token/owner/repo are missing', async () => {
    installFetchStub(() => makeResponse(200, {}, okHeaders));
    const { context } = makeContext({});
    const backend = await activate(context);
    const status = await backend!.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.error).toContain('Missing required configuration');
  });

  it('returns connected:false when GitHub returns a non-ok response', async () => {
    installFetchStub(() => makeResponse(401, { message: 'Bad credentials' }, okHeaders));
    const { context } = makeContext(defaultSettings);
    const backend = await activate(context);
    const status = await backend!.checkConnection();
    expect(status.connected).toBe(false);
    expect(status.error).toContain('401');
  });
});

// ---- createRemote (issue creation) ----

describe('github-issues plugin — createRemote', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('creates an issue with correct labels derived from ticket fields', async () => {
    const { backend, logs } = await activateWith((url, init) => {
      if (url.includes('/issues') && init?.method === 'POST') {
        return makeResponse(201, { number: 42, title: 'Test', body: '', state: 'open', labels: [], milestone: null, updated_at: new Date().toISOString() }, okHeaders);
      }
      return makeResponse(200, {}, okHeaders);
    });

    const ticket = {
      id: 1, ticket_number: 'HS-1', title: 'Test Issue', details: 'Some details',
      category: 'bug', priority: 'high', status: 'started', up_next: true, tags: '["custom-tag"]',
    };

    const remoteId = await backend.createRemote(ticket);
    expect(remoteId).toBe('42');

    // Verify the POST body had the right labels
    const postCall = fetchCalls.find(c => c.init?.method === 'POST');
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall!.init!.body as string);
    expect(body.title).toBe('Test Issue');
    expect(body.body).toBe('Some details');
    expect(body.labels).toContain('category:bug');
    expect(body.labels).toContain('priority:high');
    expect(body.labels).toContain('status:started');
    expect(body.labels).toContain('up-next');
    expect(body.labels).toContain('custom-tag');
    expect(logs.some(l => l.message.includes('Created issue #42'))).toBe(true);
  });

  it('does not include priority:default label', async () => {
    const { backend } = await activateWith((url, init) => {
      if (url.includes('/issues') && init?.method === 'POST') {
        return makeResponse(201, { number: 10, title: 'x', body: '', state: 'open', labels: [], milestone: null, updated_at: new Date().toISOString() }, okHeaders);
      }
      return makeResponse(200, {}, okHeaders);
    });

    const ticket = {
      id: 1, ticket_number: 'HS-1', title: 'Default Priority',
      details: '', category: 'task', priority: 'default', status: 'not_started', up_next: false, tags: '[]',
    };

    await backend.createRemote(ticket);
    const postCall = fetchCalls.find(c => c.init?.method === 'POST');
    const body = JSON.parse(postCall!.init!.body as string);
    expect(body.labels).not.toContain('priority:default');
    expect(body.labels).toContain('category:task');
    expect(body.labels).toContain('status:not-started');
  });

  it('throws when sync_direction is pull_only', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, sync_direction: 'pull_only' },
    );

    const ticket = {
      id: 1, ticket_number: 'HS-1', title: 'Test', details: '',
      category: 'issue', priority: 'default', status: 'not_started', up_next: false, tags: '[]',
    };

    await expect(backend.createRemote(ticket)).rejects.toThrow('Push disabled');
  });

  it('includes milestone number when ticket has a milestone tag', async () => {
    const { backend } = await activateWith((url, init) => {
      if (url.includes('/milestones')) {
        return makeResponse(200, [{ number: 7, title: 'v1.0' }], okHeaders);
      }
      if (url.includes('/issues') && init?.method === 'POST') {
        return makeResponse(201, { number: 55, title: 'x', body: '', state: 'open', labels: [], milestone: null, updated_at: new Date().toISOString() }, okHeaders);
      }
      return makeResponse(200, {}, okHeaders);
    });

    const ticket = {
      id: 1, ticket_number: 'HS-1', title: 'Milestone Test', details: '',
      category: 'issue', priority: 'default', status: 'not_started', up_next: false,
      tags: '["milestone:v1.0"]',
    };

    await backend.createRemote(ticket);
    const postCall = fetchCalls.find(c => c.init?.method === 'POST');
    const body = JSON.parse(postCall!.init!.body as string);
    expect(body.milestone).toBe(7);
    // Milestone tags should not be sent as labels
    expect(body.labels).not.toContain('milestone:v1.0');
  });
});

// ---- updateRemote ----

describe('github-issues plugin — updateRemote', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('updates title and details without fetching labels when no label-related fields change', async () => {
    const { backend } = await activateWith((url, init) => {
      if (init?.method === 'PATCH') return makeResponse(200, {}, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await backend.updateRemote('10', { title: 'New Title', details: 'New body' });
    const patchCall = fetchCalls.find(c => c.init?.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall!.init!.body as string);
    expect(body.title).toBe('New Title');
    expect(body.body).toBe('New body');
    // Should not have fetched the issue (no GET before the PATCH)
    expect(fetchCalls.filter(c => !c.init?.method || c.init?.method === 'GET').length).toBe(0);
  });

  it('rebuilds labels when category changes, preserving user labels', async () => {
    const existingIssue = {
      number: 10, title: 'Old', body: '', state: 'open',
      labels: [{ name: 'category:issue' }, { name: 'status:not-started' }, { name: 'my-custom-label' }],
      milestone: null, updated_at: new Date().toISOString(),
    };
    const { backend } = await activateWith((url, init) => {
      if (url.includes('/issues/10') && (!init?.method || init?.method === 'GET')) {
        return makeResponse(200, existingIssue, okHeaders);
      }
      if (init?.method === 'PATCH') return makeResponse(200, {}, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await backend.updateRemote('10', { category: 'bug' });
    const patchCall = fetchCalls.find(c => c.init?.method === 'PATCH');
    const body = JSON.parse(patchCall!.init!.body as string);
    expect(body.labels).toContain('category:bug');
    expect(body.labels).not.toContain('category:issue');
    expect(body.labels).toContain('my-custom-label');
    expect(body.labels).toContain('status:not-started');
  });

  it('sets state to closed when status changes to completed', async () => {
    const existingIssue = {
      number: 10, title: 'x', body: '', state: 'open',
      labels: [{ name: 'category:issue' }, { name: 'status:not-started' }],
      milestone: null, updated_at: new Date().toISOString(),
    };
    const { backend } = await activateWith((url, init) => {
      if (url.includes('/issues/10') && (!init?.method || init?.method === 'GET')) {
        return makeResponse(200, existingIssue, okHeaders);
      }
      if (init?.method === 'PATCH') return makeResponse(200, {}, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await backend.updateRemote('10', { status: 'completed' });
    const patchCall = fetchCalls.find(c => c.init?.method === 'PATCH');
    const body = JSON.parse(patchCall!.init!.body as string);
    expect(body.state).toBe('closed');
    expect(body.labels).toContain('status:completed');
  });

  it('clears milestone when tags have no milestone tag', async () => {
    const existingIssue = {
      number: 10, title: 'x', body: '', state: 'open',
      labels: [{ name: 'category:issue' }],
      milestone: { number: 7, title: 'v1.0' }, updated_at: new Date().toISOString(),
    };
    const { backend } = await activateWith((url, init) => {
      if (url.includes('/issues/10') && (!init?.method || init?.method === 'GET')) {
        return makeResponse(200, existingIssue, okHeaders);
      }
      if (init?.method === 'PATCH') return makeResponse(200, {}, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await backend.updateRemote('10', { tags: ['some-tag'] });
    const patchCall = fetchCalls.find(c => c.init?.method === 'PATCH');
    const body = JSON.parse(patchCall!.init!.body as string);
    expect(body.milestone).toBeNull();
    expect(body.labels).toContain('some-tag');
  });

  it('throws when sync_direction is pull_only', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, sync_direction: 'pull_only' },
    );
    await expect(backend.updateRemote('10', { title: 'x' })).rejects.toThrow('Push disabled');
  });
});

// ---- deleteRemote ----

describe('github-issues plugin — deleteRemote', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('closes the issue via PATCH', async () => {
    const { backend, logs } = await activateWith((url, init) => {
      if (init?.method === 'PATCH') return makeResponse(200, {}, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await backend.deleteRemote('15');
    const patchCall = fetchCalls.find(c => c.init?.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(patchCall!.url).toContain('/issues/15');
    const body = JSON.parse(patchCall!.init!.body as string);
    expect(body.state).toBe('closed');
    expect(logs.some(l => l.message.includes('Closed issue #15'))).toBe(true);
  });

  it('throws when sync_direction is pull_only', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, sync_direction: 'pull_only' },
    );
    await expect(backend.deleteRemote('15')).rejects.toThrow('Push disabled');
  });
});

// ---- pullChanges (with pagination) ----

describe('github-issues plugin — pullChanges', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('returns mapped issues from a single page', async () => {
    const issues = [
      { number: 1, title: 'Bug 1', body: 'Details', state: 'open', labels: [{ name: 'category:bug' }, { name: 'priority:high' }], milestone: null, updated_at: '2024-01-01T00:00:00Z' },
      { number: 2, title: 'Feature', body: '', state: 'closed', labels: [{ name: 'category:feature' }, { name: 'status:completed' }], milestone: null, updated_at: '2024-01-02T00:00:00Z' },
    ];
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues?')) return makeResponse(200, issues, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const changes = await backend.pullChanges(null);
    expect(changes).toHaveLength(2);
    expect(changes[0].remoteId).toBe('1');
    expect(changes[0].fields.category).toBe('bug');
    expect(changes[0].fields.priority).toBe('high');
    expect(changes[0].fields.status).toBe('not_started');
    expect(changes[1].remoteId).toBe('2');
    expect(changes[1].fields.status).toBe('completed');
  });

  it('skips pull requests in the response', async () => {
    const issues = [
      { number: 1, title: 'Real Issue', body: '', state: 'open', labels: [], milestone: null, updated_at: '2024-01-01T00:00:00Z' },
      { number: 2, title: 'A PR', body: '', state: 'open', labels: [], milestone: null, updated_at: '2024-01-01T00:00:00Z', pull_request: { url: 'https://...' } },
    ];
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues?')) return makeResponse(200, issues, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const changes = await backend.pullChanges(null);
    expect(changes).toHaveLength(1);
    expect(changes[0].fields.title).toBe('Real Issue');
  });

  it('paginates via Link header', async () => {
    const page1Issues = [
      { number: 1, title: 'Issue 1', body: '', state: 'open', labels: [], milestone: null, updated_at: '2024-01-01T00:00:00Z' },
    ];
    const page2Issues = [
      { number: 2, title: 'Issue 2', body: '', state: 'open', labels: [], milestone: null, updated_at: '2024-01-02T00:00:00Z' },
    ];

    let fetchCount = 0;
    const { backend } = await activateWith((url) => {
      fetchCount++;
      if (fetchCount > 10) throw new Error(`Too many fetch calls (${fetchCount}): ${url}`);
      if (url.includes('/issues') && url.includes('page=2')) {
        return makeResponse(200, page2Issues, okHeaders);
      }
      if (url.includes('/issues') && url.includes('page=1')) {
        return makeResponse(200, page1Issues, {
          ...okHeaders,
          link: '<https://api.github.com/repos/octocat/hello-world/issues?page=2>; rel="next"',
        });
      }
      return makeResponse(200, [], okHeaders);
    });

    const changes = await backend.pullChanges(null);
    expect(changes).toHaveLength(2);
    expect(changes[0].remoteId).toBe('1');
    expect(changes[1].remoteId).toBe('2');
  });

  it('passes since parameter as ISO string', async () => {
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues?')) return makeResponse(200, [], okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const since = new Date('2024-06-15T10:00:00Z');
    await backend.pullChanges(since);
    const issueCall = fetchCalls.find(c => c.url.includes('/issues?'));
    expect(issueCall!.url).toContain('since=2024-06-15T10%3A00%3A00.000Z');
  });

  it('returns empty array when sync_direction is push_only', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, sync_direction: 'push_only' },
    );
    const changes = await backend.pullChanges(null);
    expect(changes).toEqual([]);
  });

  it('filters by labels when filter_labels is configured', async () => {
    const { backend } = await activateWith(
      (url) => {
        if (url.includes('/issues?')) return makeResponse(200, [], okHeaders);
        return makeResponse(200, {}, okHeaders);
      },
      { ...defaultSettings, filter_labels: 'team-a, priority:high' },
    );

    await backend.pullChanges(null);
    const issueCall = fetchCalls.find(c => c.url.includes('/issues?'));
    expect(issueCall!.url).toContain('labels=team-a%2Cpriority%3Ahigh');
  });
});

// ---- issueToFields (field mapping) ----

describe('github-issues plugin — field mapping (issueToFields)', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  async function pullSingleIssue(issue: Record<string, unknown>) {
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues?')) return makeResponse(200, [issue], okHeaders);
      return makeResponse(200, {}, okHeaders);
    });
    const changes = await backend.pullChanges(null);
    return changes[0]?.fields;
  }

  it('maps category labels to local values', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [{ name: 'category:feature' }], milestone: null,
    });
    expect(fields?.category).toBe('feature');
  });

  it('maps priority labels to local values', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [{ name: 'priority:lowest' }], milestone: null,
    });
    expect(fields?.priority).toBe('lowest');
  });

  it('defaults priority to "default" when no priority label exists', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [], milestone: null,
    });
    expect(fields?.priority).toBe('default');
  });

  it('defaults category to "issue" when no category label exists', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [], milestone: null,
    });
    expect(fields?.category).toBe('issue');
  });

  it('maps status labels to local values (lossless)', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [{ name: 'status:started' }], milestone: null,
    });
    expect(fields?.status).toBe('started');
  });

  it('falls back to closed → completed when no status label', async () => {
    const closed = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'closed', updated_at: '2024-01-01T00:00:00Z',
      labels: [], milestone: null,
    });
    expect(closed?.status).toBe('completed');
  });

  it('falls back to in-progress label → started when no status label', async () => {
    const inProgress = await pullSingleIssue({
      number: 2, title: 'y', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [{ name: 'in-progress' }], milestone: null,
    });
    expect(inProgress?.status).toBe('started');
  });

  it('falls back to open → not_started when no status label', async () => {
    const open = await pullSingleIssue({
      number: 3, title: 'z', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [], milestone: null,
    });
    expect(open?.status).toBe('not_started');
  });

  it('maps up_next from the up-next label', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [{ name: 'up-next' }], milestone: null,
    });
    expect(fields?.up_next).toBe(true);
  });

  it('excludes known labels from tags', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [{ name: 'category:bug' }, { name: 'priority:high' }, { name: 'status:started' }, { name: 'up-next' }, { name: 'custom-label' }],
      milestone: null,
    });
    expect(fields?.tags).toEqual(['custom-label']);
  });

  it('converts milestone to a milestone: tag', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: [], milestone: { number: 3, title: 'Sprint 5' },
    });
    expect(fields?.tags).toContain('milestone:Sprint 5');
  });

  it('handles string labels (not just objects)', async () => {
    const fields = await pullSingleIssue({
      number: 1, title: 'x', body: '', state: 'open', updated_at: '2024-01-01T00:00:00Z',
      labels: ['category:bug', 'priority:low'], milestone: null,
    });
    expect(fields?.category).toBe('bug');
    expect(fields?.priority).toBe('low');
  });
});

// ---- getRemoteTicket ----

describe('github-issues plugin — getRemoteTicket', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('returns mapped fields for a normal issue', async () => {
    const issue = {
      number: 5, title: 'Remote Issue', body: 'Body text', state: 'open',
      labels: [{ name: 'category:task' }, { name: 'priority:high' }],
      milestone: null, updated_at: '2024-01-01T00:00:00Z',
    };
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues/5')) return makeResponse(200, issue, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const fields = await backend.getRemoteTicket!('5');
    expect(fields).toBeTruthy();
    expect(fields!.title).toBe('Remote Issue');
    expect(fields!.category).toBe('task');
    expect(fields!.priority).toBe('high');
  });

  it('returns null for a pull request', async () => {
    const issue = {
      number: 5, title: 'A PR', body: '', state: 'open', labels: [],
      milestone: null, updated_at: '2024-01-01T00:00:00Z',
      pull_request: { url: 'https://...' },
    };
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues/5')) return makeResponse(200, issue, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const fields = await backend.getRemoteTicket!('5');
    expect(fields).toBeNull();
  });

  it('returns null when the API returns an error', async () => {
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues/999')) return makeResponse(404, { message: 'Not Found' }, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const fields = await backend.getRemoteTicket!('999');
    expect(fields).toBeNull();
  });
});

// ---- Comment operations ----

describe('github-issues plugin — comments', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('getComments returns mapped comments', async () => {
    const comments = [
      { id: 100, body: 'First comment', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T01:00:00Z' },
      { id: 101, body: 'Second comment', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T01:00:00Z' },
    ];
    const { backend } = await activateWith((url) => {
      if (url.includes('/comments')) return makeResponse(200, comments, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    const result = await (backend as any).getComments('5');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('100');
    expect(result[0].text).toBe('First comment');
    expect(result[0].createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(result[1].id).toBe('101');
    expect(result[1].text).toBe('Second comment');
  });

  it('createComment posts to the correct URL and returns the comment ID', async () => {
    const { backend } = await activateWith((url, init) => {
      if (url.includes('/comments') && init?.method === 'POST') {
        return makeResponse(201, { id: 200 }, okHeaders);
      }
      return makeResponse(200, {}, okHeaders);
    });

    const commentId = await (backend as any).createComment('5', 'New comment text');
    expect(commentId).toBe('200');
    const postCall = fetchCalls.find(c => c.init?.method === 'POST');
    expect(postCall!.url).toContain('/issues/5/comments');
    const body = JSON.parse(postCall!.init!.body as string);
    expect(body.body).toBe('New comment text');
  });

  it('updateComment patches the correct comment URL', async () => {
    const { backend } = await activateWith((url, init) => {
      if (init?.method === 'PATCH') return makeResponse(200, {}, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await (backend as any).updateComment('5', '200', 'Updated text');
    const patchCall = fetchCalls.find(c => c.init?.method === 'PATCH');
    expect(patchCall!.url).toContain('/issues/comments/200');
    const body = JSON.parse(patchCall!.init!.body as string);
    expect(body.body).toBe('Updated text');
  });

  it('deleteComment sends DELETE to the correct URL', async () => {
    const { backend } = await activateWith((url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204, headers: { ...okHeaders } });
      return makeResponse(200, {}, okHeaders);
    });

    await (backend as any).deleteComment('5', '200');
    const deleteCall = fetchCalls.find(c => c.init?.method === 'DELETE');
    expect(deleteCall!.url).toContain('/issues/comments/200');
  });
});

// ---- shouldAutoSync / getRemoteUrl ----

describe('github-issues plugin — shouldAutoSync and getRemoteUrl', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('shouldAutoSync returns false by default', async () => {
    const { backend } = await activateWith(() => makeResponse(200, {}, okHeaders));
    expect((backend as any).shouldAutoSync({})).toBe(false);
  });

  it('shouldAutoSync returns true when auto_sync_new is "true"', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, auto_sync_new: 'true' },
    );
    expect((backend as any).shouldAutoSync({})).toBe(true);
  });

  it('getRemoteUrl returns the correct GitHub issue URL', async () => {
    const { backend } = await activateWith(() => makeResponse(200, {}, okHeaders));
    expect((backend as any).getRemoteUrl('42')).toBe('https://github.com/octocat/hello-world/issues/42');
  });

  it('getRemoteUrl returns null when owner/repo are missing', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { token: 'ghp_test' },
    );
    expect((backend as any).getRemoteUrl('42')).toBeNull();
  });
});

// ---- uploadAttachment ----

describe('github-issues plugin — uploadAttachment', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('uploads to the attachment repo and returns the raw URL', async () => {
    const { backend } = await activateWith(
      (url, init) => {
        if (url.includes('/contents/') && init?.method === 'PUT') {
          return makeResponse(201, {
            content: { path: 'hotsheet-attachments/abc-test.png', html_url: 'https://github.com/...' },
          }, okHeaders);
        }
        return makeResponse(200, {}, okHeaders);
      },
      { ...defaultSettings, attachment_repo: 'octocat/attachments' },
    );

    const url = await (backend as any).uploadAttachment('test.png', Buffer.from('data'), 'image/png');
    expect(url).toContain('raw.githubusercontent.com');
    expect(url).toContain('hotsheet-attachments/abc-test.png');
  });

  it('returns null when attachment_repo is not configured', async () => {
    const { backend, logs } = await activateWith(() => makeResponse(200, {}, okHeaders));

    const url = await (backend as any).uploadAttachment('test.png', Buffer.from('data'), 'image/png');
    expect(url).toBeNull();
    expect(logs.some(l => l.message.includes('attachment_repo not configured'))).toBe(true);
  });

  it('returns null and logs error when upload fails', async () => {
    const { backend, logs } = await activateWith(
      (url, init) => {
        if (url.includes('/contents/') && init?.method === 'PUT') {
          return makeResponse(500, { message: 'Internal Server Error' }, okHeaders);
        }
        return makeResponse(200, {}, okHeaders);
      },
      { ...defaultSettings, attachment_repo: 'octocat/attachments' },
    );

    const url = await (backend as any).uploadAttachment('test.png', Buffer.from('data'), 'image/png');
    expect(url).toBeNull();
    expect(logs.some(l => l.level === 'error' && l.message.includes('Failed to upload'))).toBe(true);
  });
});

// ---- Error handling (ghFetch) ----

describe('github-issues plugin — error handling', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('throws a descriptive error for 401 Unauthorized', async () => {
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues') && url.includes('?')) return makeResponse(401, { message: 'Bad credentials' }, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await expect(backend.pullChanges(null)).rejects.toThrow('GitHub API error 401');
  });

  it('throws a descriptive error for 404 Not Found', async () => {
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues') && url.includes('?')) return makeResponse(404, { message: 'Not Found' }, okHeaders);
      return makeResponse(200, {}, okHeaders);
    });

    await expect(backend.pullChanges(null)).rejects.toThrow('GitHub API error 404');
  });

  it('includes response body snippet in error message', async () => {
    const { backend } = await activateWith((url) => {
      if (url.includes('/issues') && url.includes('?')) {
        return makeResponse(422, { message: 'Validation Failed', errors: [{ code: 'invalid' }] }, okHeaders);
      }
      return makeResponse(200, {}, okHeaders);
    });

    await expect(backend.pullChanges(null)).rejects.toThrow('Validation Failed');
  });
});

// ---- validateField ----

import { validateField, onAction } from './index.js';

describe('github-issues plugin — validateField', () => {
  it('returns error when token is empty', async () => {
    const result = await validateField('token', '');
    expect(result).toEqual({ status: 'error', message: 'Required' });
  });

  it('returns warning for non-standard token prefix', async () => {
    const result = await validateField('token', 'invalid_token');
    expect(result?.status).toBe('warning');
    expect(result?.message).toContain('ghp_');
  });

  it('returns success for classic token (ghp_)', async () => {
    const result = await validateField('token', 'ghp_abc123');
    expect(result?.status).toBe('success');
    expect(result?.message).toContain('Classic token');
  });

  it('returns success for fine-grained token (github_pat_)', async () => {
    const result = await validateField('token', 'github_pat_abc123');
    expect(result?.status).toBe('success');
    expect(result?.message).toContain('Fine-grained');
  });

  it('returns error when owner is empty', async () => {
    const result = await validateField('owner', '');
    expect(result).toEqual({ status: 'error', message: 'Required' });
  });

  it('returns error when owner contains spaces', async () => {
    const result = await validateField('owner', 'my owner');
    expect(result).toEqual({ status: 'error', message: 'Cannot contain spaces' });
  });

  it('returns null for valid owner', async () => {
    const result = await validateField('owner', 'octocat');
    expect(result).toBeNull();
  });

  it('returns error when repo is empty', async () => {
    const result = await validateField('repo', '');
    expect(result).toEqual({ status: 'error', message: 'Required' });
  });

  it('returns error when repo contains spaces', async () => {
    const result = await validateField('repo', 'my repo');
    expect(result).toEqual({ status: 'error', message: 'Cannot contain spaces' });
  });

  it('returns null for valid repo', async () => {
    const result = await validateField('repo', 'hello-world');
    expect(result).toBeNull();
  });

  it('returns null for unknown keys', async () => {
    const result = await validateField('unknown_key', 'anything');
    expect(result).toBeNull();
  });
});

// ---- onAction ----

describe('github-issues plugin — onAction', () => {
  it('returns redirect to sync for sync action', async () => {
    const result = await onAction('sync', {});
    expect(result).toEqual({ redirect: 'sync' });
  });

  it('returns null for unknown action', async () => {
    const result = await onAction('unknown', {});
    expect(result).toBeNull();
  });
});

// ---- buildPrefixMap (custom label prefixes) ----

describe('github-issues plugin — custom label prefixes', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('uses custom label prefixes when configured', async () => {
    const issues = [
      {
        number: 1, title: 'Custom Labels', body: '', state: 'open',
        labels: [{ name: 'type:bug' }, { name: 'p:high' }, { name: 'st:started' }],
        milestone: null, updated_at: '2024-01-01T00:00:00Z',
      },
    ];
    const { backend } = await activateWith(
      (url) => {
        if (url.includes('/issues?')) return makeResponse(200, issues, okHeaders);
        return makeResponse(200, {}, okHeaders);
      },
      { ...defaultSettings, label_prefix_category: 'type:', label_prefix_priority: 'p:', label_prefix_status: 'st:' },
    );

    const changes = await backend.pullChanges(null);
    expect(changes[0].fields.category).toBe('bug');
    expect(changes[0].fields.priority).toBe('high');
    expect(changes[0].fields.status).toBe('started');
  });

  it('pushes with custom label prefixes', async () => {
    const { backend } = await activateWith(
      (url, init) => {
        if (url.includes('/issues') && init?.method === 'POST') {
          return makeResponse(201, { number: 1, title: 'x', body: '', state: 'open', labels: [], milestone: null, updated_at: new Date().toISOString() }, okHeaders);
        }
        return makeResponse(200, {}, okHeaders);
      },
      { ...defaultSettings, label_prefix_category: 'type:', label_prefix_priority: 'p:', label_prefix_status: 'st:' },
    );

    const ticket = {
      id: 1, ticket_number: 'HS-1', title: 'Custom', details: '',
      category: 'bug', priority: 'high', status: 'started', up_next: false, tags: '[]',
    };

    await backend.createRemote(ticket);
    const postCall = fetchCalls.find(c => c.init?.method === 'POST');
    const body = JSON.parse(postCall!.init!.body as string);
    expect(body.labels).toContain('type:bug');
    expect(body.labels).toContain('p:high');
    expect(body.labels).toContain('st:started');
  });
});

// ---- capabilities ----

describe('github-issues plugin — capabilities based on sync_direction', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('has all capabilities for bidirectional (default)', async () => {
    const { backend } = await activateWith(() => makeResponse(200, {}, okHeaders));
    expect(backend.capabilities.create).toBe(true);
    expect(backend.capabilities.update).toBe(true);
    expect(backend.capabilities.delete).toBe(true);
    expect(backend.capabilities.incrementalPull).toBe(true);
    expect(backend.capabilities.comments).toBe(true);
  });

  it('disables write for pull_only', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, sync_direction: 'pull_only' },
    );
    expect(backend.capabilities.create).toBe(false);
    expect(backend.capabilities.update).toBe(false);
    expect(backend.capabilities.delete).toBe(false);
    expect(backend.capabilities.incrementalPull).toBe(true);
  });

  it('disables read for push_only', async () => {
    const { backend } = await activateWith(
      () => makeResponse(200, {}, okHeaders),
      { ...defaultSettings, sync_direction: 'push_only' },
    );
    expect(backend.capabilities.create).toBe(true);
    expect(backend.capabilities.update).toBe(true);
    expect(backend.capabilities.delete).toBe(true);
    expect(backend.capabilities.incrementalPull).toBe(false);
  });
});
