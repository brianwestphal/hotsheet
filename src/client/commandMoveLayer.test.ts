// @vitest-environment happy-dom
/**
 * HS-9264 — moving the BOTTOM-MOST local custom command to Shared did nothing.
 *
 * Root cause: "Add Command" pushes a new command WITHOUT an id, so a Local-mode
 * save stored it in `delta.added` id-less; `loadScopedCommands` then backfilled a
 * DIFFERENT random id into the editor tree, so `moveTopLevelToShared` (which
 * matches by id) couldn't find it. Earlier additions escaped because a later save
 * re-derived the delta from an already-backfilled tree — only the most-recently
 * added (bottom-most) command kept an id-less delta entry.
 *
 * Fix: `saveCommandItems` backfills the editor tree BEFORE deriving the delta, so
 * the persisted `delta.added` id matches what the editor shows. This test drives
 * the real client flow (add → save → reload → move) against an in-memory layered-
 * settings store and asserts the bottom-most command actually promotes to Shared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiIndex from '../api/index.js';
import type { CommandItem } from '../settingsCommandDelta.js';
import {
  getEditTree,
  loadScopedCommands,
  moveCommandLayer,
  saveCommandItems,
} from './experimentalSettings.js';
import type * as SettingsScope from './settingsScope.js';

// In-memory layered settings store the mocked API reads/writes.
const store = vi.hoisted((): { shared: { custom_commands: unknown }; local: { custom_commands: unknown } } => ({
  shared: { custom_commands: [] },
  local: { custom_commands: undefined },
}));

vi.mock('../api/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiIndex>()),
  getLayeredFileSettings: vi.fn(() => Promise.resolve({
    shared: { custom_commands: store.shared.custom_commands },
    local: { custom_commands: store.local.custom_commands },
  })),
  updateFileSettingsLayer: vi.fn((layer: 'shared' | 'local', patch: { custom_commands: unknown }) => {
    store[layer].custom_commands = patch.custom_commands;
    return Promise.resolve({ shared: {}, local: {} });
  }),
  clearLocalSettingOverride: vi.fn(() => { store.local.custom_commands = undefined; return Promise.resolve({}); }),
  getSettings: vi.fn(() => Promise.resolve({ custom_commands: '' })),
}));
vi.mock('./settingsScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsScope>()),
  getScopeMode: () => 'local',
}));
vi.mock('./commandSidebar.js', () => ({ renderChannelCommands: vi.fn() }));

function names(items: unknown): string[] {
  return Array.isArray(items) ? (items as CommandItem[]).map(i => i.name) : [];
}

describe('moveCommandLayer — bottom-most local command promotes to Shared (HS-9264)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="settings-commands-list"></div>';
    store.shared.custom_commands = [{ id: 's1', name: 'SharedOne', prompt: 'sp', target: 'shell' }];
    store.local.custom_commands = undefined;
  });

  afterEach(() => { document.body.innerHTML = ''; });

  it('adds two local commands then moves the bottom-most one to Shared', async () => {
    // Load the Local editor tree (shared resolved against an empty delta).
    await loadScopedCommands();

    // Simulate "Add Command" twice — each pushes an id-less command like the UI does.
    getEditTree().push({ name: 'LocalA', prompt: 'a', target: 'shell' });
    await saveCommandItems();
    await loadScopedCommands();
    getEditTree().push({ name: 'LocalB', prompt: 'b', target: 'shell' });
    await saveCommandItems();
    await loadScopedCommands();

    // Bottom-most row = last item in the editor tree.
    const tree = getEditTree();
    const bottom = tree[tree.length - 1];
    expect(bottom.name).toBe('LocalB');
    const bottomId = bottom.id;
    expect(typeof bottomId).toBe('string');
    expect(bottomId).not.toBe('');

    // Promote the bottom-most local command to Shared.
    await moveCommandLayer(bottomId ?? '', 'to-shared', 'top');

    // It must now live in the SHARED layer, and be gone from the local delta's `added`.
    expect(names(store.shared.custom_commands)).toContain('LocalB');
    const localAdded = (store.local.custom_commands as { added?: CommandItem[] } | undefined)?.added ?? [];
    expect(localAdded.map(i => i.name)).not.toContain('LocalB');
    // Sanity: the OTHER local command is unaffected (still local-only).
    expect(names(store.shared.custom_commands)).not.toContain('LocalA');
  });
});
