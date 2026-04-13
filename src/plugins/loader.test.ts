import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpdir } = os;

// Mock homedir to use a temp directory for plugin discovery tests
const tempHome = join(tmpdir(), `hs-plugin-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const { discoverPlugins } = await import('./loader.js');

beforeAll(() => {
  mkdirSync(join(tempHome, '.hotsheet', 'plugins'), { recursive: true });
});

afterAll(() => {
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
