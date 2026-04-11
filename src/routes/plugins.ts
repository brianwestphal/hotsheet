import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { Hono } from 'hono';

import { getConflicts, getSyncRecordsForPlugin } from '../db/sync.js';
import { getDb, runWithDataDir } from '../db/connection.js';
import { upsertSyncRecord } from '../db/sync.js';
import { getTicket } from '../db/tickets.js';
import { getAllProjects } from '../projects.js';
import {
  disablePlugin, enablePlugin, getAllBackends, getAllPluginUIElements,
  getGlobalPluginSetting, getLoadedPlugins,
  getPluginById, reactivatePlugin, setGlobalPluginSetting,
} from '../plugins/loader.js';
import type { LoadedPlugin } from '../plugins/types.js';
import {
  resolveConflict, runSync, startScheduledSync, stopScheduledSync,
} from '../plugins/syncEngine.js';
import { notifyMutation } from './notify.js';
import type { AppEnv } from '../types.js';

export const pluginRoutes = new Hono<AppEnv>();

// --- Per-project plugin enabled state ---

export async function isPluginEnabledForProject(pluginId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [`plugin_enabled:${pluginId}`]);
  // Default: enabled (unless explicitly disabled)
  return result.rows[0]?.value !== 'false';
}

async function setPluginEnabledForProject(pluginId: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [`plugin_enabled:${pluginId}`, String(enabled)],
  );
}

async function checkMissingRequiredPrefs(plugin: LoadedPlugin): Promise<string[]> {
  const required = (plugin.manifest.preferences ?? []).filter(p => p.required);
  if (required.length === 0) return [];
  const missing: string[] = [];
  const db = await getDb();
  for (const pref of required) {
    let value: string | null = null;
    if (pref.scope === 'global') {
      value = getGlobalPluginSetting(plugin.manifest.id, pref.key);
    } else {
      const prefix = `plugin:${plugin.manifest.id}:`;
      const result = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [prefix + pref.key]);
      value = result.rows[0]?.value ?? null;
    }
    if (value === null || value === '') missing.push(pref.key);
  }
  return missing;
}

/** List all loaded plugins with their status. */
pluginRoutes.get('/plugins', async (c) => {
  const loaded = getLoadedPlugins();
  const plugins = await Promise.all(loaded.map(async p => {
    const missingRequired = await checkMissingRequiredPrefs(p);
    const enabledForProject = await isPluginEnabledForProject(p.manifest.id);
    return {
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description ?? null,
      enabled: enabledForProject,
      hasBackend: p.backend !== null,
      error: p.error,
      preferences: p.manifest.preferences ?? [],
      needsConfiguration: missingRequired.length > 0,
      missingFields: missingRequired,
    };
  }));
  return c.json(plugins);
});

/** Get all registered UI elements from enabled plugins. */
pluginRoutes.get('/plugins/ui', async (c) => {
  const { getPluginUIElements } = await import('../plugins/loader.js');
  const registrations = getPluginUIElements();
  const filtered = [];
  for (const reg of registrations) {
    if (!await isPluginEnabledForProject(reg.pluginId)) continue;
    for (const el of reg.elements) {
      filtered.push({ ...el, _pluginId: reg.pluginId });
    }
  }
  return c.json(filtered);
});

/** Trigger a plugin UI action. */
pluginRoutes.post('/plugins/:id/action', async (c) => {
  const pluginId = c.req.param('id');
  const plugin = getPluginById(pluginId);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);
  if (!plugin.instance.onAction) return c.json({ error: 'Plugin does not handle actions' }, 400);
  const body = await c.req.json() as { actionId: string; ticketIds?: number[]; value?: unknown };
  try {
    const result = await plugin.instance.onAction(body.actionId, {
      ticketIds: body.ticketIds,
      value: body.value,
    });
    notifyMutation(c.get('dataDir'));
    return c.json({ ok: true, result });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Validate a plugin config field value. */
pluginRoutes.post('/plugins/validate/:id', async (c) => {
  const plugin = getPluginById(c.req.param('id'));
  if (!plugin?.instance.validateField) return c.json(null);
  const body = await c.req.json() as { key: string; value: string };
  try {
    const result = await plugin.instance.validateField(body.key, body.value);
    return c.json(result);
  } catch {
    return c.json(null);
  }
});

/** Show plugin directory in file manager. */
pluginRoutes.post('/plugins/reveal/:id', async (c) => {
  const plugin = getPluginById(c.req.param('id'));
  if (!plugin?.path) return c.json({ error: 'Plugin not found' }, 404);
  const { openInFileManager } = await import('../open-in-file-manager.js');
  await openInFileManager(plugin.path);
  return c.json({ ok: true });
});

/** Get dynamic config label overrides for a plugin. */
pluginRoutes.get('/plugins/config-labels/:id', async (c) => {
  const { getConfigLabelOverride } = await import('../plugins/loader.js');
  const pluginId = c.req.param('id');
  const plugin = getPluginById(pluginId);
  if (!plugin) return c.json({});
  const labels: Record<string, string> = {};
  const layout = plugin.manifest.configLayout ?? [];
  const findLabels = (items: typeof layout) => {
    for (const item of items) {
      if (item.type === 'label' && item.id) {
        const override = getConfigLabelOverride(pluginId, item.id);
        if (override) labels[item.id] = override;
      }
      if (item.type === 'group' && item.items) findLabels(item.items);
    }
  };
  findLabels(layout);
  return c.json(labels);
});

/** List bundled (official) plugins with install status. */
pluginRoutes.get('/plugins/bundled', async (c) => {
  const { listBundledPlugins } = await import('../plugins/loader.js');
  return c.json(listBundledPlugins());
});

/** Install a specific bundled plugin by ID. */
pluginRoutes.post('/plugins/bundled/:id/install', async (c) => {
  const pluginId = c.req.param('id');
  const { installBundledPlugin, loadAllPlugins } = await import('../plugins/loader.js');
  const ok = installBundledPlugin(pluginId);
  if (!ok) return c.json({ error: 'Failed to install bundled plugin' }, 400);
  await loadAllPlugins();
  return c.json({ ok: true });
});

/** Get details for a single plugin. */
pluginRoutes.get('/plugins/:id', async (c) => {
  const plugin = getPluginById(c.req.param('id'));
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);
  const missingRequired = await checkMissingRequiredPrefs(plugin);
  const enabledForProject = await isPluginEnabledForProject(plugin.manifest.id);
  return c.json({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description ?? null,
    author: plugin.manifest.author ?? null,
    enabled: enabledForProject,
    hasBackend: plugin.backend !== null,
    error: plugin.error,
    preferences: plugin.manifest.preferences ?? [],
    configLayout: plugin.manifest.configLayout,
    path: plugin.path,
    needsConfiguration: missingRequired.length > 0,
    missingFields: missingRequired,
  });
});

/** Enable a plugin for the current project. */
pluginRoutes.post('/plugins/:id/enable', async (c) => {
  const pluginId = c.req.param('id');
  await setPluginEnabledForProject(pluginId, true);
  // Ensure the plugin module is activated globally
  const plugin = getPluginById(pluginId);
  if (plugin && !plugin.enabled) await enablePlugin(pluginId);
  return c.json({ ok: true });
});

/** Disable a plugin for the current project. */
pluginRoutes.post('/plugins/:id/disable', async (c) => {
  const pluginId = c.req.param('id');
  await setPluginEnabledForProject(pluginId, false);
  // Clean up sync records and outbox for this plugin in this project
  const db = await getDb();
  await db.query('DELETE FROM ticket_sync WHERE plugin_id = $1', [pluginId]);
  await db.query('DELETE FROM sync_outbox WHERE plugin_id = $1', [pluginId]);
  return c.json({ ok: true });
});

/** Re-activate a plugin (picks up config changes without restart). */
pluginRoutes.post('/plugins/:id/reactivate', async (c) => {
  const ok = await reactivatePlugin(c.req.param('id'));
  if (!ok) return c.json({ error: 'Failed to reactivate plugin' }, 400);
  return c.json({ ok: true });
});

/** Enable a plugin on all open projects. */
pluginRoutes.post('/plugins/:id/enable-all', async (c) => {
  const pluginId = c.req.param('id');
  for (const project of getAllProjects()) {
    await runWithDataDir(project.dataDir, () => setPluginEnabledForProject(pluginId, true));
  }
  const plugin = getPluginById(pluginId);
  if (plugin && !plugin.enabled) await enablePlugin(pluginId);
  return c.json({ ok: true });
});

/** Disable a plugin on all open projects. */
pluginRoutes.post('/plugins/:id/disable-all', async (c) => {
  const pluginId = c.req.param('id');
  for (const project of getAllProjects()) {
    await runWithDataDir(project.dataDir, () => setPluginEnabledForProject(pluginId, false));
  }
  return c.json({ ok: true });
});

/** Check backend connection status. Always re-activates to pick up config changes. */
pluginRoutes.get('/plugins/:id/status', async (c) => {
  const pluginId = c.req.param('id');
  let plugin = getPluginById(pluginId);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

  // Check required fields before re-activating
  const missing = await checkMissingRequiredPrefs(plugin);
  if (missing.length > 0) {
    return c.json({ connected: false, error: `Missing required fields: ${missing.join(', ')}` });
  }

  // Always re-activate to pick up config changes (activate() re-reads settings)
  await reactivatePlugin(pluginId);
  plugin = getPluginById(pluginId)!;
  if (!plugin.backend) {
    return c.json({ connected: false, error: plugin.error ?? 'Backend not available' });
  }

  const status = await plugin.backend.checkConnection();
  return c.json(status);
});

/** Get sync records for a plugin. */
pluginRoutes.get('/plugins/:id/sync', async (c) => {
  const records = await getSyncRecordsForPlugin(c.req.param('id'));
  return c.json(records);
});

/** Trigger an immediate sync for a plugin. */
pluginRoutes.post('/plugins/:id/sync', async (c) => {
  const pluginId = c.req.param('id');
  const plugin = getPluginById(pluginId);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

  // Check per-project enabled state
  if (!await isPluginEnabledForProject(pluginId)) {
    return c.json({ error: 'Plugin is disabled for this project' }, 400);
  }

  // Always re-activate to read the current project's config (owner, repo, etc.)
  await reactivatePlugin(pluginId);
  const reloaded = getPluginById(pluginId)!;
  if (!reloaded.backend) return c.json({ error: reloaded.error ?? 'No backend' }, 400);

  const result = await runSync(pluginId);
  if ((result.pulled ?? 0) > 0 || (result.pushed ?? 0) > 0) {
    notifyMutation(c.get('dataDir'));
  }
  return c.json(result);
});

/** Push a local-only ticket to a remote backend. */
pluginRoutes.post('/plugins/:id/push-ticket/:ticketId', async (c) => {
  const pluginId = c.req.param('id');
  const ticketId = parseInt(c.req.param('ticketId'), 10);
  if (isNaN(ticketId)) return c.json({ error: 'Invalid ticket ID' }, 400);

  let plugin = getPluginById(pluginId);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

  // Check required config before attempting
  const missing = await checkMissingRequiredPrefs(plugin);
  if (missing.length > 0) {
    return c.json({ error: `Missing required fields: ${missing.join(', ')}` }, 400);
  }

  // Always re-activate to pick up latest config
  await reactivatePlugin(pluginId);
  plugin = getPluginById(pluginId)!;
  if (!plugin.backend) return c.json({ error: plugin.error ?? 'No backend' }, 400);
  if (!plugin.backend.capabilities.create) {
    return c.json({ error: 'Backend does not support creating tickets' }, 400);
  }

  const ticket = await getTicket(ticketId);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Check if already synced
  const db = await getDb();
  const existing = await db.query('SELECT id FROM ticket_sync WHERE ticket_id = $1 AND plugin_id = $2', [ticketId, pluginId]);
  if (existing.rows.length > 0) {
    return c.json({ error: 'Ticket is already synced with this plugin' }, 400);
  }

  const remoteId = await plugin.backend.createRemote(ticket);
  await upsertSyncRecord(ticketId, pluginId, remoteId, 'synced');

  const remoteUrl = plugin.backend.getRemoteUrl?.(remoteId) ?? null;
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true, remoteId, remoteUrl });
});

/** Set sync schedule for a plugin. */
pluginRoutes.post('/plugins/:id/sync/schedule', async (c) => {
  const pluginId = c.req.param('id');
  const plugin = getPluginById(pluginId);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);
  const body = await c.req.json() as { interval_minutes: number | null };
  if (body.interval_minutes === null || body.interval_minutes === 0) {
    stopScheduledSync(pluginId);
    return c.json({ ok: true, scheduled: false });
  }
  const intervalMs = body.interval_minutes * 60 * 1000;
  startScheduledSync(pluginId, intervalMs, c.get('dataDir'));
  return c.json({ ok: true, scheduled: true, interval_minutes: body.interval_minutes });
});

/** List all active backends. */
pluginRoutes.get('/backends', async (c) => {
  const backends = getAllBackends().map(b => {
    const plugin = getPluginById(b.id);
    return {
      id: b.id,
      name: b.name,
      capabilities: b.capabilities,
      icon: plugin?.manifest.icon,
    };
  });
  return c.json(backends);
});

/** Get synced ticket IDs with plugin info (for list view indicators). Only shows enabled plugins. */
pluginRoutes.get('/sync/tickets', async (c) => {
  const db = await getDb();
  const result = await db.query<{ ticket_id: number; plugin_id: string }>('SELECT ticket_id, plugin_id FROM ticket_sync');
  const map: Record<number, { pluginId: string; icon?: string }> = {};
  for (const row of result.rows) {
    if (!await isPluginEnabledForProject(row.plugin_id)) continue;
    const plugin = getPluginById(row.plugin_id);
    map[row.ticket_id] = {
      pluginId: row.plugin_id,
      icon: plugin?.manifest.icon,
    };
  }
  return c.json(map);
});

/** List all sync conflicts (optionally filtered by plugin). */
pluginRoutes.get('/sync/conflicts', async (c) => {
  const pluginId = c.req.query('plugin_id');
  const conflicts = await getConflicts(pluginId);
  return c.json(conflicts);
});

/** Resolve a sync conflict. */
pluginRoutes.post('/sync/conflicts/:ticketId/resolve', async (c) => {
  const ticketId = parseInt(c.req.param('ticketId'), 10);
  const body = await c.req.json() as { plugin_id: string; resolution: 'keep_local' | 'keep_remote' };
  if (!body.plugin_id || !body.resolution) {
    return c.json({ error: 'plugin_id and resolution required' }, 400);
  }
  await resolveConflict(ticketId, body.plugin_id, body.resolution);
  return c.json({ ok: true });
});

/** Install a plugin by symlinking from a local path into ~/.hotsheet/plugins/. */
pluginRoutes.post('/plugins/install', async (c) => {
  const body = await c.req.json() as { path: string };
  if (!body.path) return c.json({ error: 'path is required' }, 400);

  const sourcePath = body.path;
  if (!existsSync(sourcePath)) {
    return c.json({ error: `Path does not exist: ${sourcePath}` }, 400);
  }

  // Check for manifest.json or package.json with hotsheet field
  const hasManifest = existsSync(join(sourcePath, 'manifest.json'));
  const hasPkgHotsheet = (() => {
    const pkgPath = join(sourcePath, 'package.json');
    if (!existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return pkg.hotsheet !== undefined;
    } catch { return false; }
  })();

  if (!hasManifest && !hasPkgHotsheet) {
    return c.json({ error: 'Directory must contain manifest.json or package.json with hotsheet field' }, 400);
  }

  const pluginsDir = join(homedir(), '.hotsheet', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });

  const linkName = basename(sourcePath);
  const linkPath = join(pluginsDir, linkName);

  if (existsSync(linkPath)) {
    return c.json({ error: `Plugin already exists at ${linkPath}` }, 400);
  }

  try {
    symlinkSync(sourcePath, linkPath, 'dir');
  } catch (e) {
    return c.json({ error: `Failed to create symlink: ${e instanceof Error ? e.message : e}` }, 500);
  }

  // Clear dismiss flag if re-installing a previously dismissed plugin
  const { undismissBundledPlugin } = await import('../plugins/loader.js');
  undismissBundledPlugin(linkName);

  return c.json({ ok: true, installed: linkPath });
});

/** Uninstall a plugin by removing it from ~/.hotsheet/plugins/. */
pluginRoutes.post('/plugins/:id/uninstall', async (c) => {
  const pluginId = c.req.param('id');
  const plugin = getPluginById(pluginId);

  // Disable first if enabled
  if (plugin?.enabled) {
    await disablePlugin(pluginId);
  }

  const pluginsDir = join(homedir(), '.hotsheet', 'plugins');
  // Try the stored path first, then fall back to convention
  const candidates = [
    plugin?.path,
    join(pluginsDir, pluginId),
  ].filter((p): p is string => p !== undefined);

  let removed = false;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        rmSync(candidate, { recursive: true, force: true });
        removed = true;
        break;
      } catch { /* try next */ }
    }
  }

  // Remove from in-memory registry and dismiss bundled plugins
  const { unregisterPlugin, dismissBundledPlugin } = await import('../plugins/loader.js');
  unregisterPlugin(pluginId);
  dismissBundledPlugin(pluginId);

  if (!removed && plugin) {
    // Plugin was in memory but directory already gone — still a success
    return c.json({ ok: true, note: 'Plugin directory was already removed' });
  }

  return c.json({ ok: true });
});

/** Get a global plugin setting. */
pluginRoutes.get('/plugins/:id/global-config/:key', async (c) => {
  const value = getGlobalPluginSetting(c.req.param('id'), c.req.param('key'));
  return c.json({ value });
});

/** Set a global plugin setting. */
pluginRoutes.post('/plugins/:id/global-config', async (c) => {
  const body = await c.req.json() as { key: string; value: string };
  if (!body.key) return c.json({ error: 'key is required' }, 400);
  setGlobalPluginSetting(c.req.param('id'), body.key, body.value);
  return c.json({ ok: true });
});
