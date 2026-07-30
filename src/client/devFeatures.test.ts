// @vitest-environment happy-dom
// HS-9411 (docs/124) — the client-side gate cache. The important property is the
// HS-9407 one: hydration REPLACES, so a gate enabled in project A can't leak into
// project B. Transition tests, because that bug only exists in the sequence.
import { beforeEach, describe, expect, it } from 'vitest';

import { applyDevFeatureGates, DEV_FEATURES_CHANGED_EVENT, hydrateDevFeatures, isDevEnabled, setDevEnabledLocal } from './devFeatures.js';

beforeEach(() => {
  document.body.innerHTML = '';
  hydrateDevFeatures({});
});

describe('hydrateDevFeatures', () => {
  it('defaults every gate to off before any hydration', () => {
    expect(isDevEnabled('dev_parallel_workers')).toBe(false);
    expect(isDevEnabled('dev_remote_access')).toBe(false);
  });

  it('turns a gate on from the resolved settings', () => {
    hydrateDevFeatures({ dev_parallel_workers: true });
    expect(isDevEnabled('dev_parallel_workers')).toBe(true);
  });

  it('does NOT carry a gate across a project switch (HS-9407 class)', () => {
    hydrateDevFeatures({ dev_parallel_workers: true, dev_remote_access: true });
    expect(isDevEnabled('dev_parallel_workers')).toBe(true);
    // Project B enabled nothing.
    hydrateDevFeatures({});
    expect(isDevEnabled('dev_parallel_workers')).toBe(false);
    expect(isDevEnabled('dev_remote_access')).toBe(false);
  });

  it('restores the gate when switching back', () => {
    hydrateDevFeatures({ dev_parallel_workers: true });
    hydrateDevFeatures({});
    hydrateDevFeatures({ dev_parallel_workers: true });
    expect(isDevEnabled('dev_parallel_workers')).toBe(true);
  });

  it('fails closed on a non-boolean stored value', () => {
    hydrateDevFeatures({ dev_remote_access: 'true' });
    expect(isDevEnabled('dev_remote_access')).toBe(false);
  });
});

// HS-9515 — `isAiToolDevEnabled` and its tests are gone with the per-tool gates.
// No AI tool is gated any more: readiness is handled by not shipping a plugin
// publicly and by alpha/beta release labeling, not by a runtime flag.

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

/**
 * HS-9474 — `DEV_FEATURES_CHANGED_EVENT` was dispatched and heard by nobody.
 *
 * That is a uniquely quiet failure: the dispatch looks correct, every test of the
 * gate machinery passes, and the only symptom is a surface that silently stays
 * stale until something else re-renders it. The `ai_tool` dropdown was that
 * surface — enabling a tool's gate left its option disabled until Settings was
 * closed and reopened.
 *
 * The wiring itself is covered end-to-end by `e2e/in-development-gates.spec.ts`
 * ("enabling a tool gate enables its dropdown option WITHOUT reopening Settings").
 * These pin the contract that event depends on.
 */
describe('DEV_FEATURES_CHANGED_EVENT (HS-9474)', () => {
  it('fires on a local gate change, so imperative surfaces can re-gate', () => {
    let heard = 0;
    const onChange = () => { heard += 1; };
    document.addEventListener(DEV_FEATURES_CHANGED_EVENT, onChange);
    try {
      setDevEnabledLocal('dev_remote_access', true);
      expect(heard).toBe(1);
      setDevEnabledLocal('dev_remote_access', false);
      expect(heard).toBe(2);
    } finally {
      document.removeEventListener(DEV_FEATURES_CHANGED_EVENT, onChange);
    }
  });

  it('has already applied the new value by the time listeners run', () => {
    // A listener that re-gates by calling `isDevEnabled` must not observe the OLD
    // value — otherwise the surface would re-render itself right back to stale.
    let observed: boolean | null = null;
    const onChange = () => { observed = isDevEnabled('dev_remote_access'); };
    document.addEventListener(DEV_FEATURES_CHANGED_EVENT, onChange);
    try {
      setDevEnabledLocal('dev_remote_access', true);
      expect(observed).toBe(true);
    } finally {
      document.removeEventListener(DEV_FEATURES_CHANGED_EVENT, onChange);
      setDevEnabledLocal('dev_remote_access', false);
    }
  });
});
