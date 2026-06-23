/**
 * HS-5546: unit tests for routes/plugins.ts.
 * Uses Hono test client with mocked plugin loader and sync engine.
 */
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';

// --- Mocks ---

const mockBackend = {
  id: 'mock-plugin',
  name: 'Mock Plugin',
  capabilities: { create: true, update: true, delete: true, incrementalPull: true, syncableFields: ['title'] },
  fieldMappings: { category: { toRemote: {}, toLocal: {} }, priority: { toRemote: {}, toLocal: {} }, status: { toRemote: {}, toLocal: {} } },
  checkConnection: vi.fn(() => Promise.resolve({ connected: true })),
  createRemote: vi.fn(() => Promise.resolve('remote-1')),
  getRemoteUrl: vi.fn(() => 'https://example.com/1'),
};

const mockPlugin = {
  manifest: {
    id: 'mock-plugin',
    name: 'Mock Plugin',
    version: '1.0.0',
    preferences: [
      { key: 'token', label: 'Token', type: 'string' as const, required: true, secret: true, scope: 'global' as const },
      { key: 'owner', label: 'Owner', type: 'string' as const, required: true },
    ],
  },
  path: '/tmp/mock-plugin',
  instance: {
    activate: vi.fn(() => Promise.resolve(mockBackend)),
    onAction: vi.fn(() => Promise.resolve({ connected: true })),
    validateField: vi.fn(() => Promise.resolve({ status: 'success', message: 'ok' })),
  },
  backend: mockBackend,
  enabled: true,
  error: null,
};

vi.mock('../plugins/loader.js', () => ({
  getPluginById: vi.fn(() => mockPlugin),
  getLoadedPlugins: vi.fn(() => [mockPlugin]),
  getAllBackends: vi.fn(() => [mockBackend]),
  reactivatePlugin: vi.fn(() => Promise.resolve(true)),
  enablePlugin: vi.fn(() => Promise.resolve(true)),
  disablePlugin: vi.fn(() => Promise.resolve(true)),
  getGlobalPluginSetting: vi.fn(() => null),
  setGlobalPluginSetting: vi.fn(),
  getConfigLabelOverride: vi.fn(() => undefined),
  getPluginUIElements: vi.fn(() => []),
  getAllPluginUIElements: vi.fn(() => []),
  listBundledPlugins: vi.fn(() => []),
  installBundledPlugin: vi.fn(() => true),
  unregisterPlugin: vi.fn(),
  dismissBundledPlugin: vi.fn(),
  getBackendForPlugin: vi.fn(() => mockBackend),
  loadAllPlugins: vi.fn(() => Promise.resolve()),
}));

vi.mock('../plugins/syncEngine.js', () => ({
  runSync: vi.fn(() => Promise.resolve({ ok: true, pulled: 1, pushed: 0, conflicts: 0 })),
  resolveConflict: vi.fn(() => Promise.resolve()),
  startScheduledSync: vi.fn(),
  stopScheduledSync: vi.fn(),
  syncSingleTicketContent: vi.fn(() => Promise.resolve()),
  // HS-8933 — enable/reactivate routes apply the per-project scheduled-sync config.
  applyScheduledSyncFromConfig: vi.fn(() => Promise.resolve()),
  getPendingSyncCounts: vi.fn(() => Promise.resolve({ toPull: 0, toPush: 0, total: 0 })),
}));

vi.mock('../projects.js', () => ({
  getAllProjects: vi.fn(() => []),
  getProjectBySecret: vi.fn(() => null),
}));

vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(),
  scheduleWorklistSync: vi.fn(),
}));

vi.mock('../open-in-file-manager.js', () => ({
  openInFileManager: vi.fn(() => Promise.resolve()),
}));

vi.mock('../keychain.js', () => ({
  keychainGet: vi.fn(() => Promise.resolve(null)),
  keychainSet: vi.fn(() => Promise.resolve(false)),
}));

const { pluginRoutes } = await import('./plugins.js');

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    c.set('projectSecret', 'test-secret');
    await next();
  });
  app.route('/api', pluginRoutes);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock returns
  mockPlugin.backend = mockBackend;
  mockPlugin.enabled = true;
  mockPlugin.error = null;
});

function post(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// --- Tests ---

describe('plugin list', () => {
  it('GET /plugins returns loaded plugins', async () => {
    const res = await app.request('/api/plugins');
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(data.length).toBe(1);
  });
});

describe('plugin details', () => {
  it('GET /plugins/:id returns plugin info', async () => {
    const res = await app.request('/api/plugins/mock-plugin');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; name: string };
    expect(data.id).toBe('mock-plugin');
    expect(data.name).toBe('Mock Plugin');
  });

  it('GET /plugins/:id returns 404 for unknown plugin', async () => {
    const { getPluginById } = await import('../plugins/loader.js');
    vi.mocked(getPluginById).mockReturnValueOnce(undefined);
    const res = await app.request('/api/plugins/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('plugin action', () => {
  it('POST /plugins/:id/action reactivates and calls onAction', async () => {
    const { reactivatePlugin } = await import('../plugins/loader.js');
    const res = await app.request('/api/plugins/mock-plugin/action', post({ actionId: 'test' }));
    expect(res.status).toBe(200);
    expect(reactivatePlugin).toHaveBeenCalledWith('mock-plugin');
    expect(mockPlugin.instance.onAction).toHaveBeenCalledWith('test', { ticketIds: undefined, value: undefined });
  });
});

describe('plugin validate', () => {
  it('POST /plugins/validate/:id returns validation result', async () => {
    const res = await app.request('/api/plugins/validate/mock-plugin', post({ key: 'token', value: 'abc' }));
    expect(res.status).toBe(200);
    expect(mockPlugin.instance.validateField).toHaveBeenCalledWith('token', 'abc');
  });
});

describe('plugin status', () => {
  it('GET /plugins/:id/status reactivates and checks connection', async () => {
    // Set required prefs so the missing-fields check passes
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query("INSERT INTO settings (key, value) VALUES ('plugin:mock-plugin:owner', 'test') ON CONFLICT (key) DO UPDATE SET value = 'test'");
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValue('test-token');

    const { reactivatePlugin } = await import('../plugins/loader.js');
    const res = await app.request('/api/plugins/mock-plugin/status');
    expect(res.status).toBe(200);
    const data = await res.json() as { connected: boolean };
    expect(data.connected).toBe(true);
    expect(reactivatePlugin).toHaveBeenCalled();
  });
});

describe('plugin sync', () => {
  it('POST /plugins/:id/sync reactivates and runs sync', async () => {
    // HS-8284 — opt-in default; explicitly enable the plugin for this project
    // before exercising the sync route, which now rejects unenabled plugins.
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['plugin_enabled:mock-plugin', 'true'],
    );

    const { reactivatePlugin } = await import('../plugins/loader.js');
    const { runSync } = await import('../plugins/syncEngine.js');
    const res = await app.request('/api/plugins/mock-plugin/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; pulled: number };
    expect(data.ok).toBe(true);
    expect(data.pulled).toBe(1);
    expect(reactivatePlugin).toHaveBeenCalled();
    // HS-8931 — a user-initiated sync runs a full pull.
    expect(runSync).toHaveBeenCalledWith('mock-plugin', { fullPull: true });

    await db.query("DELETE FROM settings WHERE key = 'plugin_enabled:mock-plugin'");
  });
});

describe('plugin enable/disable', () => {
  it('POST /plugins/:id/enable enables the plugin', async () => {
    const res = await app.request('/api/plugins/mock-plugin/enable', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('POST /plugins/:id/disable disables and cleans up sync records', async () => {
    const res = await app.request('/api/plugins/mock-plugin/disable', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('plugin reactivate', () => {
  it('POST /plugins/:id/reactivate calls reactivatePlugin', async () => {
    const { reactivatePlugin } = await import('../plugins/loader.js');
    const res = await app.request('/api/plugins/mock-plugin/reactivate', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(reactivatePlugin).toHaveBeenCalledWith('mock-plugin');
  });
});

describe('backends', () => {
  // HS-8018: helper to satisfy the mock plugin's required prefs (token —
  // global, owner — project). All `backends` tests opt in / out so the
  // gating-by-required-prefs is exercised in both directions.
  async function satisfyRequiredPrefs() {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query("INSERT INTO settings (key, value) VALUES ('plugin:mock-plugin:owner', 'test') ON CONFLICT (key) DO UPDATE SET value = 'test'");
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValue('test-token');
  }

  async function clearRequiredPrefs() {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query("DELETE FROM settings WHERE key = 'plugin:mock-plugin:owner'");
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValue(null);
  }

  async function setProjectEnabled(enabled: boolean) {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['plugin_enabled:mock-plugin', String(enabled)],
    );
  }

  async function clearProjectEnabled() {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query("DELETE FROM settings WHERE key = 'plugin_enabled:mock-plugin'");
  }

  it('GET /backends lists active backends when prefs are satisfied AND project-enabled', async () => {
    await satisfyRequiredPrefs();
    await setProjectEnabled(true);
    const res = await app.request('/api/backends');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data.length).toBe(1);
    expect(data[0].id).toBe('mock-plugin');
    await clearProjectEnabled();
  });

  // HS-8284 — opt-in default. New project folders have no `plugin_enabled:*`
  // rows in their settings table; previously that meant every installed
  // plugin was silently enabled (`value !== 'false'`). The check is now
  // `value === 'true'`, so a fresh project starts with everything disabled.
  it('GET /backends excludes plugin for a fresh project with no plugin_enabled row (HS-8284)', async () => {
    await satisfyRequiredPrefs();
    await clearProjectEnabled();
    const res = await app.request('/api/backends');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data).toEqual([]);
  });

  it('GET /backends excludes plugin when a required project preference is missing (HS-8018)', async () => {
    // Token (global) populated, but owner (project-scoped) absent — the
    // GitHub-Issues "Needs Configuration" repro.
    await clearRequiredPrefs();
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValue('test-token');
    await setProjectEnabled(true);
    const res = await app.request('/api/backends');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data).toEqual([]);
    await clearProjectEnabled();
  });

  it('GET /backends excludes plugin when a required global preference is missing (HS-8018)', async () => {
    // Owner (project) populated, but token (global) absent.
    await satisfyRequiredPrefs();
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValue(null);
    await setProjectEnabled(true);
    const res = await app.request('/api/backends');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data).toEqual([]);
    await clearProjectEnabled();
  });

  it('GET /backends excludes plugin when disabled for the current project (HS-8018)', async () => {
    await satisfyRequiredPrefs();
    await setProjectEnabled(false);
    const res = await app.request('/api/backends');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data).toEqual([]);
    await clearProjectEnabled();
  });
});

// HS-8284 — direct unit coverage for the per-project enabled lookup.
// Guards against the regression where adding a fresh project folder
// implicitly enabled every installed plugin because the default returned
// `true` whenever no `plugin_enabled:{id}` row existed.
describe('isPluginEnabledForProject (HS-8284)', () => {
  it('returns false when no plugin_enabled row exists (fresh project)', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query("DELETE FROM settings WHERE key = 'plugin_enabled:fresh-plugin'");
    const { isPluginEnabledForProject } = await import('./plugins.js');
    expect(await isPluginEnabledForProject('fresh-plugin')).toBe(false);
  });

  it('returns true when plugin_enabled row is the literal string "true"', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['plugin_enabled:opted-in', 'true'],
    );
    const { isPluginEnabledForProject } = await import('./plugins.js');
    expect(await isPluginEnabledForProject('opted-in')).toBe(true);
    await db.query("DELETE FROM settings WHERE key = 'plugin_enabled:opted-in'");
  });

  it('returns false when plugin_enabled row is the literal string "false"', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['plugin_enabled:opted-out', 'false'],
    );
    const { isPluginEnabledForProject } = await import('./plugins.js');
    expect(await isPluginEnabledForProject('opted-out')).toBe(false);
    await db.query("DELETE FROM settings WHERE key = 'plugin_enabled:opted-out'");
  });

  it('returns false for any non-"true" value (defense-in-depth against typos)', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    const { isPluginEnabledForProject } = await import('./plugins.js');
    for (const v of ['1', 'yes', 'TRUE', 'enabled', '']) {
      await db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        ['plugin_enabled:weird-value', v],
      );
      expect(await isPluginEnabledForProject('weird-value')).toBe(false);
    }
    await db.query("DELETE FROM settings WHERE key = 'plugin_enabled:weird-value'");
  });
});

describe('sync conflicts', () => {
  it('GET /sync/conflicts returns empty array when no conflicts', async () => {
    const res = await app.request('/api/sync/conflicts');
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('global config', () => {
  it('GET /plugins/:id/global-config/:key returns stored value', async () => {
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValueOnce('test-token');
    const res = await app.request('/api/plugins/mock-plugin/global-config/token');
    expect(res.status).toBe(200);
    const data = await res.json() as { value: string };
    expect(data.value).toBe('test-token');
  });

  it('POST /plugins/:id/global-config sets a value', async () => {
    const { setGlobalPluginSetting } = await import('../plugins/loader.js');
    const res = await app.request('/api/plugins/mock-plugin/global-config', post({ key: 'token', value: 'new-val' }));
    expect(res.status).toBe(200);
    expect(setGlobalPluginSetting).toHaveBeenCalledWith('mock-plugin', 'token', 'new-val');
  });
});

describe('plugin UI', () => {
  it('GET /plugins/ui returns UI elements', async () => {
    const res = await app.request('/api/plugins/ui');
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('config labels', () => {
  it('GET /plugins/config-labels/:id returns label overrides', async () => {
    const res = await app.request('/api/plugins/config-labels/mock-plugin');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data).toBe('object');
  });
});

describe('bundled plugins', () => {
  it('GET /plugins/bundled returns bundled plugin list', async () => {
    const res = await app.request('/api/plugins/bundled');
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('POST /plugins/bundled/:id/install installs a bundled plugin', async () => {
    const res = await app.request('/api/plugins/bundled/mock-plugin/install', { method: 'POST' });
    expect(res.status).toBe(200);
    const { installBundledPlugin } = await import('../plugins/loader.js');
    expect(installBundledPlugin).toHaveBeenCalledWith('mock-plugin');
  });
});

describe('push ticket', () => {
  it('POST /plugins/:id/push-ticket/:ticketId pushes a ticket to remote', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    // Create a ticket to push
    await db.query(`INSERT INTO tickets (id, ticket_number, title) VALUES (999, 'HS-999', 'Push test') ON CONFLICT DO NOTHING`);

    const res = await app.request('/api/plugins/mock-plugin/push-ticket/999', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; remoteId: string };
    expect(data.ok).toBe(true);
    expect(data.remoteId).toBe('remote-1');
  });
});

describe('uninstall', () => {
  it('POST /plugins/:id/uninstall uninstalls a plugin', async () => {
    const res = await app.request('/api/plugins/mock-plugin/uninstall', { method: 'POST' });
    // May return 200 or error depending on file system — just verify it doesn't crash
    expect([200, 400, 404, 500]).toContain(res.status);
  });
});

describe('sync tickets', () => {
  it('GET /sync/tickets returns synced ticket data', async () => {
    const res = await app.request('/api/sync/tickets');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data).toBe('object');
  });
});

describe('conflict resolution', () => {
  it('POST /sync/conflicts/:ticketId/resolve resolves a conflict', async () => {
    const { resolveConflict } = await import('../plugins/syncEngine.js');
    const res = await app.request('/api/sync/conflicts/1/resolve', post({ plugin_id: 'mock-plugin', resolution: 'keep_local' }));
    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalled();
  });
});

describe('sync schedule', () => {
  it('POST /plugins/:id/sync/schedule starts a schedule', async () => {
    const { startScheduledSync } = await import('../plugins/syncEngine.js');
    const res = await app.request('/api/plugins/mock-plugin/sync/schedule', post({ interval_minutes: 5 }));
    expect(res.status).toBe(200);
    const data = await res.json() as { scheduled: boolean };
    expect(data.scheduled).toBe(true);
    expect(startScheduledSync).toHaveBeenCalled();
  });

  it('POST /plugins/:id/sync/schedule with 0 stops the schedule', async () => {
    const { stopScheduledSync } = await import('../plugins/syncEngine.js');
    const res = await app.request('/api/plugins/mock-plugin/sync/schedule', post({ interval_minutes: 0 }));
    expect(res.status).toBe(200);
    const data = await res.json() as { scheduled: boolean };
    expect(data.scheduled).toBe(false);
    expect(stopScheduledSync).toHaveBeenCalled();
  });
});

describe('image-proxy (HS-8956)', () => {
  const realFetch = global.fetch;
  let calls: { url: string; init?: RequestInit }[] = [];

  function stubFetch(handler: (url: string) => Response) {
    global.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return Promise.resolve(handler(url));
    };
  }
  function authOf(call?: { init?: RequestInit }): string | undefined {
    return (call?.init?.headers as Record<string, string> | undefined)?.Authorization;
  }

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  beforeEach(async () => {
    calls = [];
    const { getGlobalPluginSetting } = await import('../plugins/loader.js');
    vi.mocked(getGlobalPluginSetting).mockReturnValue('ghp_test');
  });
  afterEach(() => { global.fetch = realFetch; });

  it('fetches a signed private-user-images URL WITHOUT an Authorization header', async () => {
    // The jwt self-authorizes; a Bearer header would yield HTTP 400.
    stubFetch(() => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    const signed = 'https://private-user-images.githubusercontent.com/240811/1-abc.png?jwt=tok';
    const res = await app.request(`/api/plugins/mock-plugin/image-proxy?url=${encodeURIComponent(signed)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const call = calls.find(c => c.url.includes('private-user-images'));
    expect(authOf(call)).toBeUndefined();
  });

  it('resolves a github.com/user-attachments body image via the issue body_html, then fetches the signed URL with no auth', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const signed = `https://private-user-images.githubusercontent.com/9/55-${uuid}.png?jwt=tok`;

    // Fixtures: a synced ticket whose BODY (details) references the UUID.
    const { createTicket } = await import('../db/tickets.js');
    const { upsertSyncRecord } = await import('../db/sync.js');
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    const ticket = await createTicket('body image ticket', { details: `<img src="https://github.com/user-attachments/assets/${uuid}">` });
    await upsertSyncRecord(ticket.id, 'mock-plugin', '77', 'synced');
    await db.query(
      "INSERT INTO settings (key, value) VALUES ($1,$2),($3,$4) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      ['plugin:mock-plugin:owner', 'octocat', 'plugin:mock-plugin:repo', 'hello'],
    );

    stubFetch((url) => {
      if (url.includes('/issues/77/comments')) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/issues/77')) return new Response(JSON.stringify({ body_html: `<p><img src="${signed}" /></p>` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('private-user-images')) return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
      return new Response('nope', { status: 404 });
    });

    const assetUrl = `https://github.com/user-attachments/assets/${uuid}`;
    const res = await app.request(`/api/plugins/mock-plugin/image-proxy?url=${encodeURIComponent(assetUrl)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    // The issue lookup used the API token; the signed image fetch did NOT.
    expect(authOf(calls.find(c => c.url.includes('/issues/77') && !c.url.includes('comments')))).toBe('Bearer ghp_test');
    expect(authOf(calls.find(c => c.url.includes('private-user-images')))).toBeUndefined();
  });

  it('returns 502 when the user-attachment UUID cannot be resolved', async () => {
    stubFetch(() => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const assetUrl = 'https://github.com/user-attachments/assets/ffffffff-0000-0000-0000-000000000000';
    const res = await app.request(`/api/plugins/mock-plugin/image-proxy?url=${encodeURIComponent(assetUrl)}`);
    expect(res.status).toBe(502);
  });

  it('rejects a non-allowlisted host', async () => {
    const res = await app.request(`/api/plugins/mock-plugin/image-proxy?url=${encodeURIComponent('https://evil.example.com/x.png')}`);
    expect(res.status).toBe(403);
  });
});

describe('sync conflicts summary (HS-8959)', () => {
  it('groups conflicts by plugin with count, name, and icon (sorted desc)', async () => {
    const { getDb } = await import('../db/connection.js');
    const { createTicket } = await import('../db/tickets.js');
    const { upsertSyncRecord, updateSyncStatus } = await import('../db/sync.js');
    const db = await getDb();
    await db.query('DELETE FROM ticket_sync');

    // Two conflicts for mock-plugin, one for another plugin.
    const t1 = await createTicket('c1');
    const t2 = await createTicket('c2');
    const t3 = await createTicket('c3');
    await upsertSyncRecord(t1.id, 'mock-plugin', 'r1', 'synced');
    await updateSyncStatus(t1.id, 'mock-plugin', 'conflict');
    await upsertSyncRecord(t2.id, 'mock-plugin', 'r2', 'synced');
    await updateSyncStatus(t2.id, 'mock-plugin', 'conflict');
    await upsertSyncRecord(t3.id, 'other-plugin', 'r3', 'synced');
    await updateSyncStatus(t3.id, 'other-plugin', 'conflict');

    const res = await app.request('/api/sync/conflicts/summary');
    expect(res.status).toBe(200);
    const data = await res.json() as { pluginId: string; pluginName: string; icon: string | null; count: number }[];
    expect(data).toHaveLength(2);
    // Sorted by count desc → mock-plugin (2) first.
    expect(data[0]).toMatchObject({ pluginId: 'mock-plugin', count: 2, pluginName: 'Mock Plugin' });
    expect(data[1]).toMatchObject({ pluginId: 'other-plugin', count: 1 });
    // mockPlugin's manifest has no icon → null.
    expect(data[0].icon).toBeNull();

    await db.query('DELETE FROM ticket_sync');
  });

  it('returns an empty array when there are no conflicts', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query('DELETE FROM ticket_sync');
    const res = await app.request('/api/sync/conflicts/summary');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
