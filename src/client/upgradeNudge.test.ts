// @vitest-environment happy-dom
/**
 * HS-7962 — upgrade-nudge tests.
 *
 * Three pure helpers (`detectPlatform`, `pickPlatformAsset`, `shouldShowNudge`)
 * + the `showUpgradeNudgeDialog` happy-dom mount/dismiss path. The
 * `maybeShowUpgradeNudge` orchestrator isn't directly tested — its
 * branching is the union of the gates already covered by the helper-level
 * tests; mocking Tauri / fetch / localStorage / navigator at the
 * orchestration level adds noise without proving more.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectPlatform,
  pickPlatformAsset,
  shouldShowNudge,
  showUpgradeNudgeDialog,
} from './upgradeNudge.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('detectPlatform (HS-7962)', () => {
  it('matches macOS user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
    expect(detectPlatform('Mozilla/5.0 (Mac OS X)')).toBe('macOS');
  });

  it('matches Windows user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
  });

  it('matches Linux user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
  });

  it('returns null for unrecognised user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (Unknown OS)')).toBeNull();
    expect(detectPlatform('')).toBeNull();
  });

  it('is case-insensitive on the OS family token', () => {
    expect(detectPlatform('mac os')).toBe('macOS');
    expect(detectPlatform('WINDOWS')).toBe('Windows');
    expect(detectPlatform('linux 5.x')).toBe('Linux');
  });
});

describe('pickPlatformAsset (HS-7962)', () => {
  function asset(name: string): { name: string; browser_download_url: string } {
    return { name, browser_download_url: `https://example.com/${name}` };
  }

  it('picks the Apple Silicon dmg first on macOS', () => {
    const out = pickPlatformAsset([
      asset('HotSheet-0.16.2-macOS-Intel.dmg'),
      asset('HotSheet-0.16.2-macOS-Apple-Silicon.dmg'),
      asset('Hot.Sheet_0.16.2_amd64.deb'),
    ], 'macOS');
    expect(out).toBe('https://example.com/HotSheet-0.16.2-macOS-Apple-Silicon.dmg');
  });

  it('falls back to the Intel dmg on macOS when only Intel is present', () => {
    const out = pickPlatformAsset([
      asset('HotSheet-0.16.2-macOS-Intel.dmg'),
    ], 'macOS');
    expect(out).toBe('https://example.com/HotSheet-0.16.2-macOS-Intel.dmg');
  });

  it('picks the AppImage first on Linux (most distro-portable)', () => {
    const out = pickPlatformAsset([
      asset('Hot.Sheet_0.16.2_amd64.deb'),
      asset('Hot.Sheet-0.16.2-1.x86_64.rpm'),
      asset('Hot.Sheet_0.16.2_amd64.AppImage'),
    ], 'Linux');
    expect(out).toBe('https://example.com/Hot.Sheet_0.16.2_amd64.AppImage');
  });

  it('falls back to .deb on Linux when no AppImage is present', () => {
    const out = pickPlatformAsset([
      asset('Hot.Sheet_0.16.2_amd64.deb'),
      asset('Hot.Sheet-0.16.2-1.x86_64.rpm'),
    ], 'Linux');
    expect(out).toBe('https://example.com/Hot.Sheet_0.16.2_amd64.deb');
  });

  it('picks the .exe installer first on Windows', () => {
    const out = pickPlatformAsset([
      asset('Hot.Sheet_0.16.2_x64_en-US.msi'),
      asset('Hot.Sheet_0.16.2_x64-setup.exe'),
    ], 'Windows');
    expect(out).toBe('https://example.com/Hot.Sheet_0.16.2_x64-setup.exe');
  });

  it('returns null when no asset matches the platform', () => {
    expect(pickPlatformAsset([asset('something-random.txt')], 'macOS')).toBeNull();
    expect(pickPlatformAsset([], 'Linux')).toBeNull();
  });

  it('ignores unrelated assets (e.g. .sig sidecars) so macOS doesnt match a .deb.sig', () => {
    const out = pickPlatformAsset([
      asset('Hot.Sheet_0.16.2_amd64.deb.sig'),
      asset('HotSheet-0.16.2-macOS-Apple-Silicon.dmg.sig'),
      asset('HotSheet-0.16.2-macOS-Apple-Silicon.dmg'),
    ], 'macOS');
    expect(out).toBe('https://example.com/HotSheet-0.16.2-macOS-Apple-Silicon.dmg');
  });
});

describe('shouldShowNudge (HS-7962)', () => {
  const NOW = 1_000_000_000_000;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  it('shows when never shown before (null)', () => {
    expect(shouldShowNudge(null, NOW)).toBe(true);
  });

  it('does NOT show when the throttle window hasnt elapsed', () => {
    expect(shouldShowNudge(NOW - 1, NOW)).toBe(false);
    expect(shouldShowNudge(NOW - 1000, NOW)).toBe(false);
    expect(shouldShowNudge(NOW - (THIRTY_DAYS - 1), NOW)).toBe(false);
  });

  it('shows when exactly 30 days have elapsed', () => {
    expect(shouldShowNudge(NOW - THIRTY_DAYS, NOW)).toBe(true);
  });

  it('shows when more than 30 days have elapsed', () => {
    expect(shouldShowNudge(NOW - (THIRTY_DAYS + 1), NOW)).toBe(true);
    expect(shouldShowNudge(NOW - (60 * THIRTY_DAYS), NOW)).toBe(true);
  });

  it('NEVER shows when the stored value is the never-again sentinel', () => {
    expect(shouldShowNudge(Number.MAX_SAFE_INTEGER, NOW)).toBe(false);
    // Even far in the future the sentinel still suppresses.
    expect(shouldShowNudge(Number.MAX_SAFE_INTEGER, NOW + 100 * THIRTY_DAYS)).toBe(false);
  });

  it('respects a custom interval (test-friendly)', () => {
    const fiveSec = 5_000;
    expect(shouldShowNudge(NOW - 4_000, NOW, fiveSec)).toBe(false);
    expect(shouldShowNudge(NOW - 5_000, NOW, fiveSec)).toBe(true);
  });
});

describe('showUpgradeNudgeDialog (HS-7962)', () => {
  it('mounts a dialog with the platform-aware CTA label', () => {
    showUpgradeNudgeDialog({
      platform: 'macOS',
      label: 'Download for macOS',
      downloadUrl: 'https://example.com/dmg',
    });
    const cta = document.querySelector('.upgrade-nudge-cta');
    expect(cta?.textContent).toContain('Download for macOS');
  });

  it('header reads "Get the desktop app"', () => {
    showUpgradeNudgeDialog({ platform: 'Linux', label: 'Download for Linux', downloadUrl: 'https://x' });
    expect(document.querySelector('.upgrade-nudge-title')?.textContent).toBe('Get the desktop app');
  });

  it('clicking the X removes the overlay', () => {
    showUpgradeNudgeDialog({ platform: 'Windows', label: 'Download for Windows', downloadUrl: 'https://x' });
    expect(document.querySelector('.upgrade-nudge-overlay')).not.toBeNull();
    (document.querySelector('.upgrade-nudge-close') as HTMLButtonElement).click();
    expect(document.querySelector('.upgrade-nudge-overlay')).toBeNull();
  });

  it('a second open replaces the first overlay rather than stacking', () => {
    showUpgradeNudgeDialog({ platform: 'macOS', label: 'A', downloadUrl: 'https://x' });
    showUpgradeNudgeDialog({ platform: 'macOS', label: 'B', downloadUrl: 'https://y' });
    const overlays = document.querySelectorAll('.upgrade-nudge-overlay');
    expect(overlays.length).toBe(1);
    expect(document.querySelector('.upgrade-nudge-cta')?.textContent).toContain('B');
  });

  it('clicking the dismiss link writes the never-again sentinel to localStorage', () => {
    localStorage.removeItem('hotsheet_upgrade_nudge_last_shown');
    showUpgradeNudgeDialog({ platform: 'macOS', label: 'x', downloadUrl: 'https://x' });
    (document.querySelector('.upgrade-nudge-dismiss') as HTMLAnchorElement).click();
    const stored = localStorage.getItem('hotsheet_upgrade_nudge_last_shown');
    expect(stored).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it('clicking the X writes a recent timestamp (not the never-again sentinel)', () => {
    localStorage.removeItem('hotsheet_upgrade_nudge_last_shown');
    const before = Date.now();
    showUpgradeNudgeDialog({ platform: 'macOS', label: 'x', downloadUrl: 'https://x' });
    (document.querySelector('.upgrade-nudge-close') as HTMLButtonElement).click();
    const stored = Number(localStorage.getItem('hotsheet_upgrade_nudge_last_shown'));
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
