// @vitest-environment happy-dom
// HS-9497 (docs/132 §132.9.2), step 1 — the config-UI renderer's storage seam.
//
// Two things are under test, and the second is the one that matters. First, that the
// plugin store still routes exactly where it did before the extraction — a decoupling
// that quietly changed where values land would be worse than no decoupling. Second,
// that the RENDERER now works against an arbitrary store: that is the whole deliverable,
// because it is what lets AI-tool settings (plain `FileSettings` keys with docs/95 layer
// routing) reuse this UI instead of growing a fourth hand-written settings surface.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreferenceRow } from './pluginConfigDialog.js';
import type { PluginPreference } from './pluginTypes.js';
import { pluginPreferenceStore,type PreferenceStore } from './preferenceStore.js';

const h = vi.hoisted(() => ({
  getPluginGlobalConfig: vi.fn(() => Promise.resolve('global-value')),
  getSettings: vi.fn(() => Promise.resolve({ 'plugin:demo:name': 'project-value' } as Record<string, string>)),
  setPluginGlobalConfig: vi.fn(() => Promise.resolve()),
  updateSettings: vi.fn(() => Promise.resolve()),
  validatePluginField: vi.fn(() => Promise.resolve({ status: 'ok', message: 'fine' })),
  runPluginAction: vi.fn(() => Promise.resolve()),
  getPluginConfigLabels: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../api/index.js', () => ({
  getPluginGlobalConfig: h.getPluginGlobalConfig,
  getSettings: h.getSettings,
  setPluginGlobalConfig: h.setPluginGlobalConfig,
  updateSettings: h.updateSettings,
  validatePluginField: h.validatePluginField,
  runPluginAction: h.runPluginAction,
  getPluginConfigLabels: h.getPluginConfigLabels,
}));

afterEach(() => { vi.clearAllMocks(); });

const globalPref = { key: 'token', label: 'Token', scope: 'global' } as PluginPreference;
const projectPref = { key: 'name', label: 'Name' } as PluginPreference;

describe('pluginPreferenceStore — routing is unchanged by the extraction', () => {
  it('reads a global preference from the plugin global config', async () => {
    const store = pluginPreferenceStore('demo');
    expect(await store.read(globalPref)).toBe('global-value');
    expect(h.getPluginGlobalConfig).toHaveBeenCalledWith('demo', 'token');
  });

  it('reads a project preference from the `plugin:<id>:<key>` setting namespace', async () => {
    const store = pluginPreferenceStore('demo');
    expect(await store.read(projectPref)).toBe('project-value');
  });

  it('returns null (not the empty string) for an unset project preference, so the caller can fall back to `default`', async () => {
    const store = pluginPreferenceStore('demo');
    expect(await store.read({ key: 'missing', label: 'Missing' } as PluginPreference)).toBeNull();
  });

  it('writes each scope to its own backend', () => {
    const store = pluginPreferenceStore('demo');
    store.write(globalPref, 'v1');
    expect(h.setPluginGlobalConfig).toHaveBeenCalledWith('demo', 'token', 'v1');
    store.write(projectPref, 'v2');
    expect(h.updateSettings).toHaveBeenCalledWith({ 'plugin:demo:name': 'v2' });
  });

  it('namespaces DOM ids by plugin id', () => {
    expect(pluginPreferenceStore('demo').namespace).toBe('demo');
  });
});

describe('the renderer works against an ARBITRARY store (HS-9497)', () => {
  function fakeStore(initial: string | null): { store: PreferenceStore; writes: [string, string][] } {
    const writes: [string, string][] = [];
    return {
      writes,
      store: {
        namespace: 'ai-tool',
        read: () => Promise.resolve(initial),
        write: (pref, value) => { writes.push([pref.key, value]); },
        validate: () => Promise.resolve(null),
      },
    };
  }

  it('loads the displayed value from the store, touching no plugin API', async () => {
    const { store } = fakeStore('from-elsewhere');
    const row = createPreferenceRow(store, projectPref);
    await Promise.resolve(); await Promise.resolve();

    expect(row.querySelector<HTMLInputElement>('input')?.value).toBe('from-elsewhere');
    // The point of the seam: a non-plugin store must not reach plugin storage at all.
    expect(h.getSettings).not.toHaveBeenCalled();
    expect(h.getPluginGlobalConfig).not.toHaveBeenCalled();
  });

  it('falls back to the declared default when the store has no value', async () => {
    const { store } = fakeStore(null);
    const row = createPreferenceRow(store, { key: 'name', label: 'Name', default: 'fallback' } as PluginPreference);
    await Promise.resolve(); await Promise.resolve();

    expect(row.querySelector<HTMLInputElement>('input')?.value).toBe('fallback');
  });

  it('namespaces its DOM ids from the store, so two stores can render into one dialog', async () => {
    const { store } = fakeStore('x');
    const row = createPreferenceRow(store, projectPref);
    await Promise.resolve();

    expect(row.querySelector('#pref-input-ai-tool-name')).not.toBeNull();
    expect(row.querySelector('#pref-validation-ai-tool-name')).not.toBeNull();
  });
});
