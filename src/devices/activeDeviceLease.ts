// HS-9189 (docs/109-multi-client-terminals.md §109.3 + §109.5) — the server-side
// "active device" lease, Phase 1 of the active-device multi-client terminal
// model. Only ONE device per project is "active" at a time; the active device
// renders terminals live, every other connected device shows the §54 borrowed
// placeholder — so there's exactly one live renderer per PTY → one size → no
// resize thrash.
//
// Scoped **per project** (keyed by the project secret, matching the §93 bus key
// and the per-project trust boundary). This also fits the future multi-server
// client (each remote project HS-9193 mounts carries its own secret), so the
// lease key is naturally the (server, project) pair.
//
// The lease is a HEARTBEAT lease (mirrors the §54 checkout lease + the §80
// announcer live lease): a claim sets/refreshes a TTL; the client renews well
// inside it; on expiry — the active device slept / lost network / closed — the
// slot frees so another device can claim. Claims are **last-claim-wins** (a new
// device supersedes the current holder immediately).
//
// `createActiveDeviceLeases` is PURE + clock-injected (no I/O, no event-bus
// import) so the state machine is exhaustively unit-testable. The process
// singleton + the `claim/release` helpers that broadcast onto the §93 bus, and
// the periodic expiry sweep, live below it and DO touch the bus.

import { emitEvent } from '../sync/eventBus.js';

/** Default heartbeat TTL. The client renews every ~5 s (docs/109 §109.3), so a
 *  15 s window survives a missed renew or two before the slot frees. */
export const DEFAULT_ACTIVE_DEVICE_TTL_MS = 15_000;

/** How often the server sweeps for expired leases to broadcast the freed slot. */
export const ACTIVE_DEVICE_SWEEP_INTERVAL_MS = 5_000;

export interface ActiveDevice {
  /** The holder's device id (mTLS `clientId` on Tier-1, a localStorage UUID on
   *  Tier-0 — resolved by the caller; the lease just stores the string). */
  deviceId: string;
  /** Lease expiry, ms epoch. */
  expiresAt: number;
}

export interface LeaseChange {
  /** The active holder after the operation, or null when the slot is now free. */
  active: ActiveDevice | null;
  /** True when the EFFECTIVE active device changed (a supersede, a fresh claim
   *  after the slot was empty/expired, or a release that freed it) — i.e. a
   *  broadcast is warranted. A pure renew by the current holder is `false`. */
  changed: boolean;
}

export interface ActiveDeviceLeases {
  /** Claim or renew the active slot for `secret` as `deviceId`. Last-claim-wins:
   *  a different device supersedes the current holder. Refreshes the TTL. */
  claim(secret: string, deviceId: string, nowMs: number): LeaseChange;
  /** Release the slot IFF `deviceId` is the current holder (a stale releaser is
   *  a no-op, so a superseded device's late close can't free the new holder). */
  release(secret: string, deviceId: string, nowMs: number): LeaseChange;
  /** The current holder for `secret`, or null when free/expired (lazy expiry). */
  getActive(secret: string, nowMs: number): ActiveDevice | null;
  /** Drop every holder whose lease has expired at or before `nowMs`; returns the
   *  secrets whose slot just became free (for the caller to broadcast). */
  sweepExpired(nowMs: number): string[];
}

export function createActiveDeviceLeases(ttlMs: number = DEFAULT_ACTIVE_DEVICE_TTL_MS): ActiveDeviceLeases {
  if (ttlMs <= 0) throw new Error(`active-device lease ttl must be > 0, got ${ttlMs}`);
  const holders = new Map<string, ActiveDevice>();

  // Lazy expiry: reading a holder past its TTL clears it (so `getActive` and
  // `claim` agree on "free" without waiting for the periodic sweep).
  function currentActive(secret: string, nowMs: number): ActiveDevice | null {
    const h = holders.get(secret);
    if (h === undefined) return null;
    if (h.expiresAt <= nowMs) {
      holders.delete(secret);
      return null;
    }
    return h;
  }

  return {
    claim(secret, deviceId, nowMs) {
      const before = currentActive(secret, nowMs);
      const expiresAt = nowMs + ttlMs;
      holders.set(secret, { deviceId, expiresAt });
      // Changed when there was no live holder (fresh claim / after expiry) or it
      // was a different device (supersede). Same device + still-live = a renew.
      const changed = before === null || before.deviceId !== deviceId;
      return { active: { deviceId, expiresAt }, changed };
    },

    release(secret, deviceId, nowMs) {
      const before = currentActive(secret, nowMs);
      if (before !== null && before.deviceId === deviceId) {
        holders.delete(secret);
        return { active: null, changed: true };
      }
      return { active: before, changed: false };
    },

    getActive(secret, nowMs) {
      return currentActive(secret, nowMs);
    },

    sweepExpired(nowMs) {
      const freed: string[] = [];
      for (const [secret, h] of holders) {
        if (h.expiresAt <= nowMs) {
          holders.delete(secret);
          freed.push(secret);
        }
      }
      return freed;
    },
  };
}

// --- Process singleton + bus-broadcasting helpers ---------------------------

/** The process-wide active-device leases. The `/ws/sync` claim frame + the
 *  `POST /api/devices/active` route share this; tests construct their own via
 *  `createActiveDeviceLeases(ttl)` for isolation. */
export const activeDeviceLeases: ActiveDeviceLeases = createActiveDeviceLeases();

function broadcast(secret: string, active: ActiveDevice | null): void {
  emitEvent(secret, {
    type: 'active-device-changed',
    deviceId: active?.deviceId ?? null,
    expiresAt: active?.expiresAt ?? null,
  });
}

/** Claim/renew + broadcast on a real change. Returns the resulting lease change. */
export function claimActiveDevice(secret: string, deviceId: string, nowMs: number = Date.now()): LeaseChange {
  const change = activeDeviceLeases.claim(secret, deviceId, nowMs);
  if (change.changed) broadcast(secret, change.active);
  return change;
}

/** Release (only if `deviceId` is the holder) + broadcast on a real change. */
export function releaseActiveDevice(secret: string, deviceId: string, nowMs: number = Date.now()): LeaseChange {
  const change = activeDeviceLeases.release(secret, deviceId, nowMs);
  if (change.changed) broadcast(secret, change.active);
  return change;
}

/** The current active device for a project (null when free/expired). */
export function getActiveDevice(secret: string, nowMs: number = Date.now()): ActiveDevice | null {
  return activeDeviceLeases.getActive(secret, nowMs);
}

/** Sweep expired leases once and broadcast each freed slot (`deviceId: null`). */
export function sweepActiveDeviceLeasesOnce(nowMs: number = Date.now()): string[] {
  const freed = activeDeviceLeases.sweepExpired(nowMs);
  for (const secret of freed) broadcast(secret, null);
  return freed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic expiry sweep (idempotent, unref'd so it never holds the
 *  process open). Wired from server startup. */
export function startActiveDeviceLeaseSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => { sweepActiveDeviceLeasesOnce(); }, ACTIVE_DEVICE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** Stop the sweep (graceful shutdown / tests). */
export function stopActiveDeviceLeaseSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
