import { releaseTicket } from '../api/tickets.js';
import { showToast, type ShowToastOptions } from './toast.js';

/**
 * HS-9287 (docs/90 §90.2.2.1) — the shape of a 409 `claimed_by_other` body from
 * the write chokepoint (HS-9198 primary PATCH + HS-9204 secondary routes). A
 * single-ticket route carries `claimedBy` / `workerLabel`; the batch route
 * carries a `conflicts` list.
 */
export interface ClaimConflictInfo {
  claimedBy?: string;
  workerLabel?: string | null;
  conflicts?: { id: number; claimed_by: string; worker_label: string | null }[];
}

/**
 * HS-9287 — surface a claim conflict as a clean toast instead of the generic
 * Connection-Error overlay. A single-ticket conflict offers a **Force-release**
 * action (the owner takes the worker's claim, then re-does the edit); a batch
 * conflict lists how many targets are held (resolve them in the worker-pool UI).
 * Called from the api transport (`api.tsx`) on a 409 `claimed_by_other`.
 */
export function showClaimConflictToast(info: ClaimConflictInfo, ticketId: number | null): void {
  const conflicts = info.conflicts ?? [];
  if (conflicts.length > 0) {
    const held = [...new Set(conflicts.map(c => c.worker_label ?? c.claimed_by))];
    showToast(
      `${String(conflicts.length)} ticket${conflicts.length === 1 ? '' : 's'} held by ${held.join(', ')} — release or exclude them, then retry.`,
      { variant: 'warning', durationMs: 6000 },
    );
    return;
  }
  const who = info.workerLabel ?? info.claimedBy ?? 'another worker';
  const opts: ShowToastOptions = { variant: 'warning', durationMs: 6000 };
  if (ticketId !== null) {
    opts.action = { label: 'Force-release', onClick: () => { void forceRelease(ticketId); } };
  }
  showToast(`Held by ${who} — force-release to take it.`, opts);
}

/** Force-release the live claim (no `worker` arg → owner override), then prompt a
 *  retry. The release route emits a `claims-changed` sync, so the claimed-by chip
 *  / pool UI refresh on their own. */
async function forceRelease(ticketId: number): Promise<void> {
  try {
    await releaseTicket(ticketId);
    showToast('Released — retry your edit.', { variant: 'success' });
  } catch {
    showToast('Could not force-release the claim.', { variant: 'warning' });
  }
}
