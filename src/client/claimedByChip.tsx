// HS-8864 — claimed-by chip (docs/90 §90.8). The small "⚙ <worker> · 0:42" badge
// that surfaces, on a ticket row + the detail panel, which distributed worker
// currently holds a ticket and how fresh its lease is. Pure render + lease-state
// helpers here (no timers / no DOM lookups) so they're unit-testable; the live
// data + the per-second tick come from `claimsStore.ts`, and the wiring into rows
// / detail / the in-flight view consumes these.
import type { ClaimRow } from '../api/index.js';
import { toElement } from './dom.js';

/** Within this much of (or past) the lease deadline, the chip shows a `stale`
 *  state — the worker may have died and the ticket is about to be reclaimed
 *  (docs/90 §90.2.2). Comfortably below the 120 s default lease TTL. */
export const STALE_LEASE_MS = 30_000;

export type LeaseState = 'live' | 'stale';

/** Milliseconds until the lease expires (negative once past). */
export function leaseRemainingMs(leaseExpiresAt: string, now: number): number {
  return new Date(leaseExpiresAt).getTime() - now;
}

/** `stale` when the lease is within STALE_LEASE_MS of expiry or already past. */
export function leaseState(leaseExpiresAt: string, now: number): LeaseState {
  return leaseRemainingMs(leaseExpiresAt, now) <= STALE_LEASE_MS ? 'stale' : 'live';
}

/** Human countdown: `m:ss` while live, `expired` once past. */
export function formatLeaseCountdown(leaseExpiresAt: string, now: number): string {
  const ms = leaseRemainingMs(leaseExpiresAt, now);
  if (ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min)}:${sec.toString().padStart(2, '0')}`;
}

/** The label shown in the chip — the human-friendly `worker_label` if set, else
 *  the raw `claimed_by` identity. */
export function chipWorkerName(claim: ClaimRow): string {
  return claim.workerLabel != null && claim.workerLabel !== '' ? claim.workerLabel : claim.claimedBy;
}

/** Build the claimed-by chip element for a claim at clock time `now`. */
export function renderClaimedByChip(claim: ClaimRow, now: number): HTMLElement {
  const state = leaseState(claim.leaseExpiresAt, now);
  const name = chipWorkerName(claim);
  const countdown = formatLeaseCountdown(claim.leaseExpiresAt, now);
  const title = `Claimed by ${claim.claimedBy}${claim.workerLabel != null && claim.workerLabel !== '' ? ` (${claim.workerLabel})` : ''} — lease ${countdown}${state === 'stale' ? ' (stale — may be reclaimed)' : ''}`;
  return toElement(
    <span className={`claimed-by-chip claimed-by-chip-${state}`} title={title} data-worker={claim.claimedBy}>
      <span className="claimed-by-chip-gear" aria-hidden="true">{'⚙'}</span>
      <span className="claimed-by-chip-worker">{name}</span>
      <span className="claimed-by-chip-lease">{countdown}</span>
    </span>,
  );
}
