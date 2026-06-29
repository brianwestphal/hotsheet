/**
 * HS-9189 — unit coverage for the active-device lease (docs/109 §109.3/§109.5).
 * The pure `createActiveDeviceLeases` factory is exhaustively exercised
 * (clock-injected — no timers); the bus-broadcasting singleton helpers are
 * verified against a mocked event bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitEvent } from '../sync/eventBus.js';
import {
  claimActiveDevice,
  createActiveDeviceLeases,
  getActiveDevice,
  releaseActiveDevice,
  sweepActiveDeviceLeasesOnce,
} from './activeDeviceLease.js';

// vitest hoists `vi.mock` above the imports, so `activeDeviceLease` sees the
// mocked `emitEvent`; `vi.mocked` gives it the typed Mock surface.
vi.mock('../sync/eventBus.js', () => ({ emitEvent: vi.fn() }));
const emit = vi.mocked(emitEvent);

const TTL = 15_000;

describe('createActiveDeviceLeases — pure state machine', () => {
  it('rejects a non-positive ttl', () => {
    expect(() => createActiveDeviceLeases(0)).toThrow();
    expect(() => createActiveDeviceLeases(-1)).toThrow();
  });

  it('claim on an empty slot sets the holder + signals changed', () => {
    const l = createActiveDeviceLeases(TTL);
    const r = l.claim('sec', 'dev-a', 1000);
    expect(r.changed).toBe(true);
    expect(r.active).toEqual({ deviceId: 'dev-a', expiresAt: 1000 + TTL });
    expect(l.getActive('sec', 1000)).toEqual({ deviceId: 'dev-a', expiresAt: 1000 + TTL });
  });

  it('renew by the same device within the TTL refreshes expiry without signaling changed', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec', 'dev-a', 1000);
    const r = l.claim('sec', 'dev-a', 6000); // still inside the 15s window
    expect(r.changed).toBe(false);
    expect(r.active).toEqual({ deviceId: 'dev-a', expiresAt: 6000 + TTL });
  });

  it('a different device supersedes the holder (last-claim-wins) + signals changed', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec', 'dev-a', 1000);
    const r = l.claim('sec', 'dev-b', 2000);
    expect(r.changed).toBe(true);
    expect(r.active?.deviceId).toBe('dev-b');
    expect(l.getActive('sec', 2000)?.deviceId).toBe('dev-b');
  });

  it('getActive returns the holder within the TTL and null once expired (lazy)', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec', 'dev-a', 1000);
    expect(l.getActive('sec', 1000 + TTL - 1)?.deviceId).toBe('dev-a');
    expect(l.getActive('sec', 1000 + TTL)).toBeNull(); // expiresAt <= now → expired
  });

  it('re-claim by the same device after expiry signals changed (renew-after-expiry)', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec', 'dev-a', 1000);
    const r = l.claim('sec', 'dev-a', 1000 + TTL + 1); // slot lapsed, same device returns
    expect(r.changed).toBe(true);
    expect(r.active?.deviceId).toBe('dev-a');
  });

  it('release by the holder frees the slot + signals changed', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec', 'dev-a', 1000);
    const r = l.release('sec', 'dev-a', 2000);
    expect(r).toEqual({ active: null, changed: true });
    expect(l.getActive('sec', 2000)).toBeNull();
  });

  it('release by a NON-holder is a no-op (a superseded device can not free the new holder)', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec', 'dev-a', 1000);
    l.claim('sec', 'dev-b', 2000); // dev-b is now active
    const r = l.release('sec', 'dev-a', 3000); // dev-a (superseded) tries to release
    expect(r.changed).toBe(false);
    expect(r.active?.deviceId).toBe('dev-b');
    expect(l.getActive('sec', 3000)?.deviceId).toBe('dev-b'); // dev-b kept
  });

  it('release on a free slot is a no-op', () => {
    const l = createActiveDeviceLeases(TTL);
    const r = l.release('sec', 'dev-a', 1000);
    expect(r).toEqual({ active: null, changed: false });
  });

  it('leases are isolated per project secret', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('sec-a', 'dev-1', 1000);
    l.claim('sec-b', 'dev-2', 1000);
    expect(l.getActive('sec-a', 1000)?.deviceId).toBe('dev-1');
    expect(l.getActive('sec-b', 1000)?.deviceId).toBe('dev-2');
    l.release('sec-a', 'dev-1', 2000);
    expect(l.getActive('sec-a', 2000)).toBeNull();
    expect(l.getActive('sec-b', 2000)?.deviceId).toBe('dev-2'); // unaffected
  });

  it('sweepExpired returns + clears only the expired secrets', () => {
    const l = createActiveDeviceLeases(TTL);
    l.claim('old', 'dev-old', 1000);
    l.claim('fresh', 'dev-fresh', 9000);
    const freed = l.sweepExpired(1000 + TTL); // 'old' expired (16000), 'fresh' valid until 24000
    expect(freed).toEqual(['old']);
    expect(l.getActive('old', 1000 + TTL)).toBeNull();
    expect(l.getActive('fresh', 1000 + TTL)?.deviceId).toBe('dev-fresh');
  });
});

describe('singleton broadcast helpers (HS-9189)', () => {
  beforeEach(() => { emit.mockClear(); });
  afterEach(() => { emit.mockClear(); });

  it('claimActiveDevice broadcasts on a real change but not on a renew', () => {
    claimActiveDevice('bsec', 'dev-x', 1000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith('bsec', { type: 'active-device-changed', deviceId: 'dev-x', expiresAt: 1000 + TTL });

    emit.mockClear();
    claimActiveDevice('bsec', 'dev-x', 5000); // renew — no broadcast
    expect(emit).not.toHaveBeenCalled();

    claimActiveDevice('bsec', 'dev-y', 6000); // supersede — broadcast
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith('bsec', { type: 'active-device-changed', deviceId: 'dev-y', expiresAt: 6000 + TTL });
  });

  it('releaseActiveDevice broadcasts a freed slot (deviceId null)', () => {
    claimActiveDevice('rsec', 'dev-r', 1000);
    emit.mockClear();
    releaseActiveDevice('rsec', 'dev-r', 2000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith('rsec', { type: 'active-device-changed', deviceId: null, expiresAt: null });
    expect(getActiveDevice('rsec', 2000)).toBeNull();
  });

  it('sweepActiveDeviceLeasesOnce broadcasts each freed slot', () => {
    claimActiveDevice('ssec', 'dev-s', 1000);
    emit.mockClear();
    const freed = sweepActiveDeviceLeasesOnce(1000 + TTL + 1);
    expect(freed).toEqual(['ssec']);
    expect(emit).toHaveBeenCalledWith('ssec', { type: 'active-device-changed', deviceId: null, expiresAt: null });
  });
});
