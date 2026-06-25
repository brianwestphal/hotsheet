// @vitest-environment happy-dom
/**
 * HS-9020 — the dialog-wide scope segmented control disables itself on
 * global-only tabs (API Keys / Updates), where the Shared / Local / Resolved
 * distinction is meaningless because every setting writes to machine-global
 * storage (`~/.hotsheet/config.json` / the OS keychain).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initSettingsScope, isGlobalOnlyTab, resetScopeMode, setActiveSettingsTab } from './settingsScope.js';

function segButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.scope-seg-btn'));
}

// `initSettingsScope` binds the segment-button click listeners exactly once
// (idempotent), so the bar DOM must be mounted ONCE up front and reused — a
// per-test remount would orphan the listeners.
beforeAll(() => {
  document.body.innerHTML = `
    <div class="settings-scope-bar" id="settings-scope-bar" data-scope-mode="resolved">
      <div class="scope-seg">
        <button class="scope-seg-btn scope-seg-shared" data-scope-mode="shared">Shared</button>
        <button class="scope-seg-btn scope-seg-local" data-scope-mode="local">Local overrides</button>
        <button class="scope-seg-btn scope-seg-resolved active" data-scope-mode="resolved">Resolved</button>
      </div>
      <span class="scope-bar-note" id="settings-scope-note">resolved note</span>
    </div>`;
  initSettingsScope();
});

describe('settings scope bar — global-only tabs (HS-9020)', () => {
  beforeEach(() => {
    resetScopeMode();
    setActiveSettingsTab('general');
  });

  it('classifies keys + updates as global-only, others not', () => {
    expect(isGlobalOnlyTab('keys')).toBe(true);
    expect(isGlobalOnlyTab('updates')).toBe(true);
    expect(isGlobalOnlyTab('general')).toBe(false);
    expect(isGlobalOnlyTab('telemetry')).toBe(false);
    expect(isGlobalOnlyTab('devices')).toBe(false);
  });

  it('disables the segment buttons + swaps the note on the API Keys tab', () => {
    setActiveSettingsTab('keys');
    const bar = document.getElementById('settings-scope-bar')!;
    expect(bar.classList.contains('scope-bar-global')).toBe(true);
    expect(segButtons().every(b => b.disabled)).toBe(true);
    expect(document.getElementById('settings-scope-note')!.textContent).toContain('global to this machine');
  });

  it('disables the control on the Updates tab too', () => {
    setActiveSettingsTab('updates');
    expect(segButtons().every(b => b.disabled)).toBe(true);
    expect(document.getElementById('settings-scope-bar')!.classList.contains('scope-bar-global')).toBe(true);
  });

  it('re-enables the control + restores the note when switching back to a scoped tab', () => {
    setActiveSettingsTab('keys');
    setActiveSettingsTab('general');
    const bar = document.getElementById('settings-scope-bar')!;
    expect(bar.classList.contains('scope-bar-global')).toBe(false);
    expect(segButtons().some(b => b.disabled)).toBe(false);
    expect(document.getElementById('settings-scope-note')!.textContent).not.toContain('global to this machine');
  });

  it('ignores a segment click while disabled on a global-only tab', () => {
    setActiveSettingsTab('keys');
    document.querySelector<HTMLButtonElement>('.scope-seg-shared')!.click();
    // Mode stays resolved — the click was guarded.
    expect(document.getElementById('settings-scope-bar')!.dataset.scopeMode).toBe('resolved');
  });

  it('still honors a segment click on a normal (scoped) tab', () => {
    setActiveSettingsTab('general');
    document.querySelector<HTMLButtonElement>('.scope-seg-shared')!.click();
    expect(document.getElementById('settings-scope-bar')!.dataset.scopeMode).toBe('shared');
  });
});
