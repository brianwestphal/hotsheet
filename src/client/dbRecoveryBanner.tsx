import { dismissRecovery, getRecoveryStatus } from '../api/index.js';
import { byIdOrNull } from './dom.js';
import { showToast } from './toast.js';

/** HS-7899: launch-time banner that appears when the server fell back
 *  to renaming the live `db/` aside as `db-corrupt-<ts>` and creating
 *  a fresh empty cluster. Without this, the user just sees an empty
 *  Hot Sheet with no idea anything went wrong. The banner offers two
 *  actions: open Settings → Backups (the existing restore flow) or
 *  dismiss the marker entirely. The marker is server-persisted so the
 *  prompt survives reload/restart until the user explicitly responds. */
export interface DbRecoveryMarker {
  corruptPath: string;
  recoveredAt: string;
  errorMessage: string;
  /** HS-8587 — set when the server auto-restored from a Snapshot Protection
   *  source (§73). Present ⇒ show a friendly toast instead of the blocking
   *  banner (there's nothing for the user to do). Absent ⇒ empty-recreate
   *  fallback, show the banner. */
  restoredFrom?: string;
  restoredTicketCount?: number;
}

/** Pure formatter — extracted so it can be unit-tested without DOM. */
export function formatRecoveryBannerLabel(marker: DbRecoveryMarker): string {
  const when = formatRelativeTime(marker.recoveredAt);
  const tail = marker.errorMessage !== ''
    ? ` (${truncate(marker.errorMessage, 120)})`
    : '';
  return `Database failed to load ${when} and was reset to empty${tail}. Restore from a backup to recover your tickets.`;
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 'recently';
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return 'moments ago';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** HS-8587 — pure formatter for the auto-restore success toast (the case
 *  where the server recovered the data on its own). Extracted for unit tests. */
export function formatRecoveryToastLabel(marker: DbRecoveryMarker): string {
  const when = formatRelativeTime(marker.recoveredAt);
  const source = marker.restoredFrom === 'snapshot' ? 'snapshot' : 'backup';
  const count = marker.restoredTicketCount;
  const ticketPart = typeof count === 'number' ? ` — ${count} ticket${count === 1 ? '' : 's'} restored` : '';
  return `Database was repaired ${when} from the latest ${source}${ticketPart}.`;
}

/** Fetch the recovery marker once at boot. If present, show the banner
 *  and wire its two action buttons. Idempotent — calling twice is
 *  harmless because re-fetching with no marker just hides the banner. */
export async function initDbRecoveryBanner(): Promise<void> {
  const banner = byIdOrNull('db-recovery-banner');
  const label = byIdOrNull('db-recovery-banner-label');
  const restoreBtn = byIdOrNull('db-recovery-restore-btn');
  const dismissBtn = byIdOrNull('db-recovery-dismiss-btn');
  if (banner === null || label === null || restoreBtn === null || dismissBtn === null) return;

  let marker: DbRecoveryMarker | null = null;
  try {
    marker = await getRecoveryStatus();
  } catch (err) {
    // Server may not be reachable yet on a very early boot path. Silently
    // skip — the banner is informational; failing to surface it is not a
    // user-facing error worth showing on top of every existing failure
    // surface.
    console.warn('Could not fetch DB recovery status:', err);
    return;
  }

  if (marker === null) {
    banner.style.display = 'none';
    return;
  }

  // HS-8587 — auto-restore case (§73): the server already recovered the data
  // from a snapshot / backup, so there's nothing for the user to act on.
  // Surface a non-blocking success toast, clear the marker so it doesn't
  // re-toast on the next boot, and leave the banner hidden. The blocking
  // banner below is reserved for the no-good-source empty-recreate case.
  if (marker.restoredFrom !== undefined && marker.restoredFrom !== '') {
    banner.style.display = 'none';
    showToast(formatRecoveryToastLabel(marker), { variant: 'success', durationMs: 8000 });
    void dismissRecovery().catch((err: unknown) => {
      console.warn('Could not clear DB recovery marker after auto-restore toast:', err);
    });
    return;
  }

  label.textContent = formatRecoveryBannerLabel(marker);
  banner.style.display = 'flex';

  restoreBtn.onclick = () => {
    // Open Settings (which loads the Backups list in the General tab)
    byIdOrNull('settings-btn')?.click();
  };

  dismissBtn.onclick = () => {
    void dismissRecoveryMarker(banner);
  };
}

async function dismissRecoveryMarker(banner: HTMLElement): Promise<void> {
  try {
    await dismissRecovery();
  } catch (err) {
    console.warn('Could not dismiss DB recovery marker:', err);
  }
  banner.style.display = 'none';
}
