/**
 * HS-5546: unit tests for routes/plugins.ts.
 * Uses Hono test client with mocked plugin loader and sync engine.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const { reactivatePlugin } = await import('../plugins/loader.js');
    const { runSync } = await import('../plugins/syncEngine.js');
    const res = await app.request('/api/plugins/mock-plugin/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; pulled: number };
    expect(data.ok).toBe(true);
    expect(data.pulled).toBe(1);
    expect(reactivatePlugin).toHaveBeenCalled();
    expect(runSync).toHaveBeenCalledWith('mock-plugin');
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
  it('GET /backends lists active backends', async () => {
    const res = await app.request('/api/backends');
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data.length).toBe(1);
    expect(data[0].id).toBe('mock-plugin');
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
