/**
 * HS-8479 (original) → HS-8507 (Phase 3) → HS-8509 (Phase 5) —
 * visibility gate + click routing for the cross-project stats entry
 * point. Originally gated the legacy `#sidebar-section-telemetry`
 * Telemetry sidebar entry; under HS-8507 the visibility gate was
 * extended to also toggle the new `#cross-project-stats-toggle`
 * header button; under HS-8509 the legacy sidebar entry was removed
 * in full and only the header button remains.
 *
 * The module name is preserved for the duration of the next session
 * to keep the diff minimal; a follow-up sweep can rename it to
 * `crossProjectStatsButton.tsx` for clarity.
 *
 * The visibility is gated on `GET /api/telemetry/enabled-anywhere`
 * (cheap iteration over `~/.hotsheet/projects.json` + each project's
 * `settings.json` for `telemetry_enabled === true`).
 *
 * Re-fetch triggers:
 *   - App boot (lazy import + call from `app.tsx`).
 *   - After the Settings → Telemetry master toggle changes — the
 *     settings dialog calls `refreshTelemetrySidebarVisibility()`
 *     after its PATCH so the button appears / disappears instantly.
 */

import { isTelemetryEnabledAnywhere } from '../api/index.js';

let lastEnabled: boolean | null = null;

function setSectionVisibility(enabled: boolean): void {
  const headerBtn = document.getElementById('cross-project-stats-toggle');
  if (headerBtn !== null) headerBtn.style.display = enabled ? '' : 'none';
}

/** Fetch + apply the conditional visibility. Idempotent — repeat
 *  calls do nothing when the value hasn't changed. */
export async function refreshTelemetrySidebarVisibility(): Promise<void> {
  try {
    const enabled = await isTelemetryEnabledAnywhere();
    if (enabled === lastEnabled) return;
    lastEnabled = enabled;
    setSectionVisibility(enabled);
  } catch {
    // Network blip — leave the previous state in place. The next
    // settings PATCH will retry.
  }
}

/** Wire the click handler for the cross-project stats header button.
 *  Idempotent — the document-level click listener is installed once
 *  per page load. Lazy-imports `crossProjectStatsPage` so the module
 *  stays out of the initial bundle for users who never click.
 *
 *  HS-8526 — clicking the button a second time (while cross-project
 *  stats is the active surface) hides the page and restores the
 *  surface that was visible when the page was first opened (the
 *  per-project analytics dashboard OR the ticket-list view at the
 *  previous `state.view`). Mirrors the second-click-restores
 *  behavior of the `#terminal-dashboard-toggle` button. */
export function initTelemetrySidebar(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target === null) return;
    const headerBtn = target.closest<HTMLElement>('#cross-project-stats-toggle');
    if (headerBtn === null) return;
    void import('./crossProjectStatsPage.js').then(({ hideCrossProjectStatsPage, isCrossProjectStatsPageActive, showCrossProjectStatsPage }) => {
      if (isCrossProjectStatsPageActive()) {
        hideCrossProjectStatsPage();
        return;
      }
      document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
      showCrossProjectStatsPage();
    }).catch(() => {
      // Module not present — no-op.
    });
  });

  void refreshTelemetrySidebarVisibility();
}
