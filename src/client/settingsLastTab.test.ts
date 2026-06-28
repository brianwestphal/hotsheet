// @vitest-environment happy-dom
/**
 * HS-9126 — the last-selected Settings tab is remembered in localStorage and
 * restored (by clicking its tab button) on the next dialog open, across opens
 * and across projects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLastSettingsTab, restoreLastSettingsTab, setLastSettingsTab } from './settingsLastTab.js';

function mountTabs(): void {
  document.body.innerHTML = `
    <button class="settings-tab active" data-tab="general"></button>
    <button class="settings-tab" data-tab="telemetry"></button>
    <button class="settings-tab" data-tab="terminal" style="display:none"></button>`;
}

beforeEach(() => {
  localStorage.clear();
  mountTabs();
});

describe('get/set', () => {
  it('round-trips the tab name', () => {
    expect(getLastSettingsTab()).toBeNull();
    setLastSettingsTab('telemetry');
    expect(getLastSettingsTab()).toBe('telemetry');
  });
});

describe('restoreLastSettingsTab', () => {
  it('clicks the remembered tab button', () => {
    setLastSettingsTab('telemetry');
    const spy = vi.fn();
    document.querySelector<HTMLElement>('.settings-tab[data-tab="telemetry"]')!.addEventListener('click', spy);
    restoreLastSettingsTab();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing was remembered', () => {
    const spy = vi.fn();
    document.querySelectorAll('.settings-tab').forEach(b => b.addEventListener('click', spy));
    restoreLastSettingsTab();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op for the General tab (already active)', () => {
    setLastSettingsTab('general');
    const spy = vi.fn();
    document.querySelector<HTMLElement>('.settings-tab[data-tab="general"]')!.addEventListener('click', spy);
    restoreLastSettingsTab();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op when the remembered tab no longer exists', () => {
    setLastSettingsTab('plugins'); // not mounted (plugins disabled)
    expect(() => restoreLastSettingsTab()).not.toThrow();
  });

  it('is a no-op when the remembered tab is hidden', () => {
    setLastSettingsTab('terminal'); // mounted but display:none
    const spy = vi.fn();
    document.querySelector<HTMLElement>('.settings-tab[data-tab="terminal"]')!.addEventListener('click', spy);
    restoreLastSettingsTab();
    expect(spy).not.toHaveBeenCalled();
  });
});
