// @vitest-environment happy-dom
// HS-9411 (docs/124) — the client-side gate cache. The important property is the
// HS-9407 one: hydration REPLACES, so a gate enabled in project A can't leak into
// project B. Transition tests, because that bug only exists in the sequence.
import { beforeEach, describe, expect, it } from 'vitest';

import { applyDevFeatureGates, hydrateDevFeatures, isAiToolDevEnabled, isDevEnabled, setDevEnabledLocal } from './devFeatures.js';

beforeEach(() => {
  document.body.innerHTML = '';
  hydrateDevFeatures({});
});

describe('hydrateDevFeatures', () => {
  it('defaults every gate to off before any hydration', () => {
    expect(isDevEnabled('dev_parallel_workers')).toBe(false);
    expect(isDevEnabled('dev_tool_codex')).toBe(false);
    expect(isDevEnabled('dev_remote_access')).toBe(false);
  });

  it('turns a gate on from the resolved settings', () => {
    hydrateDevFeatures({ dev_tool_codex: true });
    expect(isDevEnabled('dev_tool_codex')).toBe(true);
  });

  it('does NOT carry a gate across a project switch (HS-9407 class)', () => {
    hydrateDevFeatures({ dev_parallel_workers: true, dev_tool_codex: true });
    expect(isDevEnabled('dev_parallel_workers')).toBe(true);
    // Project B enabled nothing.
    hydrateDevFeatures({});
    expect(isDevEnabled('dev_parallel_workers')).toBe(false);
    expect(isDevEnabled('dev_tool_codex')).toBe(false);
  });

  it('restores the gate when switching back', () => {
    hydrateDevFeatures({ dev_tool_codex: true });
    hydrateDevFeatures({});
    hydrateDevFeatures({ dev_tool_codex: true });
    expect(isDevEnabled('dev_tool_codex')).toBe(true);
  });

  it('fails closed on a non-boolean stored value', () => {
    hydrateDevFeatures({ dev_tool_codex: 'true' });
    expect(isDevEnabled('dev_tool_codex')).toBe(false);
  });
});

describe('isAiToolDevEnabled', () => {
  it('allows ungated tools with every gate off', () => {
    for (const tool of ['auto', 'claude', 'cursor', 'copilot', 'windsurf']) {
      expect(isAiToolDevEnabled(tool), tool).toBe(true);
    }
  });

  it('blocks a gated tool until its gate is on', () => {
    expect(isAiToolDevEnabled('codex')).toBe(false);
    hydrateDevFeatures({ dev_tool_codex: true });
    expect(isAiToolDevEnabled('codex')).toBe(true);
  });

  it('gates each tool independently', () => {
    hydrateDevFeatures({ dev_tool_codex: true });
    expect(isAiToolDevEnabled('codex')).toBe(true);
    expect(isAiToolDevEnabled('opencode')).toBe(false);
    expect(isAiToolDevEnabled('goose')).toBe(false);
  });
});

describe('applyDevFeatureGates', () => {
  it('hides a marked element when its gate is off and reveals it when on', () => {
    document.body.innerHTML = '<div id="w" data-dev-feature="dev_parallel_workers"></div>';
    const el = document.getElementById('w')!;

    applyDevFeatureGates();
    expect(el.hidden).toBe(true);

    hydrateDevFeatures({ dev_parallel_workers: true });
    applyDevFeatureGates();
    expect(el.hidden).toBe(false);
  });

  it('gates each marked element by its own key', () => {
    document.body.innerHTML =
      '<div id="a" data-dev-feature="dev_parallel_workers"></div><div id="b" data-dev-feature="dev_remote_access"></div>';
    hydrateDevFeatures({ dev_remote_access: true });
    applyDevFeatureGates();
    expect(document.getElementById('a')!.hidden).toBe(true);
    expect(document.getElementById('b')!.hidden).toBe(false);
  });

  it('ignores an element whose key is unknown, leaving it hidden (fail closed)', () => {
    document.body.innerHTML = '<div id="x" data-dev-feature="dev_not_real"></div>';
    applyDevFeatureGates();
    expect(document.getElementById('x')!.hidden).toBe(true);
  });

  // Guards a real dead-end: the settings dialog remembers the last active tab, so
  // a user who was on Remote Access and then disabled the gate would otherwise
  // reopen Settings to a hidden tab with a blank panel.
  it('moves off the Remote Access tab when it becomes hidden while active', () => {
    document.body.innerHTML = `
      <button class="settings-tab active" data-tab="devices" id="settings-tab-devices" data-dev-feature="dev_remote_access"></button>
      <button class="settings-tab" data-tab="general"></button>
      <div class="settings-tab-panel active" data-panel="devices"></div>
      <div class="settings-tab-panel" data-panel="general"></div>`;
    applyDevFeatureGates();

    expect(document.getElementById('settings-tab-devices')!.classList.contains('active')).toBe(false);
    expect(document.querySelector('.settings-tab-panel[data-panel="devices"]')!.classList.contains('active')).toBe(false);
    expect(document.querySelector('.settings-tab[data-tab="general"]')!.classList.contains('active')).toBe(true);
    expect(document.querySelector('.settings-tab-panel[data-panel="general"]')!.classList.contains('active')).toBe(true);
  });

  it('leaves the Remote Access tab alone when its gate is on', () => {
    document.body.innerHTML = `
      <button class="settings-tab active" data-tab="devices" id="settings-tab-devices" data-dev-feature="dev_remote_access"></button>
      <div class="settings-tab-panel active" data-panel="devices"></div>`;
    hydrateDevFeatures({ dev_remote_access: true });
    applyDevFeatureGates();
    expect(document.getElementById('settings-tab-devices')!.classList.contains('active')).toBe(true);
  });
});

describe('setDevEnabledLocal', () => {
  it('applies immediately so gated UI reacts without a settings round-trip', () => {
    document.body.innerHTML = '<div id="w" data-dev-feature="dev_parallel_workers"></div>';
    setDevEnabledLocal('dev_parallel_workers', true);
    expect(isDevEnabled('dev_parallel_workers')).toBe(true);
    expect(document.getElementById('w')!.hidden).toBe(false);
  });

  it('is overwritten by the next hydration (the server stays authoritative)', () => {
    setDevEnabledLocal('dev_parallel_workers', true);
    hydrateDevFeatures({});
    expect(isDevEnabled('dev_parallel_workers')).toBe(false);
  });
});
