// HS-9411 (docs/124) — client-side cache + DOM gating for the "In Development"
// feature gates. The definitions live in the server-safe `src/devFeatures.ts`;
// this module owns the hydrated per-project state and the show/hide pass.
//
// HS-9407 invariant: the cache is written on EVERY hydration, defaulting every
// gate to false, so a project that never enabled a gate can't inherit the
// previously-viewed project's `true`. Never make this a merge.

import {DEV_FEATURES, type DevFeatureKey, isDevFeatureEnabled} from '../devFeatures.js';
import { byIdOrNull } from './dom.js';

/** Fires after a hydration so surfaces can re-apply their gates. */
export const DEV_FEATURES_CHANGED_EVENT = 'hotsheet:dev-features-changed';

// `| undefined` is the honest type: a key absent from the cache (unknown gate, or
// any read before the first hydration) really is undefined at runtime.
let cache: Record<string, boolean | undefined> = {};

/** Replace the cache from a resolved file-settings record (project switch or boot). */
export function hydrateDevFeatures(resolved: Record<string, unknown>): void {
  const next: Record<string, boolean | undefined> = {};
  for (const f of DEV_FEATURES) next[f.key] = isDevFeatureEnabled(resolved, f.key);
  cache = next;
}

/** Is a gate on for the active project? Defaults to false for unknown keys —
 *  the `=== true` is load-bearing: an un-hydrated cache must fail CLOSED. */
export function isDevEnabled(key: DevFeatureKey): boolean {
  return cache[key] === true;
}

/** Optimistic local update when the user flips a checkbox, so gates apply without
 *  waiting for a settings round-trip. */
export function setDevEnabledLocal(key: DevFeatureKey, enabled: boolean): void {
  cache[key] = enabled;
  applyDevFeatureGates();
  document.dispatchEvent(new CustomEvent(DEV_FEATURES_CHANGED_EVENT));
}

/**
 * Show/hide every statically-marked surface. An element opts in with
 * `data-dev-feature="<key>"` — no per-feature wiring needed for simple cases.
 * Surfaces with their own visibility logic (the sidebar worker row, which is also
 * channel-gated) call `isDevEnabled` directly instead.
 *
 * Uses the `hidden` attribute rather than `style.display` so it composes with the
 * owning module's own display handling instead of fighting it.
 */
export function applyDevFeatureGates(): void {
  document.querySelectorAll<HTMLElement>('[data-dev-feature]').forEach((el) => {
    const key = el.dataset.devFeature;
    if (key === undefined || key === '') return;
    el.hidden = !isDevEnabled(key as DevFeatureKey);
  });
  // The Remote Access tab button lives in the settings tab strip; hiding the
  // button alone would strand the panel if it were the remembered active tab.
  const remoteTab = byIdOrNull('settings-tab-devices');
  // `hidden` is typed `boolean | "until-found"` in the DOM lib, hence the explicit
  // comparison — we only ever assign a boolean above.
  if (remoteTab !== null && remoteTab.hidden === true && remoteTab.classList.contains('active')) {
    remoteTab.classList.remove('active');
    document.querySelector('.settings-tab-panel[data-panel="devices"]')?.classList.remove('active');
    document.querySelector('.settings-tab[data-tab="general"]')?.classList.add('active');
    document.querySelector('.settings-tab-panel[data-panel="general"]')?.classList.add('active');
  }
}
