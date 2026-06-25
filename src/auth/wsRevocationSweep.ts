/**
 * HS-9025 — periodic revocation re-check for long-lived WebSocket connections on
 * the exposed (Tier-1) mTLS listener (§94.4.1: "periodic re-check for long-lived
 * connections"). HS-8995 enforces authz + revocation on every `/api/*` HTTP
 * request, but the terminal WS and `/ws/sync` are authorized only at upgrade
 * time. If a device is revoked (or its cert expires) WHILE its socket is open,
 * nothing re-checks it — the socket would persist until it naturally closed.
 *
 * This module tracks each authenticated Tier-1 socket with its peer's stable
 * client id + cert expiry, and a single interval sweeps them every 30 s, closing
 * any whose device is now revoked/absent from the registry or whose cert has
 * expired. **Tier-0 (loopback) never registers a socket here — it's a no-op.**
 *
 * Revocation is "soon," not "instant," for an already-open socket; a 30 s cadence
 * is the deliberate trade per the ticket.
 */
import type { WebSocket } from 'ws';

import { getDevice } from './deviceRegistry.js';

/** How often the sweep runs. Modest on purpose (see module doc). */
export const REVOCATION_SWEEP_INTERVAL_MS = 30_000;

interface TrackedSocket {
  ws: WebSocket;
  dataDir: string;
  clientId: string;
  /** Cert `notAfter` in epoch ms (Infinity if unknown — never expires it). */
  notAfterMs: number;
}

const tracked = new Set<TrackedSocket>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register an authenticated Tier-1 WebSocket for periodic revocation re-checks.
 * Auto-unregisters when the socket closes/errors. Starts the shared sweep timer
 * on first registration. Call ONLY for exposed (mTLS) connections.
 */
export function trackAuthenticatedSocket(ws: WebSocket, info: { dataDir: string; clientId: string; notAfterMs: number }): void {
  const entry: TrackedSocket = { ws, dataDir: info.dataDir, clientId: info.clientId, notAfterMs: info.notAfterMs };
  tracked.add(entry);
  const remove = (): void => { tracked.delete(entry); };
  ws.on('close', remove);
  ws.on('error', remove);
  ensureSweepRunning();
}

/**
 * Re-check every tracked socket and close the ones whose device is revoked /
 * gone from the registry, or whose cert has expired. Returns how many were
 * closed. Exposed for tests + invoked by the interval. `now` is injectable.
 */
export function sweepRevokedSockets(now: number = Date.now()): number {
  let closed = 0;
  for (const entry of [...tracked]) {
    // Drop sockets that are already closing/closed.
    if (entry.ws.readyState === entry.ws.CLOSING || entry.ws.readyState === entry.ws.CLOSED) {
      tracked.delete(entry);
      continue;
    }
    const device = getDevice(entry.dataDir, entry.clientId);
    const revoked = device === null || device.revoked;
    const expired = entry.notAfterMs <= now;
    if (revoked || expired) {
      // 1008 = policy violation. The client treats this as "do not reconnect"
      // for the same credential; a re-enrolled device gets a fresh cert.
      try { entry.ws.close(1008, revoked ? 'device revoked' : 'certificate expired'); } catch { /* ignore */ }
      tracked.delete(entry);
      closed++;
    }
  }
  return closed;
}

/** Number of currently tracked sockets (tests/inspection). */
export function trackedSocketCount(): number {
  return tracked.size;
}

function ensureSweepRunning(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => { sweepRevokedSockets(); }, REVOCATION_SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for the sweep.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** Stop the timer and forget all tracked sockets. Tests + graceful shutdown. */
export function resetRevocationSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  tracked.clear();
}
