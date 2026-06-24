// HS-8864 — client-side claims store (docs/90 §90.8). Holds the set of
// currently-claimed tickets (from `GET /api/tickets/claims`) as reactive signals
// so the claimed-by chip (rows + detail) and the in-flight view update without
// manual refetch plumbing. A 5 s poll is the fallback; HS-8973 — when the
// `/ws/sync` bus is live (HS-7945), `src/client/wsSync.ts` calls `refreshClaims`
// on every pushed `claims-changed` event (emitted by the claim/release/renew
// routes), so the chip flips near-instantly instead of waiting up to 5 s.
import { type ClaimRow, getTicketClaims } from '../api/index.js';
import { computed, type ReadonlySignal, signal } from './reactive.js';

const claimsSignal = signal<readonly ClaimRow[]>([]);

/** Live claims, in lease order (soonest-to-expire first, as the API returns). */
export const claimsListSignal: ReadonlySignal<readonly ClaimRow[]> = computed(() => claimsSignal.value);

/** Claims keyed by ticket id — the chip's per-row lookup. */
export const claimsByTicketId: ReadonlySignal<ReadonlyMap<number, ClaimRow>> = computed(() => {
  const m = new Map<number, ClaimRow>();
  for (const c of claimsSignal.value) m.set(c.ticketId, c);
  return m;
});

/** A coarse clock that ticks while tracking is active, so lease countdowns
 *  re-render every second. Chips read it ONLY when they have a claim, so
 *  unclaimed rows don't re-fire on the tick. */
const nowSignal = signal<number>(Date.now());
export const nowTick: ReadonlySignal<number> = computed(() => nowSignal.value);

/** Replace the claim set (called by the poll; or by a future push handler). */
export function applyClaims(claims: readonly ClaimRow[]): void {
  claimsSignal.value = claims;
}

/** Fetch the current claims from the server and apply them. Best-effort —
 *  a transient failure just leaves the last-known set until the next poll. */
export async function refreshClaims(): Promise<void> {
  try {
    applyClaims(await getTicketClaims());
  } catch { /* keep the last-known claims; next poll retries */ }
}

const POLL_MS = 5000;
const TICK_MS = 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** Start polling claims + ticking the countdown clock. Idempotent. */
export function startClaimsTracking(): void {
  if (pollTimer === null) {
    void refreshClaims();
    pollTimer = setInterval(() => void refreshClaims(), POLL_MS);
  }
  if (tickTimer === null) {
    tickTimer = setInterval(() => { nowSignal.value = Date.now(); }, TICK_MS);
  }
}

/** Stop tracking (tests / teardown). */
export function stopClaimsTracking(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
}

/** Look up the claim for one ticket (non-reactive read). */
export function claimForTicket(id: number): ClaimRow | undefined {
  return claimsByTicketId.value.get(id);
}

/** **TEST ONLY** — set the claims + clock directly, bypassing the network. */
export function _setClaimsForTesting(claims: readonly ClaimRow[], now?: number): void {
  claimsSignal.value = claims;
  if (now !== undefined) nowSignal.value = now;
}
