import { byIdOrNull, toElement } from './dom.js';

/**
 * HS-8088 — Tauri's runtime injects `window.__TAURI__` with three optional
 * sub-bags: `core` (invoke), `event` (listen), `notification`. Pre-fix
 * three callsites inside this file each cast `window` through
 * `as unknown as Record<string, unknown>` and then re-narrowed the
 * `__TAURI__` value with a per-callsite shape; consolidated here so
 * callers reference one interface instead of three duplicates of the
 * same cast pair.
 */
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
interface TauriRuntime {
  core?: { invoke: TauriInvoke };
  event?: { listen?: TauriListen };
  notification?: TauriNotificationGlobal;
}
interface WindowWithTauri extends Window { __TAURI__?: TauriRuntime }

export function getTauriInvoke(): TauriInvoke | null {
  const tauri = (window as WindowWithTauri).__TAURI__;
  return tauri?.core?.invoke ?? null;
}

/** Type of the Tauri event-listener (`window.__TAURI__.event.listen`). Used
 *  for HS-7596 / §37 to receive the `quit-confirm-requested` event the Rust
 *  side fires when the user attempts to close the window. Returns null when
 *  Tauri isn't loaded (browser context) so callers can no-op cleanly. */
type TauriListen = (
  event: string,
  handler: (payload: { payload: unknown }) => void,
) => Promise<() => void>;

export function getTauriEventListener(): TauriListen | null {
  const tauri = (window as WindowWithTauri).__TAURI__;
  return tauri?.event?.listen ?? null;
}

/** Request user attention — bounces dock icon in Tauri, flashes tab title in browser.
 *  @param level - 'once' = single bounce, 'persistent' = keep bouncing until focused */
export function requestAttention(level: 'once' | 'persistent') {
  const invoke = getTauriInvoke();
  if (invoke) {
    // Tauri: custom command that calls request_user_attention.
    // 'persistent' = Critical (bounces until focused), 'once' = Informational (single bounce).
    invoke(level === 'persistent' ? 'request_attention' : 'request_attention_once').catch(() => {});
  } else if (!document.hasFocus()) {
    // Browser: flash the tab title
    const maxFlashes = level === 'persistent' ? 30 : 6;
    const originalTitle = document.title;
    let flashes = 0;
    const interval = setInterval(() => {
      document.title = flashes % 2 === 0 ? '\u26a0 Hot Sheet needs attention' : originalTitle;
      flashes++;
      if (flashes >= maxFlashes || document.hasFocus()) {
        clearInterval(interval);
        document.title = originalTitle;
      }
    }, 800);
  }
}

export function showUpdateBanner(version: string) {
  const banner = byIdOrNull('update-banner');
  if (!banner) return;

  const label = byIdOrNull('update-banner-label');
  if (label) label.textContent = `Update available: v${version}`;

  banner.style.display = 'flex';

  const installBtn = byIdOrNull<HTMLButtonElement>('update-install-btn');
  installBtn?.addEventListener('click', async () => {
    installBtn.textContent = 'Installing...';
    installBtn.disabled = true;
    try {
      const invoke = getTauriInvoke();
      await invoke?.('install_update');
      if (label) label.textContent = 'Update installed! Restart the app to apply.';
      installBtn.style.display = 'none';
    } catch {
      installBtn.textContent = 'Install Failed';
      installBtn.disabled = false;
    }
  });

  const dismissBtn = byIdOrNull('update-banner-dismiss');
  dismissBtn?.addEventListener('click', () => {
    banner.style.display = 'none';
  });
}

export async function checkForUpdate() {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  // Show the "Updates" tab and panel in settings
  const section = byIdOrNull('settings-updates-section');
  if (section) section.style.display = '';
  const updatesTab = byIdOrNull('settings-tab-updates');
  if (updatesTab) updatesTab.style.display = '';

  // The Rust update check is async and may not have completed yet.
  // Poll a few times with increasing delays to catch it.
  const delays = [0, 3000, 10000];
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const version = (await invoke('get_pending_update')) as string | null;
      if (typeof version === 'string' && version !== '') {
        showUpdateBanner(version);
        return;
      }
    } catch {
      return;
    }
  }
}

export function showSkillsBanner() {
  const banner = byIdOrNull('skills-banner');
  if (!banner) return;
  banner.style.display = 'flex';
  const dismissBtn = byIdOrNull('skills-banner-dismiss');
  dismissBtn?.addEventListener('click', () => { banner.style.display = 'none'; });
}

/** HS-7272 — native OS notification helpers.
 *
 *  `tauri-plugin-notification` exposes `isPermissionGranted` / `requestPermission`
 *  on `window.__TAURI__.notification` when `withGlobalTauri` is set (see
 *  `tauri.conf.json`). We access it through the global object so the browser
 *  build doesn't have to import a Tauri-only module. Permission is requested
 *  once per app lifetime — macOS routes the first call through the OS
 *  permission prompt; subsequent calls short-circuit on `isPermissionGranted`.
 *
 *  `fireNativeNotification` invokes the Rust-side `show_native_notification`
 *  command (see `src-tauri/src/lib.rs`), which calls
 *  `app.notification().builder().show()`. When running in a browser,
 *  `getTauriInvoke()` returns null and the function resolves to `false` — the
 *  caller (e.g. `bellPoll.maybeFireNotificationToast`) still fires the in-app
 *  toast, so browser users don't miss the message.
 *
 *  `isAppBackgrounded` is the gate the caller uses to avoid a double
 *  notification when the Hot Sheet window is already focused — toast alone is
 *  enough in that case.
 */
interface TauriNotificationGlobal {
  isPermissionGranted?: () => Promise<boolean>;
  requestPermission?: () => Promise<string>;
}

function getTauriNotificationGlobal(): TauriNotificationGlobal | null {
  const tauri = (window as WindowWithTauri).__TAURI__;
  return tauri?.notification ?? null;
}

let notificationPermissionPrimed = false;

export async function requestNativeNotificationPermission(): Promise<void> {
  if (notificationPermissionPrimed) return;
  notificationPermissionPrimed = true;
  const api = getTauriNotificationGlobal();
  if (api?.isPermissionGranted == null || api.requestPermission == null) return;
  try {
    const granted = await api.isPermissionGranted();
    if (!granted) await api.requestPermission();
  } catch {
    // Permission prompt failure is non-fatal — the toast channel still works.
  }
}

export async function fireNativeNotification(title: string, body: string): Promise<boolean> {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke('show_native_notification', { title, body });
    return true;
  } catch {
    return false;
  }
}

export function isAppBackgrounded(): boolean {
  return document.hidden || !document.hasFocus();
}

/** Test-only reset of the permission-primed guard. Not exported to production
 *  callers — tests import via the .js path and need a clean slate between cases. */
export function _resetNotificationPermissionForTests(): void {
  notificationPermissionPrimed = false;
}

/** Open an external URL from anywhere in the client.
 *
 *  Tauri WKWebView silently no-ops `window.open`, so we route through the
 *  `open_url` Tauri command first and only fall back to `window.open` when
 *  we're not in Tauri (browser context) or the command is unavailable.
 *  Callers include the global link interceptor below (HTML `<a>` clicks),
 *  xterm's `WebLinksAddon` custom handler (plain URL detection, HS-7263),
 *  and xterm's OSC 8 `linkHandler` (hyperlink escapes, HS-7263).
 */
export function openExternalUrl(url: string): void {
  const invoke = getTauriInvoke();
  if (invoke) {
    invoke('open_url', { url }).catch(() => {
      // Fallback if the command isn't available in the running Tauri build.
      window.open(url, '_blank');
    });
  } else {
    window.open(url, '_blank');
  }
}

/**
 * HS-9024 — save `bytes` to disk under `defaultName`. In Tauri, routes through
 * the native `save_file` command (WKWebView silently no-ops `<a download>`, the
 * exact Tauri-unsafe class the web-and-Tauri rule warns about); in a real
 * browser, falls back to a Blob + `<a download>` (which works there). Returns
 * true if the file was written, false if the user canceled the native dialog.
 */
export async function saveBytes(defaultName: string, bytes: Uint8Array, mimeType = 'application/octet-stream'): Promise<boolean> {
  const invoke = getTauriInvoke();
  if (invoke) {
    // Tauri IPC serializes the byte array to a JSON number[] → Rust `Vec<u8>`.
    // `.p12` bundles are a few KB, so the overhead is negligible.
    const saved = await invoke('save_file', { defaultName, contents: Array.from(bytes) });
    return saved === true;
  }
  // Browser: a Blob download. `<a download>` works in real browsers (it only
  // no-ops inside Tauri's WKWebView, which the branch above handles).
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  try {
    const a = toElement(<a href={url} download={defaultName} style="display:none" />);
    document.body.appendChild(a);
    if (a instanceof HTMLAnchorElement) a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return true;
}

/** Intercept external link clicks and open them via Tauri shell or window.open. */
export function bindExternalLinkHandler() {
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const href = anchor.href;
    if (!href.startsWith('http://') && !href.startsWith('https://')) return;
    // Don't intercept links to our own app
    if (href.startsWith(window.location.origin)) return;

    e.preventDefault();
    openExternalUrl(href);
  });
}
