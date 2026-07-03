// HS-9191 (docs/109-multi-client-terminals.md §109.6) — client controller for
// the active-device multi-client terminal model. Only ONE device per project is
// "active" and renders terminals live; every other device shows the §54
// borrowed-style "take control" placeholder (so there's one live renderer per
// PTY → one size → no resize thrash, the server gate HS-9190 backing it up).
//
// This module owns the CLIENT half:
//  - tracks the current active holder (from the `active-device-changed`
//    /ws/sync event + an initial `GET /api/devices/active`),
//  - decides whether THIS device is active (holder is us, or nobody holds it —
//    the single-device default), and pushes that to `terminalCheckout`'s
//    live↔placeholder gate,
//  - claims active on **sustained real interaction** (a keypress/pointer inside
//    the app, debounced — not a transient focus) and while we hold it, renews
//    the lease on a timer,
//  - exposes `takeControl()` for the placeholder button (immediate handoff).
//
// The lease is per-project (keyed by the project secret server-side); the client
// is connected to exactly one project's `/ws/sync` bus at a time, so the holder
// state tracked here is the active project's. `resync()` re-reads it on a
// project switch. Claims/renews/reads go through the typed `api/devices`
// callers, which target the active project via the injected transport.
//
// `createActiveDeviceController(deps)` is PURE + injected (timers, transport, the
// "am I active" sink) so the debounce / renew / event state machine is unit
// testable without a DOM or real network. The production instance + the global
// interaction listeners live at the bottom.

import { getOrCreateDeviceId } from './deviceId.js';

/** Debounce before a burst of interaction counts as a claim (docs §109.6:
 *  ~0.5–1 s; NOT a transient focus). */
export const INTERACTION_DEBOUNCE_MS = 750;
/** How often we renew the lease while we hold it (well inside the server's 15 s
 *  TTL, docs/109 §109.3). */
export const LEASE_RENEW_MS = 5_000;

export interface ActiveDeviceDeps {
  /** This device's stable id (localStorage UUID on Tier-0). */
  myDeviceId: string;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  setRenew: (fn: () => void, ms: number) => unknown;
  clearRenew: (t: unknown) => void;
  /** Claim/renew the active slot for the active project (fire-and-forget). */
  claim: (deviceId: string) => void;
  /** Release the active slot (fire-and-forget; no-op unless we hold it). */
  release: (deviceId: string) => void;
  /** Read the active project's current holder (null when free/unreachable). */
  fetchActive: () => Promise<string | null>;
  /** Push "is this device active?" to the terminal render gate. */
  onActiveChange: (active: boolean) => void;
}

export interface ActiveDeviceController {
  /** Whether this device currently renders terminals live. */
  isActive(): boolean;
  /** The current active holder's id (null when the slot is free). */
  holder(): string | null;
  /** Feed a real interaction (keypress/pointer) — debounced into a claim. */
  notifyInteraction(): void;
  /** Claim active immediately (the placeholder's "take control" button). */
  takeControl(): void;
  /** Apply an inbound `active-device-changed` event. */
  onActiveDeviceChanged(deviceId: string | null): void;
  /** Re-read the active project's holder (call on project switch). */
  resync(): Promise<void>;
  /** Release the lease if we hold it (e.g. on page unload) for an immediate
   *  handoff instead of waiting out the server TTL. */
  release(): void;
  /** Tear down timers + listeners. */
  stop(): void;
}

export function createActiveDeviceController(deps: ActiveDeviceDeps): ActiveDeviceController {
  let holderId: string | null = null;
  let debounceTimer: unknown = null;
  let renewTimer: unknown = null;

  // Active when we hold the lease, OR when nobody holds it (the single-device /
  // pre-contention default — mirrors the server resize gate's "no holder →
  // allow"). Only another device holding the lease flips us to placeholders.
  function computeActive(): boolean {
    return holderId === null || holderId === deps.myDeviceId;
  }

  let lastPushedActive = true;
  function pushActive(): void {
    const active = computeActive();
    if (active === lastPushedActive) return;
    lastPushedActive = active;
    deps.onActiveChange(active);
  }

  function startRenew(): void {
    if (renewTimer !== null) return;
    renewTimer = deps.setRenew(() => { deps.claim(deps.myDeviceId); }, LEASE_RENEW_MS);
  }
  function stopRenew(): void {
    if (renewTimer !== null) { deps.clearRenew(renewTimer); renewTimer = null; }
  }

  /** Update the holder + reconcile the renew loop and the render gate. */
  function setHolder(deviceId: string | null): void {
    holderId = deviceId;
    if (deviceId === deps.myDeviceId) startRenew(); // we hold it → keep it alive
    else stopRenew();                               // someone else / nobody → don't renew
    pushActive();
  }

  function claim(): void {
    // Optimistic: reflect the claim locally before the round-trip so the UI is
    // responsive; the broadcast confirms it (and flips other devices).
    setHolder(deps.myDeviceId);
    deps.claim(deps.myDeviceId);
  }

  return {
    isActive() { return computeActive(); },
    holder() { return holderId; },

    notifyInteraction() {
      if (debounceTimer !== null) return; // already counting down this burst
      debounceTimer = deps.setTimer(() => {
        debounceTimer = null;
        // Only claim if we don't already hold it — a held lease is kept alive by
        // the renew timer, so interacting while active is a no-op.
        if (holderId !== deps.myDeviceId) claim();
      }, INTERACTION_DEBOUNCE_MS);
    },

    takeControl() { claim(); },

    onActiveDeviceChanged(deviceId: string | null) { setHolder(deviceId); },

    async resync() {
      const current = await deps.fetchActive();
      setHolder(current);
    },

    release() {
      if (holderId !== deps.myDeviceId) return; // only the holder releases
      deps.release(deps.myDeviceId);
      setHolder(null);
    },

    stop() {
      if (debounceTimer !== null) { deps.clearTimer(debounceTimer); debounceTimer = null; }
      stopRenew();
    },
  };
}

// --- Production instance ----------------------------------------------------

let controller: ActiveDeviceController | null = null;

function fireClaim(deviceId: string): void {
  void import('../api/devices.js')
    .then(({ claimActiveDevice }) => claimActiveDevice({ deviceId }))
    .catch(() => { /* best-effort; the WS broadcast / next renew reconciles */ });
}
function fireRelease(deviceId: string): void {
  void import('../api/devices.js')
    .then(({ releaseActiveDevice }) => releaseActiveDevice({ deviceId }))
    .catch(() => { /* best-effort */ });
}
async function fetchActiveHolder(): Promise<string | null> {
  try {
    const { getActiveDevice } = await import('../api/devices.js');
    const resp = await getActiveDevice();
    return resp.active?.deviceId ?? null;
  } catch {
    return null;
  }
}

function pushDeviceActive(active: boolean): void {
  void import('./terminalCheckout.js').then(({ setDeviceActive }) => setDeviceActive(active));
}

/** Start the active-device controller: wire the terminal placeholder's "take
 *  control" button, install the global interaction listener, and read the
 *  active project's current holder. Called once at boot after `startWsSync()`. */
export function startActiveDevice(): void {
  if (controller !== null) return;
  const ctrl = createActiveDeviceController({
    myDeviceId: getOrCreateDeviceId(),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setRenew: (fn, ms) => setInterval(fn, ms),
    clearRenew: (t) => clearInterval(t as ReturnType<typeof setInterval>),
    claim: fireClaim,
    release: fireRelease,
    fetchActive: fetchActiveHolder,
    onActiveChange: pushDeviceActive,
  });
  controller = ctrl;

  // The placeholder button claims active here.
  void import('./terminalCheckout.js').then(({ setTakeControlHandler }) => {
    setTakeControlHandler(() => ctrl.takeControl());
  });

  // Sustained real interaction → debounced claim. keydown + pointerdown on the
  // document (capture) catch typing / clicking anywhere in the app; a transient
  // window.focus is deliberately NOT a trigger (docs §109.6).
  const onInteraction = (): void => ctrl.notifyInteraction();
  document.addEventListener('keydown', onInteraction, { capture: true });
  document.addEventListener('pointerdown', onInteraction, { capture: true });

  // Best-effort: hand the lease off immediately when this device goes away
  // (so another device flips to live without waiting out the 15 s TTL). The
  // periodic server sweep is the backstop if this doesn't fire.
  window.addEventListener('pagehide', () => ctrl.release());

  void ctrl.resync();
}

/** Apply an inbound `active-device-changed` /ws/sync event (called by wsSync). */
export function onActiveDeviceChangedEvent(deviceId: string | null): void {
  controller?.onActiveDeviceChanged(deviceId);
}

/** Re-read the active project's holder — call on a project switch. */
export function resyncActiveDevice(): void {
  void controller?.resync();
}
