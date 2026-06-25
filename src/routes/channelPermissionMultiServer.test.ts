// HS-9036 — a permission raised inside a worktree worker's OWN channel server
// (not the FIFO leader) must surface in Hot Sheet, and the response must route
// back to that same server. `fetchPermission` now polls every alive registry
// entry, so we mock the registry to two servers and stub fetch per port.
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { channelRoutes } from './channel.js';

const LEADER_PORT = 9701;
const WORKER_PORT = 9702;

/** Safely stringify a `fetch` argument (it's always a string URL in these tests). */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// Two alive channel servers under the owner data dir: the leader + a "worker".
vi.mock('../channelRegistry.js', () => ({
  listAliveEntries: vi.fn(() => [
    { port: 9701, pid: 111, slug: 'p', startedAt: '2026-01-01T00:00:00Z' },
    { port: 9702, pid: 222, slug: 'p', startedAt: '2026-01-01T00:00:01Z' },
  ]),
  cleanupExtraConnections: vi.fn(),
}));

describe('channel permission — multi-server (HS-9036)', () => {
  let tempDir: string;
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    tempDir = await setupTestDb();
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('dataDir', tempDir); c.set('projectSecret', 'sek'); await next(); });
    app.route('/api', channelRoutes);
  });

  afterAll(async () => {
    await cleanupTestDb(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub `/permission` GETs to return the given pending body per port. */
  function stubPermissionGet(pendingByPort: Record<number, unknown>): void {
    vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const port = urlOf(input).includes(`:${String(WORKER_PORT)}`) ? WORKER_PORT : LEADER_PORT;
      const body = JSON.stringify({ pending: pendingByPort[port] ?? null });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
  }

  it('surfaces a permission raised on the worker (non-leader) server', async () => {
    stubPermissionGet({
      [LEADER_PORT]: null,
      [WORKER_PORT]: { request_id: 'req-w', tool_name: 'Bash', description: 'danger', input_preview: 'rm -rf /tmp/x' },
    });

    const res = await app.request('/api/channel/permission');
    expect(res.status).toBe(200);
    const data = await res.json() as { pending: { request_id: string } | null };
    expect(data.pending?.request_id).toBe('req-w');
  });

  it('routes the response back to the worker server that raised it', async () => {
    // 1) A GET records that req-w2 came from the worker port.
    stubPermissionGet({ [LEADER_PORT]: null, [WORKER_PORT]: { request_id: 'req-w2', tool_name: 'Bash', input_preview: 'ls' } });
    await app.request('/api/channel/permission');
    vi.restoreAllMocks();

    // 2) The respond forward must hit the WORKER port, not the leader.
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      calls.push(urlOf(input));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    const res = await app.request('/api/channel/permission/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: 'req-w2', behavior: 'allow', tool_name: 'Bash' }),
    });
    expect(res.status).toBe(200);
    expect(calls.some(u => u.includes(`:${String(WORKER_PORT)}/permission/respond`))).toBe(true);
    expect(calls.some(u => u.includes(`:${String(LEADER_PORT)}/permission/respond`))).toBe(false);
  });
});
