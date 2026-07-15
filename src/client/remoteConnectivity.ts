// HS-9305 (docs/112 §112.8) — per-project connectivity state, driven off the §93
// `/ws/sync` reconnect in `wsSync.ts`. Today wsSync surfaces only a GLOBAL "live
// updates unavailable" hint; this attributes the connection state to the project
// it belongs to (keyed by secret) so a REMOTE project's tab can show a
// connected / reconnecting / unreachable indicator (feeds HS-9164's tab icon).
// A local project stays 'connected' (its server is in-process). An unreachable
// remote shows its last-known state read-only, not an error tab.

import { signal } from './reactive.js';

export type ConnectivityState = 'connected' | 'reconnecting' | 'unreachable' | 'unknown';

/** Per-secret connectivity. A reactive signal so a tab indicator re-renders on
 *  change; the map is replaced (new reference) on every set so `effect`s fire. */
const connectivitySignal = signal<Readonly<Record<string, ConnectivityState>>>({});

/** HS-9353 — mirror "is any project's `/ws/sync` live?" onto a window flag so e2e
 *  tests can deterministically wait for the live-refresh channel before driving an
 *  out-of-band change (previously a `waitForTimeout` settle raced the connect and
 *  the push was missed — flaked sidebar:117 / ui-gaps:174). Set here (the client
 *  wiring) rather than in the pure `wsSync.ts` so that module stays DOM-free. */
type WsConnectedFlag = { __hotsheetWsConnected?: boolean };
function publishWsConnectedFlag(map: Readonly<Record<string, ConnectivityState>>): void {
  if (typeof window === 'undefined') return;
  (window as Window & WsConnectedFlag).__hotsheetWsConnected =
    Object.values(map).some((s) => s === 'connected');
}

/** Set (and broadcast) the connectivity for `secret`. No-op when unchanged. */
export function setConnectivity(secret: string, state: ConnectivityState): void {
  if (secret === '') return;
  const cur = connectivitySignal.value;
  if (cur[secret] === state) return;
  const next = { ...cur, [secret]: state };
  connectivitySignal.value = next;
  publishWsConnectedFlag(next);
}

/** The connectivity for `secret` (`'unknown'` when never reported). */
export function getConnectivity(secret: string): ConnectivityState {
  return connectivitySignal.value[secret] ?? 'unknown';
}

/** The reactive signal (for a tab indicator `effect`). */
export function connectivity(): typeof connectivitySignal {
  return connectivitySignal;
}

/** TEST hook — clear all connectivity state. */
export function _resetConnectivityForTesting(): void {
  connectivitySignal.value = {};
  publishWsConnectedFlag({});
}
