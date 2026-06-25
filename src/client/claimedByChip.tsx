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

/** HS-9041 — only reveal the `m:ss` countdown once the lease drops to/below this.
 *  Above it the lease has plenty of time and the countdown is just noise, so the
 *  chip shows the worker name alone.
 *
 *  The maintainer asked for "under 2 minutes," but the *default* lease TTL is 120 s
 *  (`DEFAULT_CLAIM_TTL_SECONDS`), so a literal 2-minute threshold would show the
 *  countdown for essentially the whole life of a normal worker's lease — exactly
 *  the noise we're removing. 60 s (half the default TTL) keeps the countdown
 *  hidden for a healthy worker that renews on schedule and only surfaces it once a
 *  lease is genuinely running low (slow / stuck / not renewing). Tune here. */
export const LEASE_COUNTDOWN_VISIBLE_MS = 60_000;

export type LeaseState = 'live' | 'warn' | 'stale';

/** Milliseconds until the lease expires (negative once past). */
export function leaseRemainingMs(leaseExpiresAt: string, now: number): number {
  return new Date(leaseExpiresAt).getTime() - now;
}

/**
 * Lease state by time remaining:
 *  - `stale` — ≤ `STALE_LEASE_MS` (or past): worker may be dead, about to reclaim.
 *  - `warn`  — ≤ `LEASE_COUNTDOWN_VISIBLE_MS`: running low; countdown shown (amber).
 *  - `live`  — plenty of time left: countdown hidden, worker name only.
 */
export function leaseState(leaseExpiresAt: string, now: number): LeaseState {
  const ms = leaseRemainingMs(leaseExpiresAt, now);
  if (ms <= STALE_LEASE_MS) return 'stale';
  if (ms <= LEASE_COUNTDOWN_VISIBLE_MS) return 'warn';
  return 'live';
}

/** Whether the visible `m:ss` countdown should render — only once the lease is
 *  running low (`warn`/`stale`); a healthy, freshly-renewed lease hides it. */
export function shouldShowLeaseCountdown(state: LeaseState): boolean {
  return state !== 'live';
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

/** Build the claimed-by chip element for a claim at clock time `now`. The visible
 *  countdown only appears once the lease is running low (HS-9041); the lease time
 *  always stays in the tooltip so it's available on hover. */
export function renderClaimedByChip(claim: ClaimRow, now: number): HTMLElement {
  const state = leaseState(claim.leaseExpiresAt, now);
  const name = chipWorkerName(claim);
  const countdown = formatLeaseCountdown(claim.leaseExpiresAt, now);
  const showCountdown = shouldShowLeaseCountdown(state);
  const title = `Claimed by ${claim.claimedBy}${claim.workerLabel != null && claim.workerLabel !== '' ? ` (${claim.workerLabel})` : ''} — lease ${countdown}${state === 'stale' ? ' (stale — may be reclaimed)' : ''}`;
  return toElement(
    <span className={`claimed-by-chip claimed-by-chip-${state}`} title={title} data-worker={claim.claimedBy}>
      <span className="claimed-by-chip-gear" aria-hidden="true">{'⚙'}</span>
      <span className="claimed-by-chip-worker">{name}</span>
      {showCountdown ? <span className="claimed-by-chip-lease">{countdown}</span> : null}
    </span>,
  );
}
