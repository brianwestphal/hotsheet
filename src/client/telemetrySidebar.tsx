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

import { api } from './api.js';

let lastEnabled: boolean | null = null;

function setSectionVisibility(enabled: boolean): void {
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

/** Wire the click handler for the cross-project stats header button.
 *  Idempotent — the document-level click listener is installed once
 *  per page load. Lazy-imports `crossProjectStatsPage` so the module
 *  stays out of the initial bundle for users who never click. */
export function initTelemetrySidebar(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target === null) return;
    const headerBtn = target.closest<HTMLElement>('#cross-project-stats-toggle');
    if (headerBtn === null) return;
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    void import('./crossProjectStatsPage.js').then(({ showCrossProjectStatsPage }) => {
      showCrossProjectStatsPage();
    }).catch(() => {
      // Module not present — no-op.
    });
  });

  void refreshTelemetrySidebarVisibility();
}
