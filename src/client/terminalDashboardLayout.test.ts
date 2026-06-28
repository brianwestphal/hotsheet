// @vitest-environment happy-dom
/**
 * HS-9130 — unit coverage for the dashboard layout-mode persistence + toggle
 * wiring (`terminalDashboardLayout.ts`). The global-config API is mocked; the
 * toggle button is a real happy-dom element.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLayoutStateForTesting,
  bindLayoutToggle,
  getLayoutMode,
  loadLayoutMode,
  parseLayoutMode,
  setLayoutMode,
  setLayoutToggleVisible,
} from './terminalDashboardLayout.js';

const getGlobalConfigMock = vi.fn<() => Promise<{ dashboard?: { layoutMode?: string } }>>();
const updateGlobalConfigMock = vi.fn<(body: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', () => ({
  getGlobalConfig: () => getGlobalConfigMock(),
  updateGlobalConfig: (body: unknown) => updateGlobalConfigMock(body),
}));

beforeEach(() => {
  _resetLayoutStateForTesting();
  getGlobalConfigMock.mockReset().mockResolvedValue({});
  updateGlobalConfigMock.mockReset().mockResolvedValue({});
  document.body.innerHTML = '';
});
afterEach(() => { _resetLayoutStateForTesting(); });

describe('parseLayoutMode', () => {
  it("coerces 'flow' to flow and everything else to sectioned", () => {
    expect(parseLayoutMode('flow')).toBe('flow');
    expect(parseLayoutMode('sectioned')).toBe('sectioned');
    expect(parseLayoutMode('bogus')).toBe('sectioned');
    expect(parseLayoutMode(undefined)).toBe('sectioned');
    expect(parseLayoutMode(42)).toBe('sectioned');
  });
});

describe('loadLayoutMode', () => {
  it('defaults to sectioned before load', () => {
    expect(getLayoutMode()).toBe('sectioned');
  });
  it('applies the persisted mode from global config', async () => {
    getGlobalConfigMock.mockResolvedValue({ dashboard: { layoutMode: 'flow' } });
    await loadLayoutMode();
    expect(getLayoutMode()).toBe('flow');
  });
  it('falls back to sectioned when the config fetch rejects', async () => {
    getGlobalConfigMock.mockRejectedValue(new Error('offline'));
    await loadLayoutMode();
    expect(getLayoutMode()).toBe('sectioned');
  });
  it('caches the load promise (idempotent — one fetch for concurrent calls)', async () => {
    getGlobalConfigMock.mockResolvedValue({ dashboard: { layoutMode: 'flow' } });
    await Promise.all([loadLayoutMode(), loadLayoutMode(), loadLayoutMode()]);
    expect(getGlobalConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe('setLayoutMode', () => {
  it('flips the mode, persists to global config, and fires onChanged', () => {
    const onChanged = vi.fn();
    setLayoutMode('flow', onChanged);
    expect(getLayoutMode()).toBe('flow');
    expect(updateGlobalConfigMock).toHaveBeenCalledWith({ dashboard: { layoutMode: 'flow' } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it('is a no-op (no persist, no onChanged) when the mode is unchanged', () => {
    const onChanged = vi.fn();
    setLayoutMode('sectioned', onChanged); // already sectioned
    expect(updateGlobalConfigMock).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
  it('swallows a persist rejection (UI flip already happened)', async () => {
    updateGlobalConfigMock.mockRejectedValue(new Error('patch failed'));
    expect(() => setLayoutMode('flow', () => {})).not.toThrow();
    await Promise.resolve();
    expect(getLayoutMode()).toBe('flow');
  });
});

describe('bindLayoutToggle + visual state', () => {
  it('toggles mode on click and reflects it on the button (active class + title)', () => {
    const btn = document.createElement('button');
    const onChanged = vi.fn();
    bindLayoutToggle({ toggleButton: btn, onChanged });
    // Initial sectioned state: not active, title invites flow.
    expect(btn.classList.contains('active')).toBe(false);
    expect(btn.title).toBe('Switch to flow layout');
    btn.click();
    expect(getLayoutMode()).toBe('flow');
    expect(btn.classList.contains('active')).toBe(true);
    expect(btn.title).toBe('Switch to sectioned layout');
    expect(onChanged).toHaveBeenCalledTimes(1);
    btn.click();
    expect(getLayoutMode()).toBe('sectioned');
    expect(btn.classList.contains('active')).toBe(false);
  });
});

describe('setLayoutToggleVisible', () => {
  it('is a no-op when no button is bound', () => {
    expect(() => setLayoutToggleVisible(true)).not.toThrow();
  });
  it('shows/hides the bound button', () => {
    const btn = document.createElement('button');
    bindLayoutToggle({ toggleButton: btn, onChanged: () => {} });
    setLayoutToggleVisible(false);
    expect(btn.style.display).toBe('none');
    setLayoutToggleVisible(true);
    expect(btn.style.display).toBe('');
  });
});
