// @vitest-environment happy-dom
// HS-9144 — branch coverage for the share-prompt timing criteria (docs/17).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';
import { initShare } from './share.js';

vi.mock('../api/index.js', () => ({
  getGlobalConfig: vi.fn(),
  updateGlobalConfig: vi.fn(() => Promise.resolve()),
}));

const mockGet = vi.mocked(getGlobalConfig);
const mockUpdate = vi.mocked(updateGlobalConfig);

function installBanner(): HTMLElement {
  document.body.innerHTML = `
    <a id="share-link"></a>
    <div id="share-banner" style="display:none">
      <button id="share-banner-share"></button>
      <button id="share-banner-dismiss"></button>
    </div>`;
  return document.getElementById('share-banner')!;
}

function config(overrides: Record<string, unknown> = {}): ReturnType<typeof getGlobalConfig> {
  return Promise.resolve({ shareTotalSeconds: 290, ...overrides } as Awaited<ReturnType<typeof getGlobalConfig>>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mockGet.mockReset();
  mockUpdate.mockClear();
  installBanner();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

/** Fire the 30s accumulate interval `ticks` times (session grows to ticks*30s). */
async function runTicks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await vi.advanceTimersByTimeAsync(30_000);
}

describe('accumulateAndCheck (share prompt criteria)', () => {
  it('shows the banner once total ≥ 5min AND session ≥ 1min AND not accepted/recently-prompted', async () => {
    mockGet.mockReturnValue(config()); // 290s + a 30s tick = 320 ≥ 300
    const banner = installBanner();
    initShare();
    await runTicks(2); // session reaches 60s on the 2nd tick
    expect(banner.style.display).toBe('flex');
    // getGlobalConfig returns 290s each tick + a 30s accumulate = 320.
    expect(mockUpdate).toHaveBeenCalledWith({ shareTotalSeconds: 320 });
  });

  it('never shows the banner when the user already accepted', async () => {
    mockGet.mockReturnValue(config({ shareAccepted: true }));
    const banner = installBanner();
    initShare();
    await runTicks(3);
    expect(banner.style.display).toBe('none');
  });

  it('does not show the banner below the 5-minute total', async () => {
    mockGet.mockReturnValue(config({ shareTotalSeconds: 0 }));
    const banner = installBanner();
    initShare();
    await runTicks(3);
    expect(banner.style.display).toBe('none');
  });

  it('does not show the banner before 1 minute of session time', async () => {
    mockGet.mockReturnValue(config());
    const banner = installBanner();
    initShare();
    await runTicks(1); // only 30s of session
    expect(banner.style.display).toBe('none');
  });

  it('does not re-prompt within the 30-day window', async () => {
    mockGet.mockReturnValue(config({ shareLastPrompted: new Date(0).toISOString() })); // "now" is also 0 → 0 days since
    const banner = installBanner();
    initShare();
    await runTicks(2);
    expect(banner.style.display).toBe('none');
  });
});

describe('banner buttons', () => {
  it('dismiss hides the banner + records shareLastPrompted', async () => {
    const banner = installBanner();
    banner.style.display = 'flex';
    initShare();
    document.getElementById('share-banner-dismiss')!.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls.at(-1)?.[0]).toHaveProperty('shareLastPrompted');
    expect(banner.style.display).toBe('none');
  });

  it('the footer share link triggers a share without throwing', () => {
    vi.stubGlobal('navigator', { share: vi.fn(() => Promise.resolve()) });
    initShare();
    expect(() => document.getElementById('share-link')!.dispatchEvent(new Event('click'))).not.toThrow();
    vi.unstubAllGlobals();
  });
});
