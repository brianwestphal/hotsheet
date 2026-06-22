// HS-8791 — "how out of sync is this project" badge on plugin sync buttons.
//
// Periodically (every 5 min, only while the tab is visible) asks the server how
// many changes are pending in BOTH directions for each sync-capable plugin in
// the ACTIVE project, and renders the total as a small badge on that plugin's
// sync toolbar button. The badge is hidden when nothing is pending. Also
// refreshed right after a manual sync (which should drop it toward 0) and after
// the toolbar re-renders (which wipes the badge DOM).
import { getPluginPendingCount } from '../api/index.js';
import { toElement } from './dom.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, per the active tab
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Every rendered sync toolbar button (a plugin button whose action is "sync"). */
function syncButtons(): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  for (const el of document.querySelectorAll('.plugin-toolbar-btn[data-plugin-action="sync"]')) {
    if (el instanceof HTMLButtonElement) out.push(el);
  }
  return out;
}

function applyBadge(btn: HTMLButtonElement, total: number, toPull: number, toPush: number): void {
  const existing = btn.querySelector('.plugin-sync-badge');
  if (total <= 0) {
    if (existing) existing.remove();
    return;
  }
  const label = total > 99 ? '99+' : String(total);
  const title = `${total} change${total === 1 ? '' : 's'} to sync (${toPull} in, ${toPush} out)`;
  if (existing) {
    existing.textContent = label;
    existing.setAttribute('title', title);
  } else {
    btn.appendChild(toElement(<span className="plugin-sync-badge" title={title}>{label}</span>));
  }
}

/** Query the pending count for every sync button and update its badge. Best-effort
 *  per button — a failed fetch just leaves that badge unchanged. */
export async function refreshSyncBadges(): Promise<void> {
  const seen = new Set<string>();
  for (const btn of syncButtons()) {
    const pluginId = btn.getAttribute('data-plugin-id');
    if (pluginId == null || pluginId === '' || seen.has(pluginId)) continue;
    seen.add(pluginId);
    try {
      const counts = await getPluginPendingCount(pluginId);
      if (!counts.ok) { applyBadge(btn, 0, 0, 0); continue; }
      applyBadge(btn, counts.total, counts.toPull, counts.toPush);
    } catch {
      /* leave the existing badge as-is on a transient failure */
    }
  }
}

/** Start the 5-minute polling loop (idempotent). Polls immediately, then on the
 *  interval, skipping ticks while the tab is hidden; refreshes on re-show. */
export function startSyncBadgePolling(): void {
  if (pollTimer !== null) return;
  void refreshSyncBadges();
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    void refreshSyncBadges();
  }, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshSyncBadges();
  });
}
