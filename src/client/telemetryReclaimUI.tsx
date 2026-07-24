import { reclaimTelemetryWal, type ReclaimWalResult } from '../api/index.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull } from './dom.js';

/**
 * HS-9427 (docs/127 §127.5) — Settings → Telemetry "Reclaim telemetry disk"
 * button. Rebuilds every telemetry cluster whose `pg_wal` exceeds the threshold
 * (dump → reload under the HS-9426 WAL budget), reclaiming disk that VACUUM /
 * CHECKPOINT cannot (HS-9422). Machine-wide and lossless — all telemetry is
 * preserved; only WAL is shed.
 *
 * Mirrors `telemetryClearUI.tsx`: a thin confirm → fetch → status binder plus a
 * pure result formatter so the message logic is unit-testable without the DOM.
 */

const MB = 1024 * 1024;

/** Human MB, no decimals. */
function mb(bytes: number): string {
  return `${Math.round(bytes / MB).toLocaleString('en-US')} MB`;
}

/**
 * Pure formatter for the post-reclaim status line. Exported for unit-testing.
 * Covers: nothing over threshold, a successful reclaim (freed bytes), and a
 * partial failure (some clusters couldn't be rebuilt).
 */
export function formatReclaimResult(r: ReclaimWalResult): string {
  if (r.reclaimed === 0 && r.failed === 0) {
    return 'No telemetry disk to reclaim — everything is already compact.';
  }
  const parts: string[] = [];
  if (r.reclaimed > 0) {
    parts.push(`Reclaimed ${mb(r.freedBytes)} across ${r.reclaimed} ${r.reclaimed === 1 ? 'database' : 'databases'}.`);
  }
  if (r.failed > 0) {
    parts.push(`${r.failed} ${r.failed === 1 ? 'database' : 'databases'} could not be rebuilt (left unchanged).`);
  }
  return parts.join(' ');
}

function setStatus(el: HTMLElement | null, text: string, cls: '' | 'is-success' | 'is-error'): void {
  if (el === null) return;
  el.textContent = text;
  el.classList.remove('is-success', 'is-error');
  if (cls !== '') el.classList.add(cls);
}

/**
 * Wire the "Reclaim telemetry disk" button. Idempotent-safe; no-op when the
 * button isn't present.
 */
export function bindReclaimTelemetryButton(): void {
  const btn = byIdOrNull<HTMLButtonElement>('settings-telemetry-reclaim-btn');
  const status = byIdOrNull('settings-telemetry-reclaim-status');
  if (btn === null) return;

  btn.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog({
        title: 'Reclaim telemetry disk',
        message: 'Rebuild each project’s telemetry database to reclaim write-ahead-log disk that ordinary cleanup can’t. All your telemetry is kept — nothing is deleted. This can take a few seconds per project.',
        confirmLabel: 'Reclaim disk',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;

      btn.disabled = true;
      setStatus(status, 'Reclaiming…', '');
      try {
        const result = await reclaimTelemetryWal();
        setStatus(status, formatReclaimResult(result), result.failed > 0 ? 'is-error' : 'is-success');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(status, `Failed to reclaim: ${message}`, 'is-error');
      } finally {
        btn.disabled = false;
      }
    })();
  });
}
