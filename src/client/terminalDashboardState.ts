/**
 * Shared module-level state for the Terminal Dashboard, extracted out of
 * `terminalDashboard.tsx` per HS-8395 Phase 3b. The state slot lives here
 * so future Phase 3c can move the paint code into its own module while
 * still reading the same `dashboardState` and `gridHandles` map without
 * either (a) defeating the HS-8222 encapsulation by re-exposing them
 * from the main file, or (b) plumbing a ~10-field paint-context object
 * through every paint function.
 *
 * Types stored here too (`TerminalSessionState`, `TerminalListEntry`,
 * `ProjectSectionData`) because they're part of the state shape and
 * pre-fix the cross-module import graph had `terminalDashboardTiles.tsx`
 * importing them BACK from `terminalDashboard.tsx`, which was a
 * pre-existing circular-import (worked because all the cross-module
 * imports were types) waiting to bite anything that promoted a type to
 * a runtime symbol. After the move, every cross-module type consumer
 * imports directly from this module.
 *
 * No paint or lifecycle logic lives here — this is pure state +
 * disposers. The `_resetCommonStateForTesting` helper handles the
 * runtime cleanup (RAF cancellation, observer disposal, handle
 * disposal) so the main file's `_resetStateForTesting` can stay a
 * thin orchestrator that also resets the sibling sub-module slots.
 */

import type { ProjectInfo } from './state.js';
import type { SnapPoint } from './terminalDashboardSizing.js';
import type { TerminalSearchHandle } from './terminalSearch.js';
import type { TileGridHandle } from './terminalTileGrid.js';

export type TerminalSessionState = 'alive' | 'exited' | 'not_spawned';

export interface TerminalListEntry {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  lazy?: boolean;
  bellPending?: boolean;
  state?: TerminalSessionState;
  exitCode?: number | null;
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  /** HS-7278 — server-tracked OSC 7 CWD; rendered as a tile-level chip below
   *  the label so cold tiles still show where the shell was working. */
  currentCwd?: string | null;
  /** HS-7065 — true for dynamic terminals (created ad-hoc), false for
   *  configured terminals from settings.json. Decides Close-Tab availability
   *  in the right-click context menu. */
  dynamic?: boolean;
}

export interface ProjectSectionData {
  project: ProjectInfo;
  terminals: TerminalListEntry[];
}

/**
 * HS-8222 — bundled module-level lifecycle state, mirroring the HS-8190
 * pattern landed in `permissionOverlay.tsx`. The toolbar buttons, async
 * load promises, debounce handles, cross-handle centered-tile pointer,
 * and active-state flag all live here in a single named container so a
 * future audit can spot stale handles immediately.
 *
 * The local var is named `dashboardState` (not `state`) to avoid shadowing
 * the imported `state` module surface should one ever be added — matches
 * the precedent set in HS-8190 where shadowing `./state.js` was hit and
 * reverted.
 *
 * HS-8395 Phase 2a/2b — layout-mode + slider state previously lived
 * inline here; both moved to their own modules with private state slots.
 * The fields that survived are those the main lifecycle module + future
 * paint module both need.
 */
export interface DashboardState {
  /** Cross-section centered-tile coordination: which handle currently has
   *  a centered tile? When the user clicks a tile in section B while
   *  section A has one centered, we uncenter A first via `onTileEnlarge`. */
  centeredHandle: TileGridHandle | null;
  /** HS-8341 — search widget mounted directly into the dedicated view's
   *  top toolbar (`.terminal-dashboard-dedicated-bar`) while a dedicated
   *  view is open. Pre-HS-8341 the widget mounted into a slot in the app
   *  header — but the dedicated overlay is `position: fixed; z-index: 600`
   *  and covers the header, so the slot was never visible. Disposed via
   *  the `onDedicatedBarMount` return-value disposer pattern. */
  dedicatedSearchHandle: TerminalSearchHandle | null;
  active: boolean;
  toggleButton: HTMLButtonElement | null;
  rootElement: HTMLElement | null;
  resizeHandler: (() => void) | null;
  resizeRaf: number | null;
  bellUnsubscribe: (() => void) | null;
  appearanceUnsubscribe: (() => void) | null;
  sizerContainer: HTMLElement | null;
  sizeSlider: HTMLInputElement | null;
  currentSnapPoints: SnapPoint[];
  /** HS-7661 — Show / Hide Terminals dialog opener for the global dashboard. */
  hideButton: HTMLButtonElement | null;
  /** HS-7826 — visibility-grouping `<select>` next to the eye icon. */
  groupingSelect: HTMLSelectElement | null;
  /** HS-7661 — last-fetched per-project section data, retained so the
   *  hide-state subscription can re-render without re-fetching `/projects`
   *  + per-project `/terminal/list` round-trips. */
  lastSectionData: ProjectSectionData[];
  /** HS-7661 — unsubscribe from hidden-state changes. Set on
   *  `enterDashboard`, cleared on `exitDashboard`. */
  hiddenChangeUnsubscribe: (() => void) | null;
  /** HS-9056 — periodic `refreshProjectTabs()` timer that keeps the per-tile
   *  open / up-next counts current while the dashboard is open (the project
   *  list isn't otherwise polled here). Set on `enterDashboard`, cleared on
   *  `exitDashboard`. */
  statsRefreshTimer: ReturnType<typeof setInterval> | null;
}

export function freshDashboardState(): DashboardState {
  return {
    centeredHandle: null,
    dedicatedSearchHandle: null,
    active: false,
    toggleButton: null,
    rootElement: null,
    resizeHandler: null,
    resizeRaf: null,
    bellUnsubscribe: null,
    appearanceUnsubscribe: null,
    statsRefreshTimer: null,
    sizerContainer: null,
    sizeSlider: null,
    currentSnapPoints: [],
    hideButton: null,
    groupingSelect: null,
    lastSectionData: [],
    hiddenChangeUnsubscribe: null,
  };
}

/** Mutable module-level state slot. Both lifecycle and (future) paint
 *  modules read + write here. Direct mutation is intentional — there's
 *  no signal layer for this state yet, and pre-§61 reactivity primitives
 *  the imperative reads + writes were already the convention. */
export let dashboardState: DashboardState = freshDashboardState();

/** Per-project grid handle map keyed by project secret. Each section
 *  that has ≥1 terminal gets one TileGrid mount; cross-section
 *  operations (recenter on resize, syncBellState, rebuild on list
 *  refresh) walk this map. */
export const gridHandles = new Map<string, TileGridHandle>();

/** **HS-8395 — TEST ONLY.** Common runtime cleanup + state reset for
 *  the dashboard's own state (sibling sub-modules — layout, slider,
 *  tiles — own their own `_reset*ForTesting` exports that the main
 *  module's `_resetStateForTesting` orchestrator also invokes). Runs
 *  disposers BEFORE swapping in a fresh state so an in-flight RAF,
 *  observer, or long-poll subscription doesn't leak past the swap. */
export function _resetCommonStateForTesting(): void {
  if (dashboardState.resizeRaf !== null) cancelAnimationFrame(dashboardState.resizeRaf);
  if (dashboardState.resizeHandler !== null) window.removeEventListener('resize', dashboardState.resizeHandler);
  if (dashboardState.bellUnsubscribe !== null) {
    try { dashboardState.bellUnsubscribe(); } catch { /* ignore */ }
  }
  if (dashboardState.appearanceUnsubscribe !== null) {
    try { dashboardState.appearanceUnsubscribe(); } catch { /* ignore */ }
  }
  if (dashboardState.hiddenChangeUnsubscribe !== null) {
    try { dashboardState.hiddenChangeUnsubscribe(); } catch { /* ignore */ }
  }
  for (const handle of gridHandles.values()) {
    try { handle.dispose(); } catch { /* ignore */ }
  }
  gridHandles.clear();
  dashboardState = freshDashboardState();
}
