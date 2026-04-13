import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { ConfigLabelColor, HotSheetPlugin, LoadedPlugin, PluginContext, PluginManifest, PluginUIElement, PluginUIRegistration, TicketingBackend } from './types.js';

// --- Global plugin registry ---

// UI elements registered by plugins
const pluginUIRegistry = new Map<string, PluginUIElement[]>();

// Dynamic config label overrides (pluginId:labelId → { text, color? })
interface ConfigLabelOverride { text: string; color?: ConfigLabelColor }
const configLabelOverrides = new Map<string, ConfigLabelOverride>();

export function getConfigLabelOverride(pluginId: string, labelId: string): ConfigLabelOverride | undefined {
  return configLabelOverrides.get(`${pluginId}:${labelId}`);
}

export function getPluginUIElements(pluginId?: string): PluginUIRegistration[] {
  if (pluginId) {
    const elements = pluginUIRegistry.get(pluginId);
    return elements ? [{ pluginId, elements }] : [];
  }
  return Array.from(pluginUIRegistry.entries()).map(([id, elements]) => ({ pluginId: id, elements }));
}

export function getAllPluginUIElements(): PluginUIElement[] {
  const all: PluginUIElement[] = [];
  for (const elements of pluginUIRegistry.values()) all.push(...elements);
  return all;
}

const loadedPlugins = new Map<string, LoadedPlugin>();

export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}

export function getPluginById(id: string): LoadedPlugin | undefined {
  return loadedPlugins.get(id);
}

export function unregisterPlugin(id: string): void {
  loadedPlugins.delete(id);
}

export function getBackendForPlugin(pluginId: string): TicketingBackend | null {
  return loadedPlugins.get(pluginId)?.backend ?? null;
}

export function getAllBackends(): TicketingBackend[] {
  return getLoadedPlugins()
    .filter(p => p.backend !== null && p.enabled)
    .map(p => p.backend!);
}

// --- Plugin directory ---

function getPluginDir(): string {
  return join(homedir(), '.hotsheet', 'plugins');
}

// --- Plugin discovery ---

export function discoverPlugins(): { path: string; manifest: PluginManifest }[] {
  const pluginDir = getPluginDir();
  if (!existsSync(pluginDir)) return [];

  const results: { path: string; manifest: PluginManifest }[] = [];

  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    // Check directory or symlink that resolves to a directory
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pluginPath = join(pluginDir, entry.name);
    if (entry.isSymbolicLink()) {
      try { if (!statSync(pluginPath).isDirectory()) continue; } catch { continue; }
    }
    const manifest = readManifest(pluginPath);
    if (manifest) results.push({ path: pluginPath, manifest });
  }

  return results;
}

function readManifest(pluginPath: string): PluginManifest | null {
  // Try manifest.json first
  const manifestPath = join(pluginPath, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      return validateManifest(raw);
    } catch (e) {
      console.warn(`[plugins] Invalid manifest.json in ${pluginPath}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  // Try package.json with hotsheet field
  const pkgPath = join(pluginPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.hotsheet) {
        return validateManifest({
          id: pkg.hotsheet.id ?? pkg.name,
          name: pkg.hotsheet.name ?? pkg.name,
          version: pkg.version ?? '0.0.0',
          description: pkg.description,
          author: pkg.author?.name ?? pkg.author,
          entry: pkg.hotsheet.entry ?? pkg.main ?? 'index.js',
          preferences: pkg.hotsheet.preferences,
        });
      }
    } catch (e) {
      console.warn(`[plugins] Invalid package.json in ${pluginPath}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return null;
}

function validateManifest(raw: unknown): PluginManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id === '') return null;
  if (typeof obj.name !== 'string' || obj.name === '') return null;
  if (typeof obj.version !== 'string') return null;
  return {
    id: obj.id,
    name: obj.name,
    version: obj.version,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    author: typeof obj.author === 'string' ? obj.author : undefined,
    entry: typeof obj.entry === 'string' ? obj.entry : 'index.js',
    icon: typeof obj.icon === 'string' ? obj.icon : undefined,
    preferences: Array.isArray(obj.preferences) ? obj.preferences : undefined,
    configLayout: Array.isArray(obj.configLayout) ? obj.configLayout : undefined,
  };
}

// --- Bundled plugin auto-install ---

function getDismissedPluginsPath(): string {
  return join(homedir(), '.hotsheet', 'dismissed-plugins.json');
}

function getDismissedPlugins(): Set<string> {
  const path = getDismissedPluginsPath();
  if (!existsSync(path)) return new Set();
  try { return new Set(JSON.parse(readFileSync(path, 'utf-8'))); } catch { return new Set(); }
}

export function dismissBundledPlugin(pluginId: string): void {
  const dismissed = getDismissedPlugins();
  dismissed.add(pluginId);
  const path = getDismissedPluginsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...dismissed]));
}

export function undismissBundledPlugin(pluginId: string): void {
  const dismissed = getDismissedPlugins();
  dismissed.delete(pluginId);
  writeFileSync(getDismissedPluginsPath(), JSON.stringify([...dismissed]));
}

function getBundledDir(): string | null {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  let bundledDir = join(selfDir, 'plugins');
  if (!existsSync(bundledDir)) bundledDir = join(process.cwd(), 'dist', 'plugins');
  return existsSync(bundledDir) ? bundledDir : null;
}

/** List all bundled plugins with their install status. */
export function listBundledPlugins(): { manifest: PluginManifest; installed: boolean; dismissed: boolean }[] {
  const bundledDir = getBundledDir();
  if (!bundledDir) return [];
  const dismissed = getDismissedPlugins();
  const results: { manifest: PluginManifest; installed: boolean; dismissed: boolean }[] = [];
  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(bundledDir, entry.name));
    if (!manifest) continue;
    results.push({
      manifest,
      installed: loadedPlugins.has(manifest.id),
      dismissed: dismissed.has(manifest.id),
    });
  }
  return results;
}

/** Install a specific bundled plugin by ID (un-dismisses and copies). */
export function installBundledPlugin(pluginId: string): boolean {
  const bundledDir = getBundledDir();
  if (!bundledDir) return false;
  const pluginDir = getPluginDir();
  mkdirSync(pluginDir, { recursive: true });
  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(bundledDir, entry.name));
    if (!manifest || manifest.id !== pluginId) continue;
    const targetPath = join(pluginDir, entry.name);
    try {
      if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
      cpSync(join(bundledDir, entry.name), targetPath, { recursive: true, force: true });
      undismissBundledPlugin(pluginId);
      console.log(`[plugins] Installed bundled plugin: ${manifest.name}`);
      return true;
    } catch (e) {
      console.warn(`[plugins] Failed to install bundled plugin ${pluginId}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
  return false;
}

/** Copy bundled plugins from dist/plugins/ into ~/.hotsheet/plugins/ if not already present. */
export function installBundledPlugins(): void {
  const bundledDir = getBundledDir();
  if (!bundledDir) return;

  const pluginDir = getPluginDir();
  mkdirSync(pluginDir, { recursive: true });
  const dismissed = getDismissedPlugins();

  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Check if user has dismissed this bundled plugin
    const bundledManifestCheck = readManifest(join(bundledDir, entry.name));
    if (bundledManifestCheck && dismissed.has(bundledManifestCheck.id)) continue;
    const targetPath = join(pluginDir, entry.name);
    const sourcePath = join(bundledDir, entry.name);

    // Check if existing install is valid and up-to-date
    if (existsSync(targetPath)) {
      const installedManifest = readManifest(targetPath);
      const bundledManifest = readManifest(sourcePath);
      if (installedManifest && bundledManifest) {
        const entryFile = installedManifest.entry ?? 'index.js';
        const entryExists = existsSync(join(targetPath, entryFile));
        if (entryExists && installedManifest.version >= bundledManifest.version) {
          continue; // Valid install with same or newer version
        }
      }
      // Remove stale/broken install (symlink or directory) before replacing
      try { rmSync(targetPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    try {
      cpSync(sourcePath, targetPath, { recursive: true, force: true });
      console.log(`[plugins] Installed bundled plugin: ${entry.name}`);
    } catch (e) {
      console.warn(`[plugins] Failed to install bundled plugin ${entry.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// --- Plugin loading ---

export async function loadAllPlugins(enabledPlugins?: Record<string, boolean>): Promise<void> {
  installBundledPlugins();

  const discovered = discoverPlugins();
  if (discovered.length === 0) return;

  console.log(`[plugins] Found ${discovered.length} plugin(s)`);

  for (const { path, manifest } of discovered) {
    const enabled = enabledPlugins?.[manifest.id] !== false;
    await loadPlugin(path, manifest, enabled);
  }
}

async function loadPlugin(pluginPath: string, manifest: PluginManifest, enabled: boolean): Promise<void> {
  const entry = manifest.entry ?? 'index.js';
  const entryPath = join(pluginPath, entry);

  if (!existsSync(entryPath)) {
    console.warn(`[plugins] Plugin ${manifest.id}: entry point ${entry} not found`);
    loadedPlugins.set(manifest.id, {
      manifest,
      path: pluginPath,
      instance: { activate: async () => {} },
      backend: null,
      enabled: false,
      error: `Entry point ${entry} not found`,
    });
    return;
  }

  try {
    const moduleUrl = pathToFileURL(entryPath).href;
    const mod = await import(moduleUrl) as { default?: HotSheetPlugin; activate?: HotSheetPlugin['activate']; onAction?: HotSheetPlugin['onAction']; validateField?: HotSheetPlugin['validateField'] };
    const plugin: HotSheetPlugin = mod.default ?? { activate: mod.activate!, onAction: mod.onAction, validateField: mod.validateField };

    let backend: TicketingBackend | null = null;
    let error: string | null = null;

    if (enabled) {
      try {
        const context = createPluginContext(manifest);
        const result = await plugin.activate(context);
        if (result) backend = result;
        console.log(`[plugins] Loaded: ${manifest.name} v${manifest.version}${backend ? ' (backend)' : ''}`);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.error(`[plugins] Failed to activate ${manifest.id}: ${error}`);
      }
    }

    loadedPlugins.set(manifest.id, {
      manifest,
      path: pluginPath,
      instance: plugin,
      backend,
      enabled,
      error,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[plugins] Failed to load ${manifest.id}: ${error}`);
    loadedPlugins.set(manifest.id, {
      manifest,
      path: pluginPath,
      instance: { activate: async () => {} },
      backend: null,
      enabled: false,
      error,
    });
  }
}

// --- Global plugin config (stored in ~/.hotsheet/plugin-config.json) ---

function getGlobalConfigPath(): string {
  return join(homedir(), '.hotsheet', 'plugin-config.json');
}

function readGlobalConfig(): Record<string, Record<string, string>> {
  const configPath = getGlobalConfigPath();
  if (!existsSync(configPath)) return {};
  try { return JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return {}; }
}

function writeGlobalConfig(config: Record<string, Record<string, string>>): void {
  const configPath = getGlobalConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getGlobalPluginSetting(pluginId: string, key: string): string | null {
  const config = readGlobalConfig();
  return config[pluginId]?.[key] ?? null;
}

export function setGlobalPluginSetting(pluginId: string, key: string, value: string): void {
  const config = readGlobalConfig();
  if (!config[pluginId]) config[pluginId] = {};
  config[pluginId][key] = value;
  writeGlobalConfig(config);
}

function isGlobalPref(manifest: PluginManifest, key: string): boolean {
  return manifest.preferences?.find(p => p.key === key)?.scope === 'global';
}

function createPluginContext(manifest: PluginManifest): PluginContext {
  const prefix = `plugin:${manifest.id}:`;
  return {
    config: {},
    log(level, message) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[plugin:${manifest.id}] ${message}`);
    },
    async getSetting(key) {
      if (isGlobalPref(manifest, key)) {
        return getGlobalPluginSetting(manifest.id, key);
      }
      const { getDb } = await import('../db/connection.js');
      const db = await getDb();
      const result = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [prefix + key]);
      return result.rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      if (isGlobalPref(manifest, key)) {
        setGlobalPluginSetting(manifest.id, key, value);
        return;
      }
      const { getDb } = await import('../db/connection.js');
      const db = await getDb();
      await db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [prefix + key, value],
      );
    },
    registerUI(elements) {
      pluginUIRegistry.set(manifest.id, elements);
    },
    updateConfigLabel(labelId, text, color) {
      configLabelOverrides.set(`${manifest.id}:${labelId}`, { text, color });
    },
  };
}

// --- Plugin lifecycle ---

export async function unloadAllPlugins(): Promise<void> {
  for (const [id, plugin] of loadedPlugins) {
    try {
      await plugin.instance.deactivate?.();
    } catch (e) {
      console.warn(`[plugins] Error deactivating ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  loadedPlugins.clear();
}

export async function enablePlugin(id: string): Promise<boolean> {
  const plugin = loadedPlugins.get(id);
  if (!plugin || plugin.enabled) return false;

  try {
    const context = createPluginContext(plugin.manifest);
    const result = await plugin.instance.activate(context);
    plugin.backend = result ?? null;
    plugin.enabled = true;
    plugin.error = null;
    console.log(`[plugins] Enabled: ${plugin.manifest.name}`);
    return true;
  } catch (e) {
    plugin.error = e instanceof Error ? e.message : String(e);
    console.error(`[plugins] Failed to enable ${id}: ${plugin.error}`);
    return false;
  }
}

export async function disablePlugin(id: string): Promise<boolean> {
  const plugin = loadedPlugins.get(id);
  if (!plugin || !plugin.enabled) return false;

  try {
    await plugin.instance.deactivate?.();
  } catch (e) {
    console.warn(`[plugins] Error deactivating ${id}: ${e instanceof Error ? e.message : e}`);
  }

  plugin.backend = null;
  plugin.enabled = false;
  console.log(`[plugins] Disabled: ${plugin.manifest.name}`);
  return true;
}

/** Re-activate a plugin to pick up configuration changes. */
export async function reactivatePlugin(id: string): Promise<boolean> {
  const plugin = loadedPlugins.get(id);
  if (!plugin) return false;

  // Deactivate if currently active
  if (plugin.enabled) {
    try { await plugin.instance.deactivate?.(); } catch { /* ignore */ }
  }

  // Re-activate with fresh context (re-reads settings)
  try {
    const context = createPluginContext(plugin.manifest);
    const result = await plugin.instance.activate(context);
    plugin.backend = result ?? null;
    plugin.enabled = true;
    plugin.error = null;
    console.log(`[plugins] Reactivated: ${plugin.manifest.name}`);
    return true;
  } catch (e) {
    plugin.error = e instanceof Error ? e.message : String(e);
    plugin.enabled = false;
    plugin.backend = null;
    console.error(`[plugins] Failed to reactivate ${id}: ${plugin.error}`);
    return false;
  }
}
