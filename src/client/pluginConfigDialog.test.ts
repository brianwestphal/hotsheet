// @vitest-environment happy-dom
// HS-9144 — branch coverage for the plugin config layout renderer + preference row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreferenceRow, renderConfigLayout } from './pluginConfigDialog.js';
import type { ConfigLayoutItem, PluginPreference } from './pluginTypes.js';
import { pluginPreferenceStore } from './preferenceStore.js';

const h = vi.hoisted(() => ({
  getPluginGlobalConfig: vi.fn(() => Promise.resolve('')),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  runPluginAction: vi.fn(() => Promise.resolve()),
  getPluginConfigLabels: vi.fn(() => Promise.resolve({} as Record<string, { text: string; color: string }>)),
  setPluginGlobalConfig: vi.fn(() => Promise.resolve()),
  updateSettings: vi.fn(() => Promise.resolve()),
  validatePluginField: vi.fn(() => Promise.resolve({ valid: true })),
  getPluginConfigLabelsExtra: vi.fn(),
}));
vi.mock('../api/index.js', () => ({
  getPluginGlobalConfig: h.getPluginGlobalConfig,
  getSettings: h.getSettings,
  runPluginAction: h.runPluginAction,
  getPluginConfigLabels: h.getPluginConfigLabels,
  setPluginGlobalConfig: h.setPluginGlobalConfig,
  updateSettings: h.updateSettings,
  validatePluginField: h.validatePluginField,
}));

const PID = 'demo';
function render(items: ConfigLayoutItem[], prefs: Map<string, PluginPreference> = new Map()): HTMLElement {
  const c = document.createElement('div');
  renderConfigLayout(c, items, PID, prefs);
  return c;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { document.body.replaceChildren(); });

describe('renderConfigLayout — item types', () => {
  it('renders divider, spacer, and a colored label with an id', () => {
    const c = render([
      { type: 'divider' },
      { type: 'spacer' },
      { type: 'label', id: 'l1', text: 'Status', color: 'success' },
    ]);
    expect(c.querySelector('hr.config-divider')).not.toBeNull();
    expect(c.querySelector('.config-spacer')).not.toBeNull();
    const label = c.querySelector('#config-label-demo-l1')!;
    expect(label.textContent).toBe('Status');
    expect(label.className).toContain('label-color-success');
  });

  it('appends a preference row only when the key resolves in the prefs map', () => {
    const pref: PluginPreference = { key: 'token', label: 'Token' } as PluginPreference;
    const withPref = render([{ type: 'preference', key: 'token' }], new Map([['token', pref]]));
    expect(withPref.querySelector('.plugin-pref-row')).not.toBeNull();
    // key not in map → skipped
    const missing = render([{ type: 'preference', key: 'nope' }], new Map([['token', pref]]));
    expect(missing.querySelector('.plugin-pref-row')).toBeNull();
  });

  it('renders a button and runs its action on click', async () => {
    h.getPluginConfigLabels.mockResolvedValue({ l1: { text: 'Done', color: 'success' } });
    const c = render([
      { type: 'label', id: 'l1', text: 'Idle' },
      { type: 'button', label: 'Sync', action: 'sync', style: 'primary' },
    ]);
    const btn = c.querySelector('button')!;
    expect(btn.className).toContain('btn-primary');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(h.runPluginAction).toHaveBeenCalledWith(PID, { actionId: 'sync' }));
    // the returned label payload updates the matching config-label element
    await vi.waitFor(() => expect(c.querySelector('#config-label-demo-l1')!.textContent).toBe('Done'));
  });

  it('a button with no action is inert on click', () => {
    const c = render([{ type: 'button', label: 'Noop' }]);
    c.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.runPluginAction).not.toHaveBeenCalled();
  });

  it('renders a collapsed group whose header toggles open/closed + renders nested items', () => {
    const c = render([{
      type: 'group', title: 'Advanced', collapsed: true,
      items: [{ type: 'divider' }],
    }]);
    const group = c.querySelector('.config-group')!;
    expect(group.classList.contains('collapsed')).toBe(true);
    const body = group.querySelector('.config-group-body') as HTMLElement;
    expect(body.style.display).toBe('none');
    expect(body.querySelector('hr.config-divider')).not.toBeNull(); // nested render
    // header click expands
    (group.querySelector('.config-group-header') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(body.style.display).toBe('');
    expect(group.classList.contains('collapsed')).toBe(false);
  });
});

describe('createPreferenceRow', () => {
  it('shows the required marker + global badge + description when present', () => {
    const row = createPreferenceRow(pluginPreferenceStore(PID), {
      key: 'apiKey', label: 'API Key', scope: 'global', required: true, description: 'Your key',
    } as PluginPreference);
    expect(row.querySelector('.plugin-pref-required')).not.toBeNull();
    expect(row.querySelector('.global-setting-badge')).not.toBeNull();
    expect(row.querySelector('.settings-hint')!.textContent).toBe('Your key');
    expect(row.querySelector('#pref-input-demo-apiKey')).not.toBeNull();
  });

  it('omits the markers for a plain project-scoped preference', () => {
    const row = createPreferenceRow(pluginPreferenceStore(PID), { key: 'name', label: 'Name' } as PluginPreference);
    expect(row.querySelector('.plugin-pref-required')).toBeNull();
    expect(row.querySelector('.global-setting-badge')).toBeNull();
    expect(row.querySelector('.settings-hint')).toBeNull();
  });
});
