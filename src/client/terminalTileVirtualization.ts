/**
 * HS-7968 — pure state-machine for IntersectionObserver-driven tile
 * virtualization. The xterm + WebSocket per tile in the dashboard / drawer-
 * grid is heavy (each xterm allocates canvas + WebGL, each WS holds an open
 * fd server-side). At dashboard sizes >50 tiles the eager-mount cost
 * compounds. This module decides "should I mount / dispose this tile right
 * now?" based on visibility events + a debounce window so quick scrolls
 * don't churn.
 *
 * Pure (no DOM, no IntersectionObserver instance) — drives a `Map<id,
 * TileVirtualState>`, takes input events, returns the actions a caller
 * (terminalTileGrid.tsx) should run. Unit-testable with synthetic time.
 */

/** How long a tile can stay off-screen before its xterm + WS recycle.
 *  Ticket suggested 5–10 s; 8 s splits the difference and keeps quick-
 *  scroll churn low while bounding off-screen renderer count. */
export const VIRT_DEFAULT_DEBOUNCE_MS = 8000;

/** Per-tile visibility / mount state tracked by the virtualization layer. */
export interface TileVirtualState {
  visible: boolean;
  mounted: boolean;
  /** When the tile last transitioned from visible → off-screen. Null when
   *  the tile is currently visible OR has never been seen. */
  exitedAt: number | null;
  /** Pending dispose timer id, if any. Caller stores whatever return value
   *  its `setTimeout` produces here so the state machine can cancel it. */
  pendingDisposeTimerId: number | null;
}

export type VirtualizationAction =
  | { type: 'mount'; tileId: string }
  | { type: 'dispose'; tileId: string }
  | { type: 'cancelDispose'; tileId: string }
  | { type: 'scheduleDispose'; tileId: string; afterMs: number };

export interface VirtualizationStep {
  /** Updated state for the affected tile. Caller writes back to its map. */
  next: TileVirtualState;
  /** Side-effects the caller should perform — mount / dispose / schedule
   *  the debounce timer. */
  actions: VirtualizationAction[];
}

/** Initial state for a tile entering the registry — never seen by the
 *  observer yet, not mounted. */
export function initialTileState(): TileVirtualState {
  return {
    visible: false,
    mounted: false,
    exitedAt: null,
    pendingDisposeTimerId: null,
  };
}

/**
 * Tile is visible to the user. Cancels any pending dispose; mounts if the
 * tile is alive but not mounted yet.
 *
 * Caller decides whether the tile is in the right LIFE-CYCLE state to mount
 * (e.g. only `'alive'` tiles get xterm mounted; `'exited'` ones don't).
 * This module just tracks visibility/debounce — it doesn't know about
 * exited PTYs. Pass `mountIfNotMounted: false` to suppress the mount
 * action when the tile shouldn't be mounted regardless of visibility.
 */
export function onTileEnter(
  state: TileVirtualState,
  options: { tileId: string; mountIfNotMounted: boolean },
): VirtualizationStep {
  const actions: VirtualizationAction[] = [];
  // Cancel any pending dispose — coming back into view means we want to
  // keep the renderer alive.
  if (state.pendingDisposeTimerId !== null) {
    actions.push({ type: 'cancelDispose', tileId: options.tileId });
  }
  if (options.mountIfNotMounted && !state.mounted) {
    actions.push({ type: 'mount', tileId: options.tileId });
  }
  return {
    next: {
      visible: true,
      mounted: state.mounted || options.mountIfNotMounted,
      exitedAt: null,
      pendingDisposeTimerId: null,
    },
    actions,
  };
}

/**
 * Tile has scrolled off-screen. If it's mounted, schedule a debounced
 * dispose; if it isn't, no-op (we never had a renderer to recycle). The
 * caller is expected to set the returned `pendingDisposeTimerId` after
 * `setTimeout` fires its dispose.
 */
export function onTileExit(
  state: TileVirtualState,
  options: { tileId: string; now: number; debounceMs: number },
): VirtualizationStep {
  // Already not visible, no mounted renderer → state-machine no-op.
  if (!state.mounted) {
    return {
      next: { ...state, visible: false, exitedAt: options.now },
      actions: [],
    };
  }
  const actions: VirtualizationAction[] = [
    { type: 'scheduleDispose', tileId: options.tileId, afterMs: options.debounceMs },
  ];
  return {
    next: {
      ...state,
      visible: false,
      exitedAt: options.now,
      // Caller fills in `pendingDisposeTimerId` after `setTimeout`.
    },
    actions,
  };
}

/**
 * The debounce timer fired (the tile has been off-screen for `debounceMs`).
 * If the tile is still off-screen + mounted, dispose it. If something else
 * mounted it back in the meantime (re-enter cancelled the timer), this is
 * a no-op.
 */
export function onDisposeTimerFired(
  state: TileVirtualState,
  options: { tileId: string },
): VirtualizationStep {
  if (state.visible || !state.mounted) {
    // Re-entered or never mounted → drop the timer reference.
    return {
      next: { ...state, pendingDisposeTimerId: null },
      actions: [],
    };
  }
  return {
    next: {
      ...state,
      mounted: false,
      pendingDisposeTimerId: null,
    },
    actions: [{ type: 'dispose', tileId: options.tileId }],
  };
}
