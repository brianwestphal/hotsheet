import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { getTauriInvoke, openExternalUrl } from './tauriIntegration.js';

/**
 * HS-7962 — npm-version → installable-version upgrade nudge.
 *
 * Shows a one-shot overlay on app boot, throttled to ≤ once / 30 days, that
 * encourages the user to switch to the installable Tauri build (which adds
 * the embedded terminal + auto-updates + native-OS integration the npm
 * server can't provide). Suppressed entirely when the running client is
 * already Tauri (`getTauriInvoke() !== null`).
 *
 * Throttle state lives in localStorage under
 * `hotsheet_upgrade_nudge_last_shown` — a millisecond timestamp. The
 * "Don't show again" button writes `Number.MAX_SAFE_INTEGER` so the
 * throttle never re-fires for that browser. The X-close + "Maybe later"
 * paths write `Date.now()` so the user gets re-prompted in 30 days.
 *
 * The big primary CTA links directly to the asset matching the user's
 * detected platform (via a lazy `https://api.github.com/repos/.../releases/latest`
 * fetch). On any failure (rate limit, no internet, asset shape changed)
 * the button falls back to `/releases/latest` so the user always has SOME
 * place to land.
 *
 * Tauri-safe — uses `openExternalUrl` for every link click (regular
 * `window.open` silently no-ops in WKWebView, but in this codepath we're
 * gated to non-Tauri so plain `window.open` would also work; using the
 * helper keeps the call sites uniform with the rest of the codebase).
 */

const LOCAL_STORAGE_KEY = 'hotsheet_upgrade_nudge_last_shown';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NEVER_AGAIN = Number.MAX_SAFE_INTEGER;

const REPO = 'brianwestphal/hotsheet';
const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases/latest`;
const GITHUB_API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

export type DetectedPlatform = 'macOS' | 'Linux' | 'Windows';

export interface PlatformResolved {
  platform: DetectedPlatform;
  /** User-facing label rendered on the primary button ("Download for macOS"). */
  label: string;
  /** Resolved asset URL, or `RELEASES_LATEST_URL` if no per-platform asset
   *  could be picked. The fallback is intentional — every release page is
   *  navigable; the button never dead-ends. */
  downloadUrl: string;
}

/**
 * Pure platform classifier — exported for unit testing. Falls back to `null`
 * when the user agent is unrecognised (e.g. an exotic browser, a future OS),
 * which signals the caller to skip the nudge entirely rather than surface a
 * generic button that might mislead.
 */
export function detectPlatform(userAgent: string): DetectedPlatform | null {
  if (/Mac/i.test(userAgent)) return 'macOS';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return null;
}

/**
 * Pure asset picker — given the GitHub API release JSON's `assets` array and
 * the detected platform, return the best-match asset URL. The match patterns
 * are deliberately conservative: macOS goes for the renamed Apple-Silicon
 * dmg first (the post-2020 default), Windows goes for the .exe installer,
 * Linux goes for the AppImage (most distro-portable).
 *
 * Returns `null` when no asset matches, so the caller can fall back to the
 * /releases/latest landing page.
 */
export function pickPlatformAsset(
  assets: Array<{ name: string; browser_download_url: string }>,
  platform: DetectedPlatform,
): string | null {
  const patterns: Record<DetectedPlatform, RegExp[]> = {
    macOS: [
      /^HotSheet-.*-macOS-Apple-Silicon\.dmg$/,
      /^HotSheet-.*-macOS-Intel\.dmg$/,
    ],
    Linux: [
      /amd64\.AppImage$/,
      /amd64\.deb$/,
      /x86_64\.rpm$/,
    ],
    Windows: [
      /x64-setup\.exe$/,
      /x64_en-US\.msi$/,
    ],
  };
  for (const pattern of patterns[platform]) {
    const match = assets.find(a => pattern.test(a.name));
    if (match !== undefined) return match.browser_download_url;
  }
  return null;
}

/**
 * Lazily fetch the latest release JSON from GitHub + pick the best per-
 * platform asset. Caches the resolved value in module state so subsequent
 * calls within a session are instant. Returns the resolved-platform shape
 * even when the fetch fails — `downloadUrl` falls back to the /releases/latest
 * landing page so the button never dead-ends.
 */
let cachedResolved: PlatformResolved | null = null;

async function resolveDownload(platform: DetectedPlatform): Promise<PlatformResolved> {
  if (cachedResolved !== null && cachedResolved.platform === platform) return cachedResolved;
  const label = `Download for ${platform}`;
  let downloadUrl = RELEASES_LATEST_URL;
  try {
    const res = await fetch(GITHUB_API_LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.ok) {
      const json = await res.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
      const assets = Array.isArray(json.assets) ? json.assets : [];
      const picked = pickPlatformAsset(assets, platform);
      if (picked !== null) downloadUrl = picked;
    }
  } catch {
    // Offline / rate-limited / shape changed — keep the /releases/latest fallback.
  }
  cachedResolved = { platform, label, downloadUrl };
  return cachedResolved;
}

/**
 * Pure throttle gate — exported for unit testing. Returns true when enough
 * time has elapsed since the last shown timestamp (or it's never shown).
 */
export function shouldShowNudge(lastShownMs: number | null, nowMs: number, intervalMs: number = THIRTY_DAYS_MS): boolean {
  if (lastShownMs === null) return true;
  if (lastShownMs >= NEVER_AGAIN) return false;
  return (nowMs - lastShownMs) >= intervalMs;
}

/**
 * Public entry point. Called once on app boot. No-ops when running inside
 * Tauri OR when the throttle window hasn't elapsed OR when the platform
 * can't be detected. Fire-and-forget — the dialog manages its own
 * lifecycle.
 */
export function maybeShowUpgradeNudge(): void {
  // Tauri build — already installed, skip.
  if (getTauriInvoke() !== null) return;

  // Platform we don't recognise — skip rather than render a generic button.
  const platform = detectPlatform(navigator.userAgent);
  if (platform === null) return;

  // Throttle — see `shouldShowNudge`.
  const stored = readLastShown();
  if (!shouldShowNudge(stored, Date.now())) return;

  void (async () => {
    const resolved = await resolveDownload(platform);
    showUpgradeNudgeDialog(resolved);
  })();
}

function readLastShown(): number | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastShown(value: number): void {
  try { localStorage.setItem(LOCAL_STORAGE_KEY, String(value)); } catch { /* private mode etc. */ }
}

const DOWNLOAD_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
const CLOSE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/** Build + mount the dialog. Exported so tests can drive it without going
 *  through the throttle / Tauri / platform-detection gates. */
export function showUpgradeNudgeDialog(resolved: PlatformResolved): void {
  // Drop any prior overlay so a re-trigger during the same session doesn't
  // stack two on top of each other.
  document.querySelectorAll('.upgrade-nudge-overlay').forEach(el => el.remove());

  const overlay = toElement(
    <div className="upgrade-nudge-overlay" role="dialog" aria-modal="true" aria-label="Get the desktop app">
      <div className="upgrade-nudge-dialog">
        <div className="upgrade-nudge-header">
          <span className="upgrade-nudge-title">Get the desktop app</span>
          <button className="upgrade-nudge-close" type="button" title="Close" aria-label="Close">
            {raw(CLOSE_ICON_SVG)}
          </button>
        </div>
        <div className="upgrade-nudge-body">
          <p>
            Hot Sheet's installable version adds an <strong>embedded terminal</strong> — see your shell, Claude, and any other tool right alongside your tickets. Plus auto-updates, native-OS integration, and a few other features the npm-launched server can't provide.
          </p>
          <button className="upgrade-nudge-cta" type="button">
            {raw(DOWNLOAD_ICON_SVG)}
            <span>{resolved.label}</span>
          </button>
          <button className="upgrade-nudge-secondary" type="button">View All Releases</button>
          <a className="upgrade-nudge-dismiss" href="#">Don't show again</a>
        </div>
      </div>
    </div>
  );

  const close = (rememberForever: boolean): void => {
    overlay.remove();
    writeLastShown(rememberForever ? NEVER_AGAIN : Date.now());
  };

  overlay.querySelector('.upgrade-nudge-close')!.addEventListener('click', () => close(false));
  overlay.querySelector('.upgrade-nudge-cta')!.addEventListener('click', () => {
    openExternalUrl(resolved.downloadUrl);
    close(false);
  });
  overlay.querySelector('.upgrade-nudge-secondary')!.addEventListener('click', () => {
    openExternalUrl(RELEASES_LATEST_URL);
    close(false);
  });
  overlay.querySelector('.upgrade-nudge-dismiss')!.addEventListener('click', (e) => {
    e.preventDefault();
    close(true);
  });
  overlay.addEventListener('click', (e) => {
    // Backdrop click → "maybe later" (re-prompt in 30 days).
    if (e.target === overlay) close(false);
  });

  document.body.appendChild(overlay);
}
