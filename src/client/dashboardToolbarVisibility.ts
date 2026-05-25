import { byIdOrNull } from './dom.js';

/**
 * HS-8626 — single source of truth for the header toolbar controls that the
 * full-window **analytics dashboard** hides while it owns the main content
 * area, and the helpers to hide / restore them.
 *
 * Pre-fix the id list + the hide/restore loops were private to
 * `dashboardMode.tsx`. The cross-project stats page's `exitDashboardModeIfActive`
 * (which supplants an active analytics dashboard) claimed in its comment to
 * "restore the toolbar that `enterDashboardMode` had hidden" but never actually
 * did — so opening the analytics dashboard (controls hidden) then opening the
 * cross-project stats page left the search / layout / sort / detail-position
 * controls stuck `display: none` after returning to the normal ticket view.
 * Sharing the list + the restore here lets both surfaces stay in sync and
 * guarantees the supplant path restores exactly what the dashboard hid.
 *
 * The terminal dashboard (§25) and the cross-project stats page (§70) are
 * fixed-position overlays that occlude the header rather than hiding these
 * controls, so they don't participate — only the analytics dashboard does.
 */
export const DASHBOARD_HIDDEN_IDS: readonly string[] = [
  'search-input',
  'layout-toggle',
  'sort-select',
  'detail-position-toggle',
  'glassbox-btn',
];

/** Resolve each id to the element whose visibility should toggle — the
 *  wrapping `.search-box` / `.layout-toggle` / `.sort-controls` when present,
 *  else the element itself — and run `fn` against it. */
function eachToolbarControl(fn: (el: HTMLElement) => void): void {
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = byIdOrNull(id);
    if (el === null) continue;
    const container = el.closest('.search-box, .layout-toggle, .sort-controls') ?? el;
    fn(container as HTMLElement);
  }
}

/** Hide the header toolbar controls (analytics-dashboard enter). */
export function hideDashboardToolbarControls(): void {
  eachToolbarControl(el => { el.style.display = 'none'; });
}

/** Restore the header toolbar controls (analytics-dashboard exit + any
 *  surface that supplants it). Idempotent — restoring already-visible
 *  controls is a no-op, so it's safe to call defensively. */
export function restoreDashboardToolbarControls(): void {
  eachToolbarControl(el => { el.style.display = ''; });
}
