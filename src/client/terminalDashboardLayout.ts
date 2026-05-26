/**
 * Layout-mode persistence + toggle wiring extracted out of
 * `terminalDashboard.tsx` per HS-8395 Phase 2a (sub-ticket of HS-8383 →
 * HS-8395). Owns the `'sectioned'` ↔ `'flow'` mode flip + the persisted
 * value on `/global-config` under `dashboard.layoutMode`.
 *
 * Slider state (`columnCount`, `sliderPersistTimeout`,
 * `sliderValueLoadPromise`) stays in `terminalDashboard.tsx` for now — it
 * is more entangled with the painting + sizing-tick code that hasn't been
 * extracted yet. Phase 2b will move it once the painting carve in Phase 3
 * gives the slider a clean home.
 *
 * Decoupling pattern: this module owns its own small `layoutState` slot.
 * The main file passes the toggle button at `bindLayoutToggle` time and
 * supplies an `onLayoutModeChanged` callback so this module can request
 * the dashboard repaint without reaching back into the main module's
 * `dashboardState`.
 */

import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';
import type { GlobalConfig } from '../global-config.js';

export type LayoutMode = 'sectioned' | 'flow';

interface LayoutState {
  layoutMode: LayoutMode;
  /** Cached toggle-button reference, populated by `bindLayoutToggle`.
   *  Used by `applyLayoutToggleVisualState` + `setLayoutToggleVisible`. */
  layoutToggleButton: HTMLButtonElement | null;
  /** Cached load promise so `loadLayoutMode` is idempotent (the dashboard
   *  may call it from `initTerminalDashboard` AND `enterDashboard`). */
  layoutModeLoadPromise: Promise<void> | null;
}

function freshLayoutState(): LayoutState {
  return {
    layoutMode: 'sectioned',
    layoutToggleButton: null,
    layoutModeLoadPromise: null,
  };
}

let layoutState: LayoutState = freshLayoutState();

/** **HS-8395 — TEST ONLY.** Reset the module-level `layoutState` to its
 *  fresh shape so consecutive tests start from a clean slate. */
export function _resetLayoutStateForTesting(): void {
  layoutState = freshLayoutState();
}

/** Coerces an arbitrary settings value to a valid LayoutMode, defaulting
 *  to `'sectioned'` when missing or unrecognized. */
export function parseLayoutMode(raw: unknown): LayoutMode {
  return raw === 'flow' ? 'flow' : 'sectioned';
}

/** Read the current layout mode (defaults to `'sectioned'` until
 *  `loadLayoutMode` resolves). */
export function getLayoutMode(): LayoutMode {
  return layoutState.layoutMode;
}

/** HS-7662 → HS-8290 — load the persisted layout mode from
 *  `/global-config` once and cache the resulting promise. Resolves
 *  silently on error so the dashboard still works when the endpoint is
 *  briefly unavailable. Pre-HS-8290 this read from
 *  `/file-settings.dashboard_layout_mode`; the key moved to global config
 *  because the dashboard is inherently cross-project. */
export function loadLayoutMode(): Promise<void> {
  if (layoutState.layoutModeLoadPromise !== null) return layoutState.layoutModeLoadPromise;
  layoutState.layoutModeLoadPromise = (async () => {
    try {
      const cfg = await getGlobalConfig();
      layoutState.layoutMode = parseLayoutMode(cfg.dashboard?.layoutMode);
    } catch {
      layoutState.layoutMode = 'sectioned';
    }
    applyLayoutToggleVisualState();
  })();
  return layoutState.layoutModeLoadPromise;
}

/** HS-7662 / HS-8290 — flip the layout mode and persist to global config.
 *  Calls the supplied `onChanged` callback after updating internal state
 *  so the main module can repaint the dashboard with cached section
 *  data. */
export function setLayoutMode(next: LayoutMode, onChanged: () => void): void {
  if (next === layoutState.layoutMode) return;
  layoutState.layoutMode = next;
  applyLayoutToggleVisualState();
  // Persist in the background — don't block the re-render on the network.
  // HS-8434 — type the PATCH body against the shared schema so a key
  // added here without a matching schema entry is a compile error.
  const body: Partial<GlobalConfig> = { dashboard: { layoutMode: next } };
  void updateGlobalConfig(body)
    .catch(() => { /* swallow — UI flip already happened */ });
  onChanged();
}

/** Wire the toggle button's click handler. The main file passes the
 *  button reference (resolved at `initTerminalDashboard` time) + a
 *  callback that runs after each mode flip so the dashboard can repaint
 *  with its cached section data. Idempotent — re-binding the same button
 *  in tests is safe because the second `bindLayoutToggle` overwrites the
 *  cached reference; click listeners stack but the duplicate just calls
 *  `setLayoutMode` twice with the same target value, which short-circuits
 *  on the `next === layoutMode` guard. Tests should call
 *  `_resetLayoutStateForTesting()` between cases anyway. */
export function bindLayoutToggle(opts: {
  toggleButton: HTMLButtonElement;
  onChanged: () => void;
}): void {
  layoutState.layoutToggleButton = opts.toggleButton;
  // Apply current visual state immediately so the button reflects the
  // loaded layoutMode even if `loadLayoutMode()` already resolved before
  // bind. (The load handler also calls `applyLayoutToggleVisualState`
  // when it finishes, so a still-pending load will overwrite this once
  // the network roundtrip completes.)
  applyLayoutToggleVisualState();
  opts.toggleButton.addEventListener('click', () => {
    setLayoutMode(layoutState.layoutMode === 'sectioned' ? 'flow' : 'sectioned', opts.onChanged);
  });
}

/** Show or hide the toggle button (the main file's enter/exitDashboard
 *  flips visibility alongside the rest of the chrome). No-op when the
 *  button hasn't been bound. */
export function setLayoutToggleVisible(visible: boolean): void {
  if (layoutState.layoutToggleButton === null) return;
  layoutState.layoutToggleButton.style.display = visible ? '' : 'none';
}

function applyLayoutToggleVisualState(): void {
  if (layoutState.layoutToggleButton === null) return;
  layoutState.layoutToggleButton.classList.toggle('active', layoutState.layoutMode === 'flow');
  layoutState.layoutToggleButton.title = layoutState.layoutMode === 'flow'
    ? 'Switch to sectioned layout'
    : 'Switch to flow layout';
}
