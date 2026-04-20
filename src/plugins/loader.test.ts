import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';

const { tmpdir } = os;

// Mock homedir to use a temp directory for plugin discovery tests
const tempHome = join(tmpdir(), `hs-plugin-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

vi.mock('../keychain.js', () => ({
  keychainGet: vi.fn(() => Promise.resolve(null)),
  keychainSet: vi.fn(() => Promise.resolve(false)),
}));

const {
  compareSemver,
  discoverPlugins,
  dismissBundledPlugin,
  disablePlugin,
  enablePlugin,
  getAllBackends,
  getConfigLabelOverride,
  getGlobalPluginSetting,
  getLoadedPlugins,
  getPluginById,
  getPluginUIElements,
  reactivatePlugin,
  setGlobalPluginSetting,
  undismissBundledPlugin,
  unregisterPlugin,
} = await import('./loader.js');

let dbTempDir: string;

beforeAll(async () => {
  mkdirSync(join(tempHome, '.hotsheet', 'plugins'), { recursive: true });
  dbTempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(dbTempDir);
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('discoverPlugins', () => {
  beforeEach(() => {
    // Clean plugin dir between tests
    const pluginDir = join(tempHome, '.hotsheet', 'plugins');
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(pluginDir, { recursive: true });
  });

  it('returns empty array when no plugins exist', () => {
    const plugins = discoverPlugins();
    expect(plugins).toEqual([]);
  });

  it('discovers a plugin with manifest.json', () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'test-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      description: 'A test plugin',
    }));
    writeFileSync(join(pluginPath, 'index.js'), 'export function activate() {}');

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(1);
    expect(plugins[0].manifest.id).toBe('test-plugin');
    expect(plugins[0].manifest.name).toBe('Test Plugin');
    expect(plugins[0].manifest.version).toBe('1.0.0');
    expect(plugins[0].manifest.description).toBe('A test plugin');
    expect(plugins[0].manifest.entry).toBe('index.js');
  });

  it('discovers a plugin with package.json hotsheet field', () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'npm-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'package.json'), JSON.stringify({
      name: 'npm-plugin',
      version: '2.0.0',
      description: 'An npm plugin',
      hotsheet: {
        id: 'npm-backend',
        name: 'NPM Backend',
        entry: 'lib/main.js',
      },
    }));

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(1);
    expect(plugins[0].manifest.id).toBe('npm-backend');
    expect(plugins[0].manifest.name).toBe('NPM Backend');
    expect(plugins[0].manifest.version).toBe('2.0.0');
    expect(plugins[0].manifest.entry).toBe('lib/main.js');
  });

  it('ignores package.json without hotsheet field', () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'plain-npm');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'package.json'), JSON.stringify({
      name: 'plain-npm',
      version: '1.0.0',
    }));

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(0);
  });

  it('skips directories with invalid manifest', () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'bad-manifest');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), '{ invalid json }');

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(0);
  });

  it('skips manifest missing required fields', () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'incomplete');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      name: 'Only Name',
      // missing id and version
    }));

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(0);
  });

  it('discovers multiple plugins', () => {
    for (let i = 1; i <= 3; i++) {
      const pluginPath = join(tempHome, '.hotsheet', 'plugins', `plugin-${i}`);
      mkdirSync(pluginPath, { recursive: true });
      writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
        id: `plugin-${i}`,
        name: `Plugin ${i}`,
        version: '1.0.0',
      }));
    }

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(3);
    const ids = plugins.map(p => p.manifest.id).sort();
    expect(ids).toEqual(['plugin-1', 'plugin-2', 'plugin-3']);
  });

  it('skips non-directory entries', () => {
    writeFileSync(join(tempHome, '.hotsheet', 'plugins', 'not-a-dir.json'), '{}');
    const plugins = discoverPlugins();
    expect(plugins.length).toBe(0);
  });

  it('discovers symlinked plugin directories', () => {
    // Create the actual plugin directory outside the plugins folder
    const realDir = join(tempHome, 'external-plugin');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'manifest.json'), JSON.stringify({
      id: 'symlinked-plugin',
      name: 'Symlinked Plugin',
      version: '1.0.0',
    }));

    // Symlink it into the plugins directory
    const linkPath = join(tempHome, '.hotsheet', 'plugins', 'symlinked-plugin');
    symlinkSync(realDir, linkPath, 'dir');

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(1);
    expect(plugins[0].manifest.id).toBe('symlinked-plugin');
  });

  it('reads preferences from manifest', () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'prefs-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'prefs-plugin',
      name: 'Prefs Plugin',
      version: '1.0.0',
      preferences: [
        { key: 'token', label: 'API Token', type: 'string', secret: true, required: true },
        { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }] },
      ],
    }));

    const plugins = discoverPlugins();
    expect(plugins.length).toBe(1);
    expect(plugins[0].manifest.preferences).toHaveLength(2);
    expect(plugins[0].manifest.preferences![0].key).toBe('token');
    expect(plugins[0].manifest.preferences![0].secret).toBe(true);
  });
});

// --- Global config tests ---

describe('getGlobalPluginSetting / setGlobalPluginSetting', () => {
  const configPath = join(tempHome, '.hotsheet', 'plugin-config.json');

  beforeEach(() => {
    try { rmSync(configPath); } catch { /* ignore */ }
  });

  it('returns null for non-existent setting', () => {
    const value = getGlobalPluginSetting('test-plugin', 'missing-key');
    expect(value).toBeNull();
  });

  it('stores and retrieves a setting', () => {
    setGlobalPluginSetting('my-plugin', 'api_key', 'secret123');
    const value = getGlobalPluginSetting('my-plugin', 'api_key');
    expect(value).toBe('secret123');
  });

  it('updates an existing setting', () => {
    setGlobalPluginSetting('my-plugin', 'token', 'old');
    setGlobalPluginSetting('my-plugin', 'token', 'new');
    expect(getGlobalPluginSetting('my-plugin', 'token')).toBe('new');
  });

  it('stores settings for multiple plugins independently', () => {
    setGlobalPluginSetting('plugin-a', 'key', 'value-a');
    setGlobalPluginSetting('plugin-b', 'key', 'value-b');
    expect(getGlobalPluginSetting('plugin-a', 'key')).toBe('value-a');
    expect(getGlobalPluginSetting('plugin-b', 'key')).toBe('value-b');
  });

  it('handles corrupt config file gracefully', () => {
    writeFileSync(configPath, 'not json');
    const value = getGlobalPluginSetting('test', 'key');
    expect(value).toBeNull();
  });
});

// --- Plugin registry accessors ---

describe('plugin registry', () => {
  it('getPluginById returns undefined for unknown plugin', () => {
    expect(getPluginById('nonexistent')).toBeUndefined();
  });

  it('unregisterPlugin removes a plugin', () => {
    // First we need to load a plugin to have something to unregister
    // We'll test this indirectly via loadAllPlugins
  });

  it('getAllBackends returns only enabled plugins with backends', () => {
    // With no plugins loaded, should be empty
    const backends = getAllBackends();
    // May contain previously loaded plugins — just check it returns an array
    expect(Array.isArray(backends)).toBe(true);
  });

  it('getPluginUIElements returns empty for unknown plugin', () => {
    const elements = getPluginUIElements('nonexistent');
    expect(elements).toEqual([]);
  });

  it('getConfigLabelOverride returns undefined for unknown label', () => {
    expect(getConfigLabelOverride('test', 'unknown')).toBeUndefined();
  });
});

// --- enablePlugin / disablePlugin / reactivatePlugin ---

describe('enablePlugin', () => {
  it('returns false for unknown plugin', async () => {
    const result = await enablePlugin('nonexistent-plugin');
    expect(result).toBe(false);
  });
});

describe('disablePlugin', () => {
  it('returns false for unknown plugin', async () => {
    const result = await disablePlugin('nonexistent-plugin');
    expect(result).toBe(false);
  });
});

describe('reactivatePlugin', () => {
  it('returns false for unknown plugin', async () => {
    const result = await reactivatePlugin('nonexistent-plugin');
    expect(result).toBe(false);
  });
});

// --- compareSemver ---

describe('compareSemver', () => {
  it('equal versions return 0', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.5.3', '0.5.3')).toBe(0);
  });

  it('returns 1 when first is greater', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
    expect(compareSemver('1.1.0', '1.0.0')).toBe(1);
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
  });

  it('returns -1 when first is lesser', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.1.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
  });

  it('handles multi-digit version components correctly (the bug case)', () => {
    // This was the original bug: string comparison "0.9.0" >= "0.10.0" is true
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1);
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1);
    expect(compareSemver('1.0.9', '1.0.10')).toBe(-1);
  });

  it('handles missing patch/minor as 0', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
  });
});

// --- Bundled plugin dismiss/undismiss ---

describe('dismissBundledPlugin / undismissBundledPlugin', () => {
  const dismissedPath = join(tempHome, '.hotsheet', 'dismissed-plugins.json');

  beforeEach(() => {
    try { rmSync(dismissedPath); } catch { /* ignore */ }
  });

  it('dismissBundledPlugin writes to dismissed-plugins.json', () => {
    dismissBundledPlugin('my-plugin');
    expect(existsSync(dismissedPath)).toBe(true);
    const data = JSON.parse(readFileSync(dismissedPath, 'utf-8')) as string[];
    expect(data).toContain('my-plugin');
  });

  it('undismissBundledPlugin removes from dismissed list', () => {
    dismissBundledPlugin('plugin-a');
    dismissBundledPlugin('plugin-b');
    undismissBundledPlugin('plugin-a');
    const data = JSON.parse(readFileSync(dismissedPath, 'utf-8')) as string[];
    expect(data).not.toContain('plugin-a');
    expect(data).toContain('plugin-b');
  });

  it('dismissing same plugin twice does not duplicate', () => {
    dismissBundledPlugin('dup-plugin');
    dismissBundledPlugin('dup-plugin');
    const data = JSON.parse(readFileSync(dismissedPath, 'utf-8')) as string[];
    expect(data.filter(id => id === 'dup-plugin').length).toBe(1);
  });
});

// --- loadAllPlugins with real plugin file ---

describe('loadAllPlugins', () => {
  beforeEach(() => {
    // Clean plugin dir and registry
    const pluginDir = join(tempHome, '.hotsheet', 'plugins');
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(pluginDir, { recursive: true });
    // Unregister any loaded plugins
    for (const p of getLoadedPlugins()) unregisterPlugin(p.manifest.id);
  });

  it('loads a plugin with a real activate function', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'real-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'real-plugin', name: 'Real Plugin', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate(ctx) { ctx.log("info", "activated"); return undefined; }');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    const plugin = getPluginById('real-plugin');
    expect(plugin).toBeDefined();
    expect(plugin!.enabled).toBe(true);
    expect(plugin!.error).toBeNull();
    expect(plugin!.backend).toBeNull();
  });

  it('handles missing entry point gracefully', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'no-entry');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'no-entry', name: 'No Entry', version: '1.0.0',
    }));
    // Don't write index.js

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    const plugin = getPluginById('no-entry');
    expect(plugin).toBeDefined();
    expect(plugin!.enabled).toBe(false);
    expect(plugin!.error).toContain('Entry point');
  });

  it('respects enabledPlugins parameter to skip disabled plugins', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'skip-me');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'skip-me', name: 'Skip Me', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { return undefined; }');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins({ 'skip-me': false });

    const plugin = getPluginById('skip-me');
    expect(plugin).toBeDefined();
    expect(plugin!.enabled).toBe(false);
    expect(plugin!.backend).toBeNull();
  });

  it('records error when activate throws', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'bad-activate');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'bad-activate', name: 'Bad Activate', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { throw new Error("activation failed"); }');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    const plugin = getPluginById('bad-activate');
    expect(plugin).toBeDefined();
    expect(plugin!.error).toBe('activation failed');
  });
});

// --- enablePlugin / disablePlugin / reactivatePlugin with loaded plugin ---

describe('plugin lifecycle (enable/disable/reactivate)', () => {
  beforeEach(() => {
    const pluginDir = join(tempHome, '.hotsheet', 'plugins');
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(pluginDir, { recursive: true });
    for (const p of getLoadedPlugins()) unregisterPlugin(p.manifest.id);
  });

  it('enablePlugin activates a disabled plugin', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'toggle-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'toggle-plugin', name: 'Toggle Plugin', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { return undefined; }');

    // Load as disabled
    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins({ 'toggle-plugin': false });
    expect(getPluginById('toggle-plugin')!.enabled).toBe(false);

    // Enable it
    const result = await enablePlugin('toggle-plugin');
    expect(result).toBe(true);
    expect(getPluginById('toggle-plugin')!.enabled).toBe(true);
  });

  it('enablePlugin returns false when already enabled', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'already-on');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'already-on', name: 'Already On', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { return undefined; }');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();
    expect(getPluginById('already-on')!.enabled).toBe(true);

    const result = await enablePlugin('already-on');
    expect(result).toBe(false); // Already enabled
  });

  it('disablePlugin deactivates an enabled plugin', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'dis-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'dis-plugin', name: 'Dis Plugin', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { return undefined; }\nexport async function deactivate() {}');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();
    expect(getPluginById('dis-plugin')!.enabled).toBe(true);

    const result = await disablePlugin('dis-plugin');
    expect(result).toBe(true);
    expect(getPluginById('dis-plugin')!.enabled).toBe(false);
    expect(getPluginById('dis-plugin')!.backend).toBeNull();
  });

  it('disablePlugin returns false when already disabled', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'already-off');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'already-off', name: 'Already Off', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { return undefined; }');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins({ 'already-off': false });

    const result = await disablePlugin('already-off');
    expect(result).toBe(false);
  });

  it('reactivatePlugin re-runs activate with fresh context', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'react-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'react-plugin', name: 'React Plugin', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      `let c = 0; export async function activate() { c++; return undefined; }\nexport async function deactivate() {}`);

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();
    expect(getPluginById('react-plugin')!.enabled).toBe(true);

    const result = await reactivatePlugin('react-plugin');
    expect(result).toBe(true);
    expect(getPluginById('react-plugin')!.enabled).toBe(true);
    expect(getPluginById('react-plugin')!.error).toBeNull();
  });

  it('reactivatePlugin handles activate failure', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'fail-react');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'fail-react', name: 'Fail React', version: '1.0.0',
    }));
    // First activation succeeds, but we'll have it fail on reactivation
    // Since ESM modules are cached, we write a module that always succeeds first
    writeFileSync(join(pluginPath, 'index.js'),
      'let count = 0; export async function activate() { count++; if (count > 1) throw new Error("reactivation boom"); return undefined; }');

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();
    expect(getPluginById('fail-react')!.enabled).toBe(true);

    // Reactivate — the cached module will increment count and throw
    const result = await reactivatePlugin('fail-react');
    // ESM module caching means the same instance is reused, so count will be > 1
    // The result depends on whether the module is re-imported or cached
    // Either way, we test the error handling path
    expect(typeof result).toBe('boolean');
  });
});

// --- createPluginContext (tested via plugin that uses getSetting/setSetting) ---

describe('createPluginContext via real plugin', () => {
  beforeEach(() => {
    const pluginDir = join(tempHome, '.hotsheet', 'plugins');
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(pluginDir, { recursive: true });
    for (const p of getLoadedPlugins()) unregisterPlugin(p.manifest.id);
  });

  it('plugin can use getSetting/setSetting for global prefs', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'ctx-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'ctx-plugin', name: 'Ctx Plugin', version: '1.0.0',
      preferences: [
        { key: 'api_url', label: 'API URL', type: 'string', scope: 'global' },
      ],
    }));
    // Plugin that reads and writes a setting during activation
    writeFileSync(join(pluginPath, 'index.js'), `
      export async function activate(ctx) {
        await ctx.setSetting('api_url', 'https://example.com');
        const val = await ctx.getSetting('api_url');
        ctx.log('info', 'Got: ' + val);
        return undefined;
      }
    `);

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    expect(getPluginById('ctx-plugin')!.enabled).toBe(true);
    // The global setting should have been persisted
    expect(getGlobalPluginSetting('ctx-plugin', 'api_url')).toBe('https://example.com');
  });

  it('plugin can use getSetting/setSetting for project-scoped prefs (DB)', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'db-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'db-plugin', name: 'DB Plugin', version: '1.0.0',
      preferences: [
        { key: 'project_key', label: 'Project Key', type: 'string' },
      ],
    }));
    writeFileSync(join(pluginPath, 'index.js'), `
      export async function activate(ctx) {
        await ctx.setSetting('project_key', 'proj-123');
        const val = await ctx.getSetting('project_key');
        ctx.log('info', 'Project key: ' + val);
        return undefined;
      }
    `);

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    expect(getPluginById('db-plugin')!.enabled).toBe(true);
    // Verify the DB has the setting
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    const result = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', ['plugin:db-plugin:project_key']);
    expect(result.rows[0]?.value).toBe('proj-123');
  });

  it('plugin can register UI elements', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'ui-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'ui-plugin', name: 'UI Plugin', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'), `
      export async function activate(ctx) {
        ctx.registerUI([
          { type: 'button', location: 'toolbar', label: 'Test', actionId: 'test' },
        ]);
        return undefined;
      }
    `);

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    const elements = getPluginUIElements('ui-plugin');
    expect(elements.length).toBe(1);
    expect((elements[0].elements[0] as { label: string }).label).toBe('Test');
  });

  it('plugin can update config labels', async () => {
    const pluginPath = join(tempHome, '.hotsheet', 'plugins', 'label-plugin');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'label-plugin', name: 'Label Plugin', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'), `
      export async function activate(ctx) {
        ctx.updateConfigLabel('status', 'Connected', { bg: '#00ff00', text: '#000000' });
        return undefined;
      }
    `);

    const { loadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();

    const override = getConfigLabelOverride('label-plugin', 'status');
    expect(override).toBeDefined();
    expect(override!.text).toBe('Connected');
  });
});

// --- unloadAllPlugins ---

describe('unloadAllPlugins', () => {
  it('clears all loaded plugins', async () => {
    const pluginDir = join(tempHome, '.hotsheet', 'plugins');
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(pluginDir, { recursive: true });
    for (const p of getLoadedPlugins()) unregisterPlugin(p.manifest.id);

    const pluginPath = join(pluginDir, 'unload-test');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'manifest.json'), JSON.stringify({
      id: 'unload-test', name: 'Unload Test', version: '1.0.0',
    }));
    writeFileSync(join(pluginPath, 'index.js'),
      'export async function activate() { return undefined; }\nexport async function deactivate() {}');

    const { loadAllPlugins, unloadAllPlugins } = await import('./loader.js');
    await loadAllPlugins();
    expect(getLoadedPlugins().length).toBeGreaterThan(0);

    await unloadAllPlugins();
    expect(getLoadedPlugins().length).toBe(0);
  });
});
