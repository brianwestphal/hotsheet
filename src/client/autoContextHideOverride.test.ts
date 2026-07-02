// @vitest-environment happy-dom
/**
 * HS-9219 (follow-up to HS-9212) — locally customizing a SHARED auto-context
 * entry, disabling it, then re-enabling it must NOT lose the local customization.
 * The fix keeps a disabled entry's override in the local delta
 * (`{hidden:[id], overrides:{id:{...}}}`) so a disable → re-enable round-trips the
 * customized text rather than reverting to the shared value. These tests drive the
 * real auto-context editor (`bindAutoContextSettings`) in Local mode through
 * load → re-enable and load → disable, asserting BOTH the UI and the persisted
 * delta. Mirrors `terminalsHideOverride.test.ts` for the sibling editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateFileSettingsLayer } from '../api/index.js';
import {
  _getAutoContextEntriesForTests,
  _resetAutoContextForTests,
  bindAutoContextSettings,
} from './settingsDialog.js';
import type * as SettingsScopeModule from './settingsScope.js';
import { type CategoryDef, state } from './state.js';

const SHARED = [{ type: 'category', key: 'bug', text: 'Shared bug context' }];
const OVERRIDE_TEXT = 'My custom bug context';
const AC_ID = 'category:bug';

let layered: { shared: Record<string, unknown>; local: Record<string, unknown>; resolved: Record<string, unknown> };

vi.mock('../api/index.js', () => ({
  getLayeredFileSettings: vi.fn(() => Promise.resolve(layered)),
  updateFileSettingsLayer: vi.fn((_layer: string, changed: Record<string, unknown>) => {
    Object.assign(layered.local, changed); // echo the write into the local layer, like the server
    return Promise.resolve(layered);
  }),
  clearLocalSettingOverride: vi.fn(() => Promise.resolve(layered)),
  getTags: vi.fn(() => Promise.resolve([])),
}));
const scopeMode = vi.hoisted((): { value: 'shared' | 'local' } => ({ value: 'local' }));
vi.mock('./settingsScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsScopeModule>()),
  getScopeMode: () => scopeMode.value,
}));

function acRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#auto-context-list .auto-context-entry')];
}
function visibleRows(): HTMLElement[] {
  return acRows().filter(r => !r.classList.contains('locally-disabled') && !r.classList.contains('auto-context-default'));
}
function disabledRows(): HTMLElement[] {
  return acRows().filter(r => r.classList.contains('locally-disabled'));
}
async function load(): Promise<void> {
  bindAutoContextSettings();
  document.dispatchEvent(new CustomEvent('hotsheet:scope-mode-changed'));
  await vi.waitFor(() => { expect(document.querySelector('#auto-context-list .auto-context-entry')).not.toBeNull(); });
}
function lastLocalDelta(): { hidden?: string[]; overrides?: Record<string, unknown> } {
  const [, changed] = vi.mocked(updateFileSettingsLayer).mock.calls.at(-1)!;
  return (changed as { auto_context: { hidden?: string[]; overrides?: Record<string, unknown> } }).auto_context;
}

describe('auto-context editor — disable → re-enable preserves a local override (HS-9219)', () => {
  beforeEach(() => {
    _resetAutoContextForTests();
    scopeMode.value = 'local';
    const bugCat: CategoryDef = { id: 'bug', label: 'Bug', shortLabel: 'Bug', color: '#f00', shortcutKey: 'b', description: '' };
    state.categories = [bugCat];
    document.body.innerHTML = '<div id="auto-context-list"></div><button id="auto-context-add-btn"></button>';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    _resetAutoContextForTests();
    vi.clearAllMocks();
  });

  it('loads an already hidden+overridden entry as a disabled row (no visible row)', async () => {
    layered = {
      shared: { auto_context: JSON.stringify(SHARED) },
      local: { auto_context: { hidden: [AC_ID], overrides: { [AC_ID]: { text: OVERRIDE_TEXT } } } },
      resolved: { auto_context: JSON.stringify([]) }, // hidden → absent from the resolved list
    };
    await load();
    expect(visibleRows().length).toBe(0);
    expect(disabledRows().length).toBe(1);
    expect(disabledRows()[0].querySelector('[data-scope-action="reenable"]')).not.toBeNull();
  });

  it('re-enabling a hidden+overridden entry restores the CUSTOM text + drops it from `hidden`, keeping `overrides`', async () => {
    layered = {
      shared: { auto_context: JSON.stringify(SHARED) },
      local: { auto_context: { hidden: [AC_ID], overrides: { [AC_ID]: { text: OVERRIDE_TEXT } } } },
      resolved: { auto_context: JSON.stringify([]) },
    };
    await load();

    disabledRows()[0].querySelector<HTMLButtonElement>('[data-scope-action="reenable"]')!.click();

    // Back to a visible row whose textarea shows the CUSTOM text (not the shared value).
    expect(visibleRows().length).toBe(1);
    expect(visibleRows()[0].querySelector<HTMLTextAreaElement>('.auto-context-text')!.value).toBe(OVERRIDE_TEXT);
    expect(_getAutoContextEntriesForTests().find(e => `${e.type}:${e.key}` === AC_ID)?.text).toBe(OVERRIDE_TEXT);

    // The persisted delta keeps the override and no longer hides it.
    await vi.waitFor(() => { expect(vi.mocked(updateFileSettingsLayer).mock.calls.length).toBeGreaterThan(0); });
    const delta = lastLocalDelta();
    expect(delta.hidden ?? []).not.toContain(AC_ID);
    expect((delta.overrides?.[AC_ID] as { text?: string } | undefined)?.text).toBe(OVERRIDE_TEXT);
  });

  it('disabling a visible overridden entry persists BOTH `hidden` and the override', async () => {
    // Loaded visible + overridden (equivalent to a prior local edit).
    layered = {
      shared: { auto_context: JSON.stringify(SHARED) },
      local: { auto_context: { overrides: { [AC_ID]: { text: OVERRIDE_TEXT } } } },
      resolved: { auto_context: JSON.stringify([{ type: 'category', key: 'bug', text: OVERRIDE_TEXT }]) },
    };
    await load();
    expect(visibleRows().length).toBe(1);
    expect(visibleRows()[0].querySelector<HTMLTextAreaElement>('.auto-context-text')!.value).toBe(OVERRIDE_TEXT);

    visibleRows()[0].querySelector<HTMLButtonElement>('.category-delete-btn')!.click();

    // The entry moved to a disabled row, and the delta carries hidden + the override.
    expect(disabledRows().length).toBe(1);
    await vi.waitFor(() => { expect(vi.mocked(updateFileSettingsLayer).mock.calls.length).toBeGreaterThan(0); });
    const delta = lastLocalDelta();
    expect(delta.hidden).toContain(AC_ID);
    expect((delta.overrides?.[AC_ID] as { text?: string } | undefined)?.text).toBe(OVERRIDE_TEXT);
  });
});
