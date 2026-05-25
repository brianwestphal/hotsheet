/**
 * HS-8606 / §74 — tests for the "Clear telemetry data" Settings button.
 * Pure formatter + the confirm → DELETE → status-line flow (cancel, success,
 * error), under happy-dom with `api` / `confirmDialog` / the lazy
 * `dashboardMode` refresh mocked.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { bindClearTelemetryButton, formatClearResult } from './telemetryClearUI.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./dashboardMode.js', () => ({ refreshSidebarWidgetCost: vi.fn() }));

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
          <button type="button" id="settings-telemetry-clear-btn">Clear telemetry data…</button>
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
    vi.mocked(api).mockReset();
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
    expect(api).not.toHaveBeenCalled();
    expect(status.textContent).toBe('');
  });

  it('clears via DELETE and shows the success status when confirmed', async () => {
    vi.mocked(api).mockResolvedValue({ deleted: 7 } as never);
    const { btn, status } = mountButton();
    btn.click();
    await vi.waitFor(() => expect(status.textContent).toBe('Cleared 7 telemetry rows.'));
    // Hit the DELETE endpoint.
    expect(api).toHaveBeenCalledWith('/telemetry/project-data', expect.objectContaining({ method: 'DELETE' }));
    expect(status.classList.contains('is-success')).toBe(true);
    // Button re-enabled afterwards.
    expect(btn.disabled).toBe(false);
  });

  it('shows an error status when the DELETE fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('boom'));
    const { btn, status } = mountButton();
    btn.click();
    await vi.waitFor(() => expect(status.classList.contains('is-error')).toBe(true));
    expect(status.textContent).toContain('boom');
    expect(btn.disabled).toBe(false);
  });
});
