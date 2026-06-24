// @vitest-environment happy-dom
/**
 * HS-8560 — additional coverage for `src/client/tauriIntegration.tsx`.
 *
 * The existing `tauriIntegration.test.ts` covers `requestNativeNotificationPermission`
 * / `fireNativeNotification` / `isAppBackgrounded` in a globals-stubbed environment.
 * This file picks up the rest of the module (the DOM-touching helpers — banner
 * surfaces, link interceptor, `getTauriInvoke` / `getTauriEventListener`,
 * `requestAttention`, `openExternalUrl`) under happy-dom.
 *
 * `__TAURI__` is injected on `window` per test and removed in `afterEach` so
 * Tauri-on and Tauri-off code paths are both exercised cleanly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindExternalLinkHandler,
  checkForUpdate,
  getTauriEventListener,
  getTauriInvoke,
  openExternalUrl,
  requestAttention,
  showSkillsBanner,
  showUpdateBanner,
} from './tauriIntegration.js';

interface TauriOverrides {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen?: (
    event: string,
    handler: (payload: { payload: unknown }) => void,
  ) => Promise<() => void>;
}

function installTauri(overrides: TauriOverrides = {}): void {
  const tauri: Record<string, unknown> = {};
  if (overrides.invoke) tauri.core = { invoke: overrides.invoke };
  if (overrides.listen) tauri.event = { listen: overrides.listen };
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = tauri;
}

function clearTauri(): void {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  clearTauri();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getTauriInvoke', () => {
  it('returns null when __TAURI__ is absent', () => {
    expect(getTauriInvoke()).toBeNull();
  });

  it('returns null when __TAURI__.core is absent', () => {
    installTauri();
    expect(getTauriInvoke()).toBeNull();
  });

  it('returns the invoke function when wired', () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>();
    installTauri({ invoke });
    expect(getTauriInvoke()).toBe(invoke);
  });
});

describe('getTauriEventListener', () => {
  it('returns null when __TAURI__ is absent', () => {
    expect(getTauriEventListener()).toBeNull();
  });

  it('returns null when __TAURI__.event is absent', () => {
    installTauri({ invoke: vi.fn<(cmd: string) => Promise<unknown>>() });
    expect(getTauriEventListener()).toBeNull();
  });

  it('returns the listen function when wired', () => {
    const listen = vi.fn<
      (event: string, handler: (payload: { payload: unknown }) => void) => Promise<() => void>
    >();
    installTauri({ listen });
    expect(getTauriEventListener()).toBe(listen);
  });
});

describe('requestAttention', () => {
  it('invokes `request_attention_once` for level=once in Tauri', () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue(undefined);
    installTauri({ invoke });
    requestAttention('once');
    expect(invoke).toHaveBeenCalledWith('request_attention_once');
  });

  it('invokes `request_attention` for level=persistent in Tauri', () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue(undefined);
    installTauri({ invoke });
    requestAttention('persistent');
    expect(invoke).toHaveBeenCalledWith('request_attention');
  });

  it('swallows the invoke rejection (no unhandled-promise warning)', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockRejectedValue(new Error('x'));
    installTauri({ invoke });
    requestAttention('once');
    // Drain the microtask so the .catch() runs before the test ends.
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalled();
  });

  it('flashes the tab title in browser mode when the window is unfocused', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const original = document.title;
    document.title = 'Hot Sheet';

    requestAttention('once');

    // First tick → flashes[0]%2===0 path sets the warning title.
    vi.advanceTimersByTime(800);
    expect(document.title).toBe('⚠ Hot Sheet needs attention');
    // Second tick alternates back.
    vi.advanceTimersByTime(800);
    expect(document.title).toBe('Hot Sheet');

    // Drain to the cap (6 flashes for 'once') so the interval clears.
    vi.advanceTimersByTime(800 * 8);
    expect(document.title).toBe('Hot Sheet');
    document.title = original;
  });

  it('does NOT flash the tab title when the window is focused (browser, no Tauri)', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.title = 'Hot Sheet';

    requestAttention('once');
    vi.advanceTimersByTime(800 * 10);

    expect(document.title).toBe('Hot Sheet');
  });
});

describe('showUpdateBanner', () => {
  function installBannerDom(): void {
    document.body.innerHTML = `
      <div id="update-banner" style="display: none;">
        <span id="update-banner-label"></span>
        <button id="update-install-btn">Install</button>
        <button id="update-banner-dismiss">Dismiss</button>
      </div>
    `;
  }

  it('returns silently when no #update-banner is mounted', () => {
    expect(() => showUpdateBanner('1.2.3')).not.toThrow();
  });

  it('reveals the banner, sets the version label, wires install + dismiss', async () => {
    installBannerDom();
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue(undefined);
    installTauri({ invoke });

    showUpdateBanner('1.2.3');

    const banner = document.getElementById('update-banner') as HTMLElement;
    const label = document.getElementById('update-banner-label') as HTMLElement;
    const installBtn = document.getElementById('update-install-btn') as HTMLButtonElement;
    const dismissBtn = document.getElementById('update-banner-dismiss') as HTMLElement;

    expect(banner.style.display).toBe('flex');
    expect(label.textContent).toBe('Update available: v1.2.3');

    installBtn.click();
    // Wait for the awaited invoke + label rewrite.
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('install_update');
    expect(label.textContent).toBe('Update installed! Restart the app to apply.');
    expect(installBtn.style.display).toBe('none');

    dismissBtn.click();
    expect(banner.style.display).toBe('none');
  });

  it('renders the install-failed state when the Tauri command rejects', async () => {
    installBannerDom();
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockRejectedValue(new Error('x'));
    installTauri({ invoke });

    showUpdateBanner('2.0.0');
    const installBtn = document.getElementById('update-install-btn') as HTMLButtonElement;
    installBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(installBtn.textContent).toBe('Install Failed');
    expect(installBtn.disabled).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('returns silently in browser mode (no Tauri invoke)', async () => {
    await expect(checkForUpdate()).resolves.toBeUndefined();
  });

  it('reveals settings sections + shows the banner when a pending version is returned', async () => {
    document.body.innerHTML = `
      <section id="settings-updates-section" style="display: none;"></section>
      <button id="settings-tab-updates" style="display: none;"></button>
      <div id="update-banner" style="display: none;">
        <span id="update-banner-label"></span>
        <button id="update-install-btn"></button>
        <button id="update-banner-dismiss"></button>
      </div>
    `;
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue('1.5.0');
    installTauri({ invoke });

    await checkForUpdate();

    expect((document.getElementById('settings-updates-section') as HTMLElement).style.display).toBe('');
    expect((document.getElementById('settings-tab-updates') as HTMLElement).style.display).toBe('');
    expect((document.getElementById('update-banner') as HTMLElement).style.display).toBe('flex');
  });

  it('returns silently when the invoke throws (Rust side not yet ready)', async () => {
    document.body.innerHTML = '<section id="settings-updates-section"></section>';
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockRejectedValue(new Error('not ready'));
    installTauri({ invoke });

    await expect(checkForUpdate()).resolves.toBeUndefined();
  });
});

describe('showSkillsBanner', () => {
  it('returns silently when no #skills-banner is mounted', () => {
    expect(() => showSkillsBanner()).not.toThrow();
  });

  it('reveals the banner and wires the dismiss button', () => {
    document.body.innerHTML = `
      <div id="skills-banner" style="display: none;">
        <button id="skills-banner-dismiss">x</button>
      </div>
    `;
    showSkillsBanner();
    const banner = document.getElementById('skills-banner') as HTMLElement;
    expect(banner.style.display).toBe('flex');
    (document.getElementById('skills-banner-dismiss') as HTMLElement).click();
    expect(banner.style.display).toBe('none');
  });
});

describe('openExternalUrl', () => {
  it('routes through the open_url Tauri command when available', () => {
    const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    installTauri({ invoke });
    openExternalUrl('https://example.com');
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com' });
  });

  it('falls back to window.open in browser mode', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalUrl('https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank');
  });

  it('falls back to window.open if the Tauri command rejects', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockRejectedValue(new Error('x'));
    installTauri({ invoke });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalUrl('https://example.com');
    await Promise.resolve();
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank');
  });
});

describe('bindExternalLinkHandler', () => {
  it('intercepts http(s) anchor clicks and routes through openExternalUrl', () => {
    const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    installTauri({ invoke });
    bindExternalLinkHandler();

    document.body.innerHTML = '<a id="ext" href="https://example.com/foo">x</a>';
    const a = document.getElementById('ext') as HTMLAnchorElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com/foo' });
  });

  it('ignores clicks on anchors with non-http(s) hrefs (mailto, internal hash)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    bindExternalLinkHandler();

    document.body.innerHTML = '<a id="m" href="mailto:x@y.z">mail</a>';
    const a = document.getElementById('m') as HTMLAnchorElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('does NOT intercept same-origin links', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    bindExternalLinkHandler();

    document.body.innerHTML = `<a id="self" href="${window.location.origin}/foo">self</a>`;
    const a = document.getElementById('self') as HTMLAnchorElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores click events whose target is not inside any anchor', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    bindExternalLinkHandler();

    document.body.innerHTML = '<div id="d">not a link</div>';
    const d = document.getElementById('d') as HTMLElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    d.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
