// @vitest-environment happy-dom
/**
 * HS-9212 — locally customizing a SHARED terminal, hiding it, then un-hiding it
 * must NOT lose the local customization. The fix keeps a hidden terminal's
 * override in the local delta (`{hidden:[id], overrides:{id:{...}}}`) so a
 * hide → un-hide round-trips the customized config rather than reverting to the
 * shared value. These tests drive the real terminals settings editor in Local
 * mode through the load → hide → save → re-enable flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateFileSettingsLayer } from '../api/index.js';
import {
  _getTerminalsForTests,
  _resetTerminalsForTests,
  loadAndRenderTerminalsSettings,
} from './terminalsSettings.js';

const SHARED = [{ id: 't0', command: 'sh-cmd', name: 'Shared Name' }];

// Local layer: the shared terminal is locally OVERRIDDEN (custom name + command)
// but still visible. `resolved` reflects the override merged onto the shared item.
let layered: { shared: Record<string, unknown>; local: Record<string, unknown>; resolved: Record<string, unknown> };

vi.mock('../api/index.js', () => ({
  getLayeredFileSettings: vi.fn(() => Promise.resolve(layered)),
  updateFileSettingsLayer: vi.fn((_layer: string, changed: Record<string, unknown>) => {
    // Echo the write back into the local layer + re-resolve, mimicking the server
    // so a subsequent reload sees the persisted delta.
    Object.assign(layered.local, changed);
    return Promise.resolve(layered);
  }),
  updateFileSettings: vi.fn(() => Promise.resolve({})),
  getCommandSuggestions: vi.fn(() => Promise.resolve([])),
  destroyTerminal: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./commandLog.js', () => ({ previewDrawerTab: vi.fn(() => () => { /* restore no-op */ }) }));
vi.mock('./terminal.js', () => ({ refreshTerminalsAfterSettingsChange: vi.fn(() => Promise.resolve()) }));
vi.mock('./settingsScope.js', () => ({ getScopeMode: () => 'local' }));

const OVERRIDE = { id: 't0', command: 'custom-cmd', name: 'My Custom Name' };

function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#settings-terminals-list .settings-terminal-row:not(.settings-terminal-row-hidden)')];
}
function hiddenRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#settings-terminals-list .settings-terminal-row-hidden')];
}

describe('terminalsSettings — hide → un-hide preserves a local override (HS-9212)', () => {
  beforeEach(async () => {
    _resetTerminalsForTests();
    layered = {
      shared: { terminals: JSON.stringify(SHARED) },
      // Visible, overridden (no hidden yet).
      local: { terminals: { overrides: { t0: OVERRIDE } } },
      resolved: { terminals: JSON.stringify([OVERRIDE]) },
    };
    document.body.innerHTML = '<div id="settings-terminals-list"></div><button id="settings-terminals-add-btn"></button>';
    await loadAndRenderTerminalsSettings();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    _resetTerminalsForTests();
    vi.clearAllMocks();
  });

  it('shows the overridden terminal as a visible row with the custom name', () => {
    expect(visibleRows().length).toBe(1);
    expect(hiddenRows().length).toBe(0);
    expect(visibleRows()[0].querySelector('.cmd-outline-name')?.textContent).toBe('My Custom Name');
  });

  it('hiding the overridden terminal persists BOTH hidden and the override', async () => {
    visibleRows()[0].querySelector<HTMLButtonElement>('.cmd-outline-delete-btn')!.click();
    // handleDelete awaits the (mocked) confirm + drawer preview, then splices +
    // schedules the debounced save.
    await vi.waitFor(() => {
      const calls = vi.mocked(updateFileSettingsLayer).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });
    const [, changed] = vi.mocked(updateFileSettingsLayer).mock.calls.at(-1)!;
    const delta = (changed as { terminals: { hidden?: string[]; overrides?: Record<string, unknown> } }).terminals;
    expect(delta.hidden).toEqual(['t0']);            // hidden on this machine
    expect(delta.overrides).toEqual({ t0: OVERRIDE }); // ...but the override survives
    // The row moved to the hidden section, still showing the custom name.
    expect(visibleRows().length).toBe(0);
    expect(hiddenRows()[0].querySelector('.cmd-outline-name')?.textContent).toBe('My Custom Name');
  });

  it('loading an already hidden+overridden terminal renders the override in the hidden row', async () => {
    // Re-seed as already hidden+overridden, then reload.
    layered.local = { terminals: { hidden: ['t0'], overrides: { t0: OVERRIDE } } };
    layered.resolved = { terminals: JSON.stringify([]) };
    await loadAndRenderTerminalsSettings();
    expect(visibleRows().length).toBe(0);
    expect(hiddenRows().length).toBe(1);
    expect(hiddenRows()[0].querySelector('.cmd-outline-name')?.textContent).toBe('My Custom Name');
  });

  it('re-enabling a hidden+overridden terminal restores the CUSTOM config, not the shared one', async () => {
    layered.local = { terminals: { hidden: ['t0'], overrides: { t0: OVERRIDE } } };
    layered.resolved = { terminals: JSON.stringify([]) };
    await loadAndRenderTerminalsSettings();

    hiddenRows()[0].querySelector<HTMLButtonElement>('.term-reenable-btn')!.click();

    // The terminal is visible again with the custom name (NOT "Shared Name").
    expect(visibleRows().length).toBe(1);
    expect(visibleRows()[0].querySelector('.cmd-outline-name')?.textContent).toBe('My Custom Name');
    expect(_getTerminalsForTests().find(t => t.id === 't0')?.name).toBe('My Custom Name');

    // The persisted delta keeps the override and no longer hides t0.
    await vi.waitFor(() => {
      const calls = vi.mocked(updateFileSettingsLayer).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });
    const [, changed] = vi.mocked(updateFileSettingsLayer).mock.calls.at(-1)!;
    const delta = (changed as { terminals: { hidden?: string[]; overrides?: Record<string, unknown> } }).terminals;
    expect(delta.hidden ?? []).not.toContain('t0');
    expect(delta.overrides).toEqual({ t0: OVERRIDE });
  });
});
