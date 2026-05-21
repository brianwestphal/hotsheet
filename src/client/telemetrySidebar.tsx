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
  const section = document.getElementById('sidebar-section-telemetry');
  if (section === null) return;
  section.style.display = enabled ? '' : 'none';
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

/** Wire the click handler on the Telemetry sidebar entry. Idempotent —
 *  the document-level click listener is installed once per page load,
 *  matches via `closest('.sidebar-item[data-view="telemetry-dashboard"]')`. */
export function initTelemetrySidebar(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target === null) return;
    const item = target.closest<HTMLElement>('.sidebar-item[data-view="telemetry-dashboard"]');
    if (item === null) return;
    // Mark active in the sidebar + fire the show event so
    // `telemetryDashboard.tsx` (HS-8481) can hydrate. The dashboard
    // module is lazy-imported by the listener so it doesn't bloat
    // the initial bundle.
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');
    void import('./telemetryDashboard.js').then(({ showTelemetryDashboard }) => {
      showTelemetryDashboard();
    }).catch(() => {
      // Module not present yet (HS-8481 not shipped) — no-op.
    });
  });

  void refreshTelemetrySidebarVisibility();
}
