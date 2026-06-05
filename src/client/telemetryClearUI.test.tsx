/**
 * HS-8606 / §74 — tests for the "Clear telemetry data" Settings button.
 * Pure formatter + the confirm → DELETE → status-line flow (cancel, success,
 * error), under happy-dom with `api` / `confirmDialog` / the lazy
 * `dashboardMode` refresh mocked.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearProjectTelemetry } from '../api/index.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { bindClearTelemetryButton, formatClearResult, resetClearTelemetryStatus } from './telemetryClearUI.js';

vi.mock('../api/index.js', () => ({ clearProjectTelemetry: vi.fn() }));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./dashboardMode.js', () => ({ refreshSidebarWidgetCost: vi.fn(), clearSidebarWidgetCostForActiveProject: vi.fn() }));

describe('formatClearResult (HS-8606)', () => {
  it('reports a friendly no-op when nothing was cleared', () => {
    expect(formatClearResult(0)).toBe('No telemetry data to clear.');
    expect(formatClearResult(-5)).toBe('No telemetry data to clear.');
  });
  it('uses the singular for exactly one row', () => {
    expect(formatClearResult(1)).toBe('Cleared 1 telemetry row.');
  });
  it('uses the plural with thousands separators for many rows', () => {
    expect(formatClearResult(1234)).toBe('Cleared 1,234 telemetry rows.');
  });
});

describe('bindClearTelemetryButton (HS-8606)', () => {
  function mountButton(): { btn: HTMLButtonElement; status: HTMLElement } {
    document.body.replaceChildren(
      toElement(
        <div>
          <button type="button" id="settings-telemetry-clear-btn">Clear Telemetry Data…</button>
          <span id="settings-telemetry-clear-status"></span>
        </div>,
      ),
    );
    bindClearTelemetryButton();
    return {
      btn: document.getElementById('settings-telemetry-clear-btn') as HTMLButtonElement,
      status: document.getElementById('settings-telemetry-clear-status') as HTMLElement,
    };
  }

  beforeEach(() => {
    vi.mocked(clearProjectTelemetry).mockReset();
    vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing when the user cancels the confirm', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const { btn, status } = mountButton();
    btn.click();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(clearProjectTelemetry).not.toHaveBeenCalled();
    expect(status.textContent).toBe('');
  });

  it('clears via DELETE and shows the success status when confirmed', async () => {
    vi.mocked(clearProjectTelemetry).mockResolvedValue({ deleted: 7 });
    const { btn, status } = mountButton();
    btn.click();
    await vi.waitFor(() => expect(status.textContent).toBe('Cleared 7 telemetry rows.'));
    // Routed through the typed DELETE caller.
    expect(clearProjectTelemetry).toHaveBeenCalled();
    expect(status.classList.contains('is-success')).toBe(true);
    // Button re-enabled afterwards.
    expect(btn.disabled).toBe(false);
  });

  it('shows an error status when the DELETE fails', async () => {
    vi.mocked(clearProjectTelemetry).mockRejectedValue(new Error("boom"));
    const { btn, status } = mountButton();
    btn.click();
    await vi.waitFor(() => expect(status.classList.contains('is-error')).toBe(true));
    expect(status.textContent).toContain('boom');
    expect(btn.disabled).toBe(false);
  });
});

// HS-8621 — the "Cleared N telemetry rows." line is one-shot + project-scoped,
// but `#settings-telemetry-clear-status` is a static element reused across
// project switches. Without a reset on dialog-open, a prior project's count
// lingered. `resetClearTelemetryStatus()` (called from the settings-open
// handler) wipes it.
describe('resetClearTelemetryStatus (HS-8621)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('clears a lingering success message + its state class', () => {
    const el = document.createElement('span');
    el.id = 'settings-telemetry-clear-status';
    el.classList.add('is-success');
    el.textContent = 'Cleared 15,093 telemetry rows.';
    document.body.appendChild(el);

    resetClearTelemetryStatus();

    expect(el.textContent).toBe('');
    expect(el.classList.contains('is-success')).toBe(false);
    expect(el.classList.contains('is-error')).toBe(false);
  });

  it('is a no-op (no throw) when the status element is absent', () => {
    document.body.innerHTML = '';
    expect(() => resetClearTelemetryStatus()).not.toThrow();
  });
});
