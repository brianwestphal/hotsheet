// HS-9191 — unit coverage for the pure active-device controller (docs/109
// §109.6). Timers + transport + the "am I active" sink are injected, so the
// debounce / renew / event state machine is exercised without a DOM or network.
import { describe, expect, it, vi } from 'vitest';

import {
  type ActiveDeviceDeps,
  createActiveDeviceController,
  INTERACTION_DEBOUNCE_MS,
  LEASE_RENEW_MS,
} from './activeDevice.js';

const ME = 'device-me';
const OTHER = 'device-other';

/** A harness with manually-fired debounce + renew timers and recorded calls. */
function harness(overrides: Partial<ActiveDeviceDeps> = {}) {
  let debounceFn: (() => void) | null = null;
  let renewFn: (() => void) | null = null;
  const claim = vi.fn();
  const release = vi.fn();
  const onActiveChange = vi.fn();
  const fetchActive = overrides.fetchActive ?? vi.fn((): Promise<string | null> => Promise.resolve(null));
  const deps: ActiveDeviceDeps = {
    myDeviceId: ME,
    now: () => 0,
    setTimer: (fn) => { debounceFn = fn; return 1; },
    clearTimer: () => { debounceFn = null; },
    setRenew: (fn) => { renewFn = fn; return 2; },
    clearRenew: () => { renewFn = null; },
    claim,
    release,
    fetchActive,
    onActiveChange,
    ...overrides,
  };
  const ctrl = createActiveDeviceController(deps);
  return {
    ctrl, claim, release, onActiveChange, fetchActive,
    fireDebounce: () => { debounceFn?.(); },
    fireRenew: () => { renewFn?.(); },
    hasRenew: () => renewFn !== null,
    hasDebounce: () => debounceFn !== null,
  };
}

describe('createActiveDeviceController', () => {
  it('is active by default (no holder) and stays live', () => {
    const h = harness();
    expect(h.ctrl.isActive()).toBe(true);
    expect(h.ctrl.holder()).toBeNull();
    expect(h.onActiveChange).not.toHaveBeenCalled(); // no transition from the default
  });

  it('flips to non-active when another device claims the lease', () => {
    const h = harness();
    h.ctrl.onActiveDeviceChanged(OTHER);
    expect(h.ctrl.isActive()).toBe(false);
    expect(h.ctrl.holder()).toBe(OTHER);
    expect(h.onActiveChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.hasRenew()).toBe(false); // we don't renew a lease we don't hold
  });

  it('claims active on a sustained (debounced) interaction and starts renewing', () => {
    const h = harness();
    h.ctrl.onActiveDeviceChanged(OTHER); // start non-active
    h.onActiveChange.mockClear();

    h.ctrl.notifyInteraction();
    expect(h.claim).not.toHaveBeenCalled(); // not until the debounce fires
    h.fireDebounce();

    expect(h.claim).toHaveBeenCalledExactlyOnceWith(ME);
    expect(h.ctrl.isActive()).toBe(true);
    expect(h.onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.hasRenew()).toBe(true);
  });

  it('coalesces a burst of interactions into a single debounced claim', () => {
    const h = harness();
    h.ctrl.onActiveDeviceChanged(OTHER);
    h.ctrl.notifyInteraction();
    h.ctrl.notifyInteraction();
    h.ctrl.notifyInteraction();
    h.fireDebounce();
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it('renews the lease on the timer while we hold it', () => {
    const h = harness();
    h.ctrl.takeControl();            // claim immediately
    expect(h.claim).toHaveBeenCalledTimes(1);
    h.fireRenew();
    expect(h.claim).toHaveBeenCalledTimes(2); // renew re-claims
    h.fireRenew();
    expect(h.claim).toHaveBeenCalledTimes(3);
  });

  it('does not re-claim when interacting while already the active holder', () => {
    const h = harness();
    h.ctrl.takeControl(); // holder = me
    h.claim.mockClear();
    h.ctrl.notifyInteraction();
    h.fireDebounce();
    expect(h.claim).not.toHaveBeenCalled(); // already ours — the renew timer keeps it
  });

  it('take-control claims immediately (no debounce) — the placeholder button', () => {
    const h = harness();
    h.ctrl.onActiveDeviceChanged(OTHER);
    h.onActiveChange.mockClear();
    h.ctrl.takeControl();
    expect(h.claim).toHaveBeenCalledExactlyOnceWith(ME);
    expect(h.ctrl.isActive()).toBe(true);
    expect(h.onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('stops renewing and flips to placeholder when superseded after holding', () => {
    const h = harness();
    h.ctrl.takeControl();          // we hold it, renewing
    expect(h.hasRenew()).toBe(true);
    h.ctrl.onActiveDeviceChanged(OTHER); // superseded
    expect(h.hasRenew()).toBe(false);
    expect(h.ctrl.isActive()).toBe(false);
  });

  it('a freed slot (deviceId null) returns us to the live default', () => {
    const h = harness();
    h.ctrl.onActiveDeviceChanged(OTHER); // non-active
    h.onActiveChange.mockClear();
    h.ctrl.onActiveDeviceChanged(null);  // slot freed
    expect(h.ctrl.isActive()).toBe(true);
    expect(h.onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.hasRenew()).toBe(false); // free ≠ held
  });

  it('resync reads the current holder from the transport', async () => {
    const h = harness({ fetchActive: vi.fn((): Promise<string | null> => Promise.resolve(OTHER)) });
    await h.ctrl.resync();
    expect(h.ctrl.holder()).toBe(OTHER);
    expect(h.ctrl.isActive()).toBe(false);
  });

  it('only pushes onActiveChange on real transitions (deduped)', () => {
    const h = harness();
    h.ctrl.onActiveDeviceChanged(OTHER); // active→inactive: 1 call
    h.ctrl.onActiveDeviceChanged(OTHER); // still inactive: no call
    expect(h.onActiveChange).toHaveBeenCalledTimes(1);
  });

  it('release() frees the lease only when we hold it', () => {
    const h = harness();
    h.ctrl.release();                 // not the holder → no-op
    expect(h.release).not.toHaveBeenCalled();

    h.ctrl.takeControl();             // now we hold it
    h.ctrl.release();
    expect(h.release).toHaveBeenCalledExactlyOnceWith(ME);
    expect(h.ctrl.holder()).toBeNull();
    expect(h.hasRenew()).toBe(false); // stopped renewing after release
  });

  it('stop() clears pending debounce + renew timers', () => {
    const h = harness();
    h.ctrl.takeControl();
    h.ctrl.notifyInteraction();
    h.ctrl.stop();
    expect(h.hasRenew()).toBe(false);
    expect(h.hasDebounce()).toBe(false);
  });

  it('exposes sane timing constants', () => {
    expect(INTERACTION_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
    expect(INTERACTION_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
    expect(LEASE_RENEW_MS).toBeLessThan(15_000); // well inside the server TTL
  });
});
