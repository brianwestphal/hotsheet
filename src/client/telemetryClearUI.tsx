import { clearProjectTelemetry } from '../api/index.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull } from './dom.js';

/**
 * HS-8606 / §74 — Settings → Telemetry → Retention "Clear telemetry data"
 * button. Lets the user permanently delete every metric / event / trace row
 * recorded for the ACTIVE project (all time), behind a danger confirmation.
 *
 * Server side: `DELETE /api/telemetry/project-data` (`src/routes/telemetry.ts`)
 * → `clearProjectTelemetry(secret)` scopes the delete to the active project's
 * `project_secret` against the shared telemetry DB (§67.6 / HS-8581). Other
 * projects' data is untouched.
 *
 * Mirrors the `dbRepairUI.tsx` precedent: a thin binder that wires the button
 * to a confirm → fetch → status-line flow, plus a pure formatter for the
 * result message so it can be unit-tested without the DOM.
 */

/**
 * Pure formatter for the post-clear status line. Exported for unit-testing.
 * Singular / plural row count; a friendly note when there was nothing to
 * clear (the button is always enabled, so clearing an empty project is a
 * valid no-op rather than an error).
 */
export function formatClearResult(deleted: number): string {
  if (deleted <= 0) return 'No telemetry data to clear.';
  if (deleted === 1) return 'Cleared 1 telemetry row.';
  return `Cleared ${deleted.toLocaleString('en-US')} telemetry rows.`;
}

function setStatus(el: HTMLElement | null, text: string, cls: '' | 'is-success' | 'is-error'): void {
  if (el === null) return;
  el.textContent = text;
  el.classList.remove('is-success', 'is-error');
  if (cls !== '') el.classList.add(cls);
}

/**
 * HS-8621 — clear the post-clear status line. The "Cleared N telemetry rows."
 * confirmation is project-scoped and one-shot; without a reset it lingers in
 * the (static, reused) `#settings-telemetry-clear-status` element, so after
 * clearing one project and switching tabs the previous project's count is
 * still shown when the Settings dialog reopens. Called from the settings-open
 * handler so every open starts with a blank status line.
 */
export function resetClearTelemetryStatus(): void {
  setStatus(byIdOrNull('settings-telemetry-clear-status'), '', '');
}

/**
 * Wire the "Clear telemetry data" button. Idempotent-safe to call once per
 * settings-dialog binding (the button element is static in `pages.tsx`).
 * No-op when the button isn't present (e.g. plugins-disabled builds that
 * trim panels — defensive, the telemetry panel is always rendered today).
 */
export function bindClearTelemetryButton(): void {
  const btn = byIdOrNull<HTMLButtonElement>('settings-telemetry-clear-btn');
  const status = byIdOrNull('settings-telemetry-clear-status');
  if (btn === null) return;

  btn.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog({
        title: 'Clear telemetry data',
        message: 'Permanently delete all telemetry (metrics, events, and traces) recorded for this project? Other projects are unaffected. This cannot be undone.',
        confirmLabel: 'Clear data',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!ok) return;

      btn.disabled = true;
      setStatus(status, 'Clearing…', '');
      try {
        const result = await clearProjectTelemetry();
        setStatus(status, formatClearResult(result.deleted), 'is-success');
        // HS-8620 — drop the sidebar cost widget to $0 immediately. We must
        // ZERO the active project's sticky cache, not just refresh it: a plain
        // `refreshSidebarWidgetCost()` re-renders the stale cached value
        // because the cleared project is now omitted by `today-cost-by-project`
        // and the sticky cache (HS-8531) keeps showing omitted projects' last
        // value until a new prompt arrives.
        void import('./dashboardMode.js')
          .then(({ clearSidebarWidgetCostForActiveProject }) => { clearSidebarWidgetCostForActiveProject(); })
          .catch(() => { /* widget not mounted — fine */ });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(status, `Failed to clear: ${message}`, 'is-error');
      } finally {
        btn.disabled = false;
      }
    })();
  });
}
