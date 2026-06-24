/**
 * HS-8994 — enrolled-device registry round-trips through a temp
 * `auth-devices.json` under the data dir (real fs path; no keychain involved).
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addDevice, type EnrolledDevice, isRevoked, listDevices, revokeDevice } from './deviceRegistry.js';

function makeDevice(over: Partial<EnrolledDevice> = {}): EnrolledDevice {
  return {
    clientId: 'dev-1', label: 'Laptop', serial: 'AA', fingerprint: 'FP:1',
    enrolledAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
    revoked: false, ...over,
  };
}

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'hs-devreg-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('deviceRegistry', () => {
  it('returns [] when no registry file exists', () => {
    expect(listDevices(dataDir)).toEqual([]);
  });

  it('adds + lists devices and persists across reads', () => {
    addDevice(dataDir, makeDevice({ clientId: 'a' }));
    addDevice(dataDir, makeDevice({ clientId: 'b', label: 'Phone' }));
    const devices = listDevices(dataDir);
    expect(devices.map(d => d.clientId)).toEqual(['a', 'b']);
    expect(devices.find(d => d.clientId === 'b')?.label).toBe('Phone');
  });

  it('re-enrolling the same clientId replaces the prior entry (cert rotation)', () => {
    addDevice(dataDir, makeDevice({ clientId: 'a', serial: 'OLD' }));
    addDevice(dataDir, makeDevice({ clientId: 'a', serial: 'NEW' }));
    const devices = listDevices(dataDir);
    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe('NEW');
  });

  it('revokeDevice flips the flag + stamps revokedAt; unknown id → null', () => {
    addDevice(dataDir, makeDevice({ clientId: 'a' }));
    const updated = revokeDevice(dataDir, 'a', '2026-06-24T00:00:00.000Z');
    expect(updated?.revoked).toBe(true);
    expect(updated?.revokedAt).toBe('2026-06-24T00:00:00.000Z');
    expect(listDevices(dataDir)[0].revoked).toBe(true);
    expect(revokeDevice(dataDir, 'nope', '2026-06-24T00:00:00.000Z')).toBeNull();
  });

  it('isRevoked matches a revoked device by serial OR fingerprint, not an active one', () => {
    addDevice(dataDir, makeDevice({ clientId: 'a', serial: 'S1', fingerprint: 'F1' }));
    addDevice(dataDir, makeDevice({ clientId: 'b', serial: 'S2', fingerprint: 'F2' }));
    revokeDevice(dataDir, 'a', '2026-06-24T00:00:00.000Z');
    expect(isRevoked(dataDir, { serial: 'S1' })).toBe(true);
    expect(isRevoked(dataDir, { fingerprint: 'F1' })).toBe(true);
    expect(isRevoked(dataDir, { serial: 'S2' })).toBe(false); // active
    expect(isRevoked(dataDir, { serial: 'unknown' })).toBe(false);
  });
});
