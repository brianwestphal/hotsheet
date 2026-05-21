/**
 * HS-8479 / §69.2 — conditional Telemetry sidebar entry. The entry
 * in `#sidebar-section-telemetry` (rendered hidden in `pages.tsx`) is
 * shown only when at least one registered project has
 * `telemetry_enabled === true`. The check goes through
 * `GET /api/telemetry/enabled-anywhere` (cheap iteration over
 * `~/.hotsheet/projects.json` + each project's `settings.json`).
 *
 * Activation: clicking the entry switches the main view region to
 * the cross-project dashboard view. HS-8481 owns the dashboard
 * render itself; this module lazy-imports `./telemetryDashboard.js`
 * and calls its `showTelemetryDashboard` entry point.
 *
 * Re-fetch triggers:
 *   - App boot (lazy import + call from `app.tsx`).
 *   - After the Settings → Telemetry master toggle changes — the
 *     settings dialog calls `refreshTelemetrySidebarVisibility()`
 *     after its PATCH so the entry appears / disappears instantly.
 */

import { api } from './api.js';

let lastEnabled: boolean | null = null;

function setSectionVisibility(enabled: boolean): void {
  // Legacy sidebar entry (HS-8479) — removed by HS-8509 Phase 5.
  const section = document.getElementById('sidebar-section-telemetry');
  if (section !== null) section.style.display = enabled ? '' : 'none';

  // HS-8507 / §70.2 — new header-bar button. Toggled alongside the
  // legacy entry so users have parallel access during the HS-8503
  // Phase 3 / 4 / 5 migration. Once HS-8509 retires the sidebar
  // entry, this is the only toggle that remains.
  const headerBtn = document.getElementById('cross-project-stats-toggle');
  if (headerBtn !== null) headerBtn.style.display = enabled ? '' : 'none';
}

/** Fetch + apply the conditional visibility. Idempotent — repeat
 *  calls do nothing when the value hasn't changed. */
export async function refreshTelemetrySidebarVisibility(): Promise<void> {
  try {
    const result = await api<{ enabled: boolean }>('/telemetry/enabled-anywhere');
    if (result.enabled === lastEnabled) return;
    lastEnabled = result.enabled;
    setSectionVisibility(result.enabled);
  } catch {
    // Network blip — leave the previous state in place. The next
    // settings PATCH will retry.
  }
}

/** Wire the click handlers for the cross-project stats entry points.
 *  Idempotent — document-level click listeners are installed once per
 *  page load. Two entry points are wired in parallel during the HS-8503
 *  Phase 3 / 4 / 5 migration: the legacy sidebar entry (HS-8479) and
 *  the new header button (HS-8507). HS-8509 will retire the sidebar
 *  half. Both lazy-import `crossProjectStatsPage` so the module stays
 *  out of the initial bundle. */
export function initTelemetrySidebar(): void {
  function showPage(): void {
    void import('./crossProjectStatsPage.js').then(({ showCrossProjectStatsPage }) => {
      showCrossProjectStatsPage();
    }).catch(() => {
      // Module not present yet — no-op.
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target === null) return;
    const sidebarItem = target.closest<HTMLElement>('.sidebar-item[data-view="telemetry-dashboard"]');
    if (sidebarItem !== null) {
      document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
      sidebarItem.classList.add('active');
      showPage();
      return;
    }
    // HS-8507 — header-bar button (no `.active` class management; it
    // doesn't live in the sidebar's active-row system).
    const headerBtn = target.closest<HTMLElement>('#cross-project-stats-toggle');
    if (headerBtn !== null) {
      document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
      showPage();
    }
  });

  void refreshTelemetrySidebarVisibility();
}
