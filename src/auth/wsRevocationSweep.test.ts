/**
 * HS-9025 — the revocation sweep closes long-lived Tier-1 WS connections whose
 * device gets revoked (or whose cert expires) after the upgrade-time check.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { addDevice, type EnrolledDevice, revokeDevice } from './deviceRegistry.js';
import { resetRevocationSweep, sweepRevokedSockets, trackAuthenticatedSocket, trackedSocketCount } from './wsRevocationSweep.js';

/** Minimal `ws`-shaped stub: readyState + state constants + close + on(). */
class FakeWs {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  closed: { code: number; reason: string } | null = null;
  private handlers: Record<string, (() => void) | undefined> = {};
  on(ev: string, cb: () => void): this { this.handlers[ev] = cb; return this; }
  close(code: number, reason: string): void { this.closed = { code, reason }; this.readyState = this.CLOSING; }
  emit(ev: string): void { this.handlers[ev]?.(); }
}

function fakeWs(): FakeWs { return new FakeWs(); }
function asWs(w: FakeWs): WebSocket { return w as unknown as WebSocket; }

function device(clientId: string, overrides: Partial<EnrolledDevice> = {}): EnrolledDevice {
  return {
    clientId, label: clientId, serial: `serial-${clientId}`, fingerprint: `fp-${clientId}`,
    enrolledAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revoked: false, ...overrides,
  };
}

const FUTURE = Date.parse('2099-01-01T00:00:00.000Z');

describe('wsRevocationSweep (HS-9025)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hs-revsweep-')); resetRevocationSweep(); });
  afterEach(() => { resetRevocationSweep(); rmSync(dir, { recursive: true, force: true }); });

  it('closes a socket whose device is revoked mid-connection; leaves others open', () => {
    addDevice(dir, device('alice'));
    addDevice(dir, device('bob'));
    const a = fakeWs(); const b = fakeWs();
    trackAuthenticatedSocket(asWs(a), { dataDir: dir, clientId: 'alice', notAfterMs: FUTURE });
    trackAuthenticatedSocket(asWs(b), { dataDir: dir, clientId: 'bob', notAfterMs: FUTURE });
    expect(trackedSocketCount()).toBe(2);

    // Nothing revoked yet → sweep closes nothing.
    expect(sweepRevokedSockets()).toBe(0);
    expect(a.closed).toBeNull();

    // Revoke alice; next sweep closes only her socket.
    revokeDevice(dir, 'alice', new Date().toISOString());
    expect(sweepRevokedSockets()).toBe(1);
    expect(a.closed).toEqual({ code: 1008, reason: 'device revoked' });
    expect(b.closed).toBeNull();
    expect(trackedSocketCount()).toBe(1); // alice un-tracked after close
  });

  it('closes a socket whose cert has expired', () => {
    addDevice(dir, device('carol'));
    const c = fakeWs();
    const expired = Date.parse('2020-01-01T00:00:00.000Z');
    trackAuthenticatedSocket(asWs(c), { dataDir: dir, clientId: 'carol', notAfterMs: expired });
    expect(sweepRevokedSockets()).toBe(1);
    expect(c.closed).toEqual({ code: 1008, reason: 'certificate expired' });
  });

  it('closes a socket whose device vanished from the registry', () => {
    const d = fakeWs();
    trackAuthenticatedSocket(asWs(d), { dataDir: dir, clientId: 'ghost', notAfterMs: FUTURE });
    expect(sweepRevokedSockets()).toBe(1);
    expect(d.closed).toEqual({ code: 1008, reason: 'device revoked' });
  });

  it('auto-untracks a socket when it closes on its own', () => {
    addDevice(dir, device('dave'));
    const w = fakeWs();
    trackAuthenticatedSocket(asWs(w), { dataDir: dir, clientId: 'dave', notAfterMs: FUTURE });
    expect(trackedSocketCount()).toBe(1);
    w.emit('close');
    expect(trackedSocketCount()).toBe(0);
    expect(sweepRevokedSockets()).toBe(0);
  });

  it('is a no-op when nothing is tracked (Tier-0 never registers)', () => {
    expect(trackedSocketCount()).toBe(0);
    expect(sweepRevokedSockets()).toBe(0);
  });
});
