/**
 * HS-7985 — pure DOM check for whether any terminal dedicated view (dashboard
 * or drawer-grid) is currently mounted.
 *
 * The drawer's prompt detector (HS-7971 Phase 1) uses this to gate its own
 * `isActive()` so it doesn't fire while the user is looking at the dashboard
 * dedicated view; the dedicated view runs its own detector + overlay anchored
 * to its own pane (see `terminalTileGrid.tsx::enterDedicatedView`).
 *
 * Pure (DOM query only) so unit tests can drive it via happy-dom.
 */

const DEDICATED_SELECTOR =
  '.terminal-dashboard-dedicated, .drawer-terminal-grid-dedicated';

export function hasOpenDedicatedTerminalView(): boolean {
  return document.querySelector(DEDICATED_SELECTOR) !== null;
}
