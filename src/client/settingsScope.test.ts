// @vitest-environment happy-dom
/**
 * HS-9116/9118/9119/9124 — the dialog-wide scope segmented control is now
 * HIDDEN entirely on machine-local tabs (API Keys / Updates / Plugins / Remote
 * Access), where the Shared / Local / Resolved distinction doesn't apply. (Was:
 * shown-but-disabled with a "global to this machine" note — HS-9020.)
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initSettingsScope, isScopeBarHiddenTab, resetScopeMode, setActiveSettingsTab } from './settingsScope.js';

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

describe('settings scope bar — hidden on machine-local tabs (HS-9116/9118/9119/9124)', () => {
  beforeEach(() => {
    resetScopeMode();
    setActiveSettingsTab('general');
  });

  it('classifies keys / updates / plugins / devices as scope-bar-hidden, others not', () => {
    expect(isScopeBarHiddenTab('keys')).toBe(true);
    expect(isScopeBarHiddenTab('updates')).toBe(true);
    expect(isScopeBarHiddenTab('plugins')).toBe(true);
    expect(isScopeBarHiddenTab('devices')).toBe(true);
    expect(isScopeBarHiddenTab('general')).toBe(false);
    expect(isScopeBarHiddenTab('telemetry')).toBe(false);
  });

  it.each(['keys', 'updates', 'plugins', 'devices'])('hides the whole bar on the %s tab', (tab) => {
    setActiveSettingsTab(tab);
    expect(document.getElementById('settings-scope-bar')!.classList.contains('scope-bar-hidden')).toBe(true);
  });

  it('shows the bar again when switching back to a scoped tab', () => {
    setActiveSettingsTab('keys');
    setActiveSettingsTab('general');
    const bar = document.getElementById('settings-scope-bar')!;
    expect(bar.classList.contains('scope-bar-hidden')).toBe(false);
    expect(segButtons().some(b => b.disabled)).toBe(false);
  });

  it('ignores a segment click while the bar is hidden', () => {
    setActiveSettingsTab('plugins');
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

// HS-9123 — the Views tab now PARTICIPATES in the scope bar (it used to be a
// per-row-layer tab with the bar disabled, HS-9096). The bar is shown + active.
describe('settings scope bar — Views tab participates (HS-9123)', () => {
  beforeEach(() => {
    resetScopeMode();
    setActiveSettingsTab('general');
  });

  it('shows the bar enabled on the Views tab (not hidden, not disabled)', () => {
    setActiveSettingsTab('views');
    const bar = document.getElementById('settings-scope-bar')!;
    expect(bar.classList.contains('scope-bar-hidden')).toBe(false);
    expect(isScopeBarHiddenTab('views')).toBe(false);
    expect(segButtons().some(b => b.disabled)).toBe(false);
  });

  it('honors a segment click on the Views tab', () => {
    setActiveSettingsTab('views');
    document.querySelector<HTMLButtonElement>('.scope-seg-shared')!.click();
    expect(document.getElementById('settings-scope-bar')!.dataset.scopeMode).toBe('shared');
  });
});
