// @vitest-environment happy-dom
// HS-9513 (docs/121 §121.7) — the "Retry Codex drive" button that replaced the
// `codexAppServerEnabled` Experimental toggle.
//
// The toggle was labeled a readiness gate but was really the only in-app way to clear a
// handshake failure — recovery was "switch it off and on", with the drive surface having
// silently vanished in the first place. These pin the two things that make the
// replacement an actual improvement: the retry re-runs the channel init so the surface
// comes back immediately, and a failed retry doesn't leave the button dead.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ retryCodexDrive: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock('../api/index.js', () => ({ retryCodexDrive: h.retryCodexDrive }));

const { bindCodexDriveRetry } = await import('./codexDriveRetry.js');

function button(): HTMLButtonElement {
  return document.getElementById('codex-drive-retry-btn') as HTMLButtonElement;
}
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  h.retryCodexDrive.mockImplementation(() => Promise.resolve({ ok: true }));
  document.body.innerHTML = '<button id="codex-drive-retry-btn"></button>';
});

describe('bindCodexDriveRetry', () => {
  it('calls the retry endpoint on click', async () => {
    bindCodexDriveRetry(() => { /* noop */ });
    button().click();
    await settle();
    expect(h.retryCodexDrive).toHaveBeenCalledTimes(1);
  });

  it('re-runs the caller hook so the play surface returns without waiting for a poll', async () => {
    // Without this the user clicks Retry, the request succeeds, and the failure row
    // stays up until the next status poll — which reads as "nothing happened".
    const onRetried = vi.fn();
    bindCodexDriveRetry(onRetried);
    button().click();
    await settle();
    expect(onRetried).toHaveBeenCalledTimes(1);
  });

  it('disables the button for the round-trip, then re-enables it', async () => {
    // The retry re-prestarts a daemon, so a double-click would start a second one.
    let resolve: (v: { ok: boolean }) => void = () => { /* set below */ };
    h.retryCodexDrive.mockImplementation(() => new Promise<{ ok: boolean }>(r => { resolve = r; }));
    bindCodexDriveRetry(() => { /* noop */ });

    button().click();
    await Promise.resolve();
    expect(button().disabled).toBe(true);

    resolve({ ok: true });
    await settle();
    expect(button().disabled).toBe(false);
  });

  it('re-enables after a FAILED retry, so the user can try again', async () => {
    // A dead button after one failed attempt would be worse than the toggle it replaced.
    h.retryCodexDrive.mockImplementation(() => Promise.reject(new Error('server down')));
    const onRetried = vi.fn();
    bindCodexDriveRetry(onRetried);

    button().click();
    await settle();
    expect(button().disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled(); // nothing to re-render — it did not work
  });

  it('is a no-op when the button is absent (minimal DOM)', () => {
    document.body.innerHTML = '';
    expect(() => { bindCodexDriveRetry(() => { /* noop */ }); }).not.toThrow();
  });
});
