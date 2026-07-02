// @vitest-environment happy-dom
/**
 * HS-9209 — `moveScopedListItem` moves ONE item of a scoped list (terminals /
 * custom_views / auto_context) between the shared and local layers, editing both
 * layer files. This drives the real function against an in-memory layered-settings
 * store and asserts each layer ends up correct, mirroring the custom-commands
 * `moveCommandLayer` integration test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiIndex from '../api/index.js';
import { moveScopedListItem } from './settingsScopeList.js';

interface Term { id: string; command: string; name?: string }

const store = vi.hoisted((): { shared: Record<string, unknown>; local: Record<string, unknown> } => ({
  shared: {},
  local: {},
}));
const cleared = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock('../api/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiIndex>()),
  getLayeredFileSettings: vi.fn(() => Promise.resolve({
    shared: { ...store.shared },
    local: { ...store.local },
    resolved: {},
  })),
  updateFileSettingsLayer: vi.fn((layer: 'shared' | 'local', patch: Record<string, unknown>) => {
    Object.assign(store[layer], patch);
    return Promise.resolve({ shared: {}, local: {} });
  }),
  clearLocalSettingOverride: vi.fn((keys: string[]) => {
    for (const k of keys) { cleared.keys.push(k); store.local[k] = undefined; }
    return Promise.resolve({});
  }),
}));

const idOf = (t: Term): string => t.id;

describe('moveScopedListItem (HS-9209)', () => {
  beforeEach(() => {
    store.shared = {};
    store.local = {};
    cleared.keys = [];
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('to-shared: promotes a local-only terminal into settings.json + clears the emptied delta', async () => {
    store.shared.terminals = [{ id: 'sh', command: 'bash' }];
    store.local.terminals = { added: [{ id: 'lo', command: '{{claudeCommand}}' }] };

    await moveScopedListItem<Term>('terminals', idOf, 'lo', 'to-shared');

    expect((store.shared.terminals as Term[]).map(idOf)).toEqual(['sh', 'lo']);
    // The delta emptied → the local key is cleared (not left as a stray `{}`).
    expect(cleared.keys).toContain('terminals');
    expect(store.local.terminals).toBeUndefined();
  });

  it('to-local: demotes a shared terminal to a local addition, dropping it from settings.json', async () => {
    store.shared.terminals = [{ id: 'a', command: 'bash' }, { id: 'b', command: 'zsh' }];
    store.local.terminals = undefined;

    await moveScopedListItem<Term>('terminals', idOf, 'b', 'to-local');

    expect((store.shared.terminals as Term[]).map(idOf)).toEqual(['a']); // b left the shared layer
    const delta = store.local.terminals as { added?: Term[] };
    expect(delta.added?.map(idOf)).toEqual(['b']);
  });

  it('to-local folds a local override into the demoted item', async () => {
    store.shared.terminals = [{ id: 'a', command: 'bash', name: 'Shell' }];
    store.local.terminals = { overrides: { a: { name: 'My Shell' } } };

    await moveScopedListItem<Term>('terminals', idOf, 'a', 'to-local');

    expect(store.shared.terminals as Term[]).toEqual([]); // a removed from shared
    const delta = store.local.terminals as { added?: Term[]; overrides?: unknown };
    // The added item carries the machine-local name, and the override entry is gone.
    expect(delta.added).toEqual([{ id: 'a', command: 'bash', name: 'My Shell' }]);
    expect(delta.overrides).toBeUndefined();
  });

  it('a to-local then to-shared round-trip restores the shared list and clears the delta', async () => {
    store.shared.terminals = [{ id: 'a', command: 'bash' }, { id: 'b', command: 'zsh' }];
    store.local.terminals = undefined;

    await moveScopedListItem<Term>('terminals', idOf, 'b', 'to-local');
    await moveScopedListItem<Term>('terminals', idOf, 'b', 'to-shared');

    expect(new Set((store.shared.terminals as Term[]).map(idOf))).toEqual(new Set(['a', 'b']));
    expect(store.local.terminals).toBeUndefined();
  });
});
