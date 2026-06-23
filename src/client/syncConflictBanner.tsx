// HS-8959 — generic plugin sync-conflict banner.
//
// Sync conflicts used to be discoverable only by opening Settings → Plugins and
// noticing a small tab badge — which rarely happened organically. This surfaces a
// top-of-window banner (mirroring the software-update banner, but neutral gray
// with the conflicting plugin's icon and a red conflict-count badge) whenever any
// plugin has unresolved sync conflicts in the active project. Clicking it opens
// Settings → Plugins and scrolls to the conflicts section. Generic across plugins
// — driven by `GET /sync/conflicts/summary`, not special-cased to GitHub.
import { getSyncConflictsSummary, type SyncConflictSummaryEntry } from '../api/index.js';
import { raw } from '../jsx-runtime.js';
import { byIdOrNull, toElement } from './dom.js';

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute, per the active tab
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Pure label formatter — extracted so it can be unit-tested without the DOM.
 *  Returns '' when there are no conflicts. */
export function formatConflictBannerLabel(summary: SyncConflictSummaryEntry[]): string {
  const total = summary.reduce((n, s) => n + s.count, 0);
  if (total === 0) return '';
  const verb = total === 1 ? 'conflict needs' : 'conflicts need';
  if (summary.length === 1) {
    return `${summary[0].pluginName}: ${total} sync ${verb} resolution`;
  }
  return `${total} sync ${verb} resolution across ${summary.length} plugins`;
}

/** Open Settings → Plugins and scroll the conflicts section into view. */
function openPluginsSettings(): void {
  byIdOrNull('settings-btn')?.click();
  byIdOrNull('settings-tab-plugins')?.click();
  // The conflicts section is populated asynchronously when the panel loads; give
  // it a beat before scrolling (best-effort — a no-op if it isn't visible yet).
  setTimeout(() => {
    byIdOrNull('plugin-conflicts-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

/** Wire the banner's click/keyboard handlers once per element (a `data-` guard so
 *  a re-rendered banner gets re-wired, but the same element isn't double-bound). */
function wireBanner(banner: HTMLElement): void {
  if (banner.dataset['wired'] === '1') return;
  banner.dataset['wired'] = '1';
  banner.addEventListener('click', () => { openPluginsSettings(); });
  banner.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openPluginsSettings();
    }
  });
}

/** Fetch the per-plugin conflict summary and show/update or hide the banner.
 *  Best-effort — a failed fetch leaves the banner as-is. */
export async function refreshSyncConflictBanner(): Promise<void> {
  const banner = byIdOrNull('sync-conflict-banner');
  if (banner === null) return;

  let summary: SyncConflictSummaryEntry[];
  try {
    summary = await getSyncConflictsSummary();
  } catch {
    return; // transient — keep the current banner state
  }

  const total = summary.reduce((n, s) => n + s.count, 0);
  if (total === 0) {
    banner.style.display = 'none';
    return;
  }

  wireBanner(banner);

  const label = byIdOrNull('sync-conflict-banner-label');
  if (label !== null) label.textContent = formatConflictBannerLabel(summary);

  const countEl = byIdOrNull('sync-conflict-banner-count');
  if (countEl !== null) countEl.textContent = total > 99 ? '99+' : String(total);

  // Icon: the plugin with the most conflicts (summary is sorted desc server-side)
  // that actually has an icon.
  const iconEl = byIdOrNull('sync-conflict-banner-icon');
  if (iconEl !== null) {
    const icon = summary.find(s => s.icon != null && s.icon !== '')?.icon ?? null;
    if (icon != null) {
      // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- plugin-manifest SVG icon (trusted plugin data, bundled with the plugin).
      iconEl.replaceChildren(toElement(<span>{raw(icon)}</span>));
    } else {
      iconEl.replaceChildren();
    }
  }

  banner.style.display = 'flex';
}

/** Start the 1-minute polling loop (idempotent). Polls immediately, then on the
 *  interval, skipping ticks while the tab is hidden; refreshes on re-show. */
export function startSyncConflictBannerPolling(): void {
  if (pollTimer !== null) return;
  void refreshSyncConflictBanner();
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    void refreshSyncConflictBanner();
  }, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshSyncConflictBanner();
  });
}
