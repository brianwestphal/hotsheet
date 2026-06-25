// @vitest-environment happy-dom
/**
 * HS-9022 — regression guard for the DB-recovery banner's **dismiss** path.
 *
 * The reported bug: a stale "Database recovery occurred …" warning lingered
 * "without a way to clear it." The clear mechanism is the banner's Dismiss
 * button → `dismissRecovery()` (server marker delete, covered by
 * `routes/db.test.ts`) + hiding the banner. The server side is tested; this
 * pins the **client wiring** so the Dismiss button can't silently stop
 * clearing the marker / hiding the banner.
 *
 * Also pins the two non-blocking paths: no-marker hides the banner outright,
 * and the auto-restore (`restoredFrom`) case toasts + auto-dismisses without
 * showing the blocking banner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissRecovery, getRecoveryStatus } from '../api/index.js';
import { initDbRecoveryBanner } from './dbRecoveryBanner.js';
import { showToast } from './toast.js';

vi.mock('../api/index.js', () => ({
  getRecoveryStatus: vi.fn(),
  dismissRecovery: vi.fn(),
}));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));

const mockGet = vi.mocked(getRecoveryStatus);
const mockDismiss = vi.mocked(dismissRecovery);
const mockToast = vi.mocked(showToast);

function mountBanner(): HTMLElement {
  document.body.innerHTML = `
    <div id="db-recovery-banner" class="db-recovery-banner" style="display:none">
      <span id="db-recovery-banner-label"></span>
      <div class="db-recovery-banner-actions">
        <button id="db-recovery-restore-btn"></button>
        <button id="db-recovery-dismiss-btn"></button>
      </div>
    </div>`;
  return document.getElementById('db-recovery-banner')!;
}

const MARKER = {
  corruptPath: '/tmp/db-corrupt-1',
  recoveredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  errorMessage: 'Aborted().',
};

beforeEach(() => {
  mockGet.mockReset();
  mockDismiss.mockReset().mockResolvedValue({ ok: true });
  mockToast.mockReset();
  mountBanner();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('initDbRecoveryBanner — dismiss flow (HS-9022)', () => {
  it('shows the banner when a (non-auto-restore) marker is present', async () => {
    mockGet.mockResolvedValue(MARKER);
    await initDbRecoveryBanner();
    const banner = document.getElementById('db-recovery-banner')!;
    expect(banner.style.display).toBe('flex');
    expect(document.getElementById('db-recovery-banner-label')!.textContent).toMatch(/Database failed to load/);
  });

  it('Dismiss button clears the server marker AND hides the banner', async () => {
    mockGet.mockResolvedValue(MARKER);
    await initDbRecoveryBanner();
    const banner = document.getElementById('db-recovery-banner')!;
    expect(banner.style.display).toBe('flex');

    document.getElementById('db-recovery-dismiss-btn')!.click();
    // onclick fires `void dismissRecoveryMarker(...)`; await the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(banner.style.display).toBe('none');
  });

  it('hides the banner outright when there is no marker (nothing to clear)', async () => {
    mockGet.mockResolvedValue(null as Awaited<ReturnType<typeof getRecoveryStatus>>);
    await initDbRecoveryBanner();
    expect(document.getElementById('db-recovery-banner')!.style.display).toBe('none');
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('auto-restore marker toasts + auto-dismisses without showing the blocking banner', async () => {
    mockGet.mockResolvedValue({ ...MARKER, restoredFrom: 'snapshot', restoredTicketCount: 7 });
    await initDbRecoveryBanner();
    await Promise.resolve();
    expect(document.getElementById('db-recovery-banner')!.style.display).toBe('none');
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });
});
