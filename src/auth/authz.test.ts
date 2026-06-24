/**
 * HS-8995 — mTLS authz. The pure decision matrix (Tier-0 no-op; Tier-1 requires
 * an enrolled, non-revoked cert) + the middleware against a real registry
 * (`<dataDir>/auth-devices.json`).
 */
import { mkdtempSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '../types.js';
import { createMtlsAuthzMiddleware, evaluateClientAuthz } from './authz.js';
import type { ClientIdentity } from './ca.js';
import { addDevice, type EnrolledDevice } from './deviceRegistry.js';

const IDENT: ClientIdentity = { clientId: 'dev-1', label: 'Laptop' };

function device(over: Partial<EnrolledDevice> = {}): EnrolledDevice {
  return {
    clientId: 'dev-1', label: 'Laptop', serial: 'AA', fingerprint: 'FP',
    enrolledAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
    revoked: false, ...over,
  };
}

describe('evaluateClientAuthz', () => {
  it('Tier-0 (not exposed) is a no-op: allow, not cert-authenticated', () => {
    expect(evaluateClientAuthz({ exposed: false, clientIdentity: null, device: null }))
      .toEqual({ allow: true, authenticated: false });
  });

  it('Tier-1 rejects a cert-less peer', () => {
    expect(evaluateClientAuthz({ exposed: true, clientIdentity: null, device: null }))
      .toMatchObject({ allow: false, status: 403, reason: 'mtls-no-client-cert' });
  });

  it('Tier-1 rejects a verified-but-unenrolled cert', () => {
    expect(evaluateClientAuthz({ exposed: true, clientIdentity: IDENT, device: null }))
      .toMatchObject({ allow: false, status: 403, reason: 'mtls-unenrolled' });
  });

  it('Tier-1 rejects a revoked device', () => {
    expect(evaluateClientAuthz({ exposed: true, clientIdentity: IDENT, device: device({ revoked: true }) }))
      .toMatchObject({ allow: false, status: 403, reason: 'mtls-revoked' });
  });

  it('Tier-1 allows an enrolled, non-revoked device (authenticated)', () => {
    expect(evaluateClientAuthz({ exposed: true, clientIdentity: IDENT, device: device() }))
      .toEqual({ allow: true, authenticated: true });
  });
});

describe('createMtlsAuthzMiddleware', () => {
  let dataDir: string;
  let identity: ClientIdentity | null;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'hs-authz-')); identity = IDENT; });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  function makeApp(exposed: boolean): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('dataDir', dataDir);
      c.set('clientIdentity', identity);
      c.set('clientAuthenticated', false);
      await next();
    });
    app.use('/api/*', createMtlsAuthzMiddleware({ exposed }));
    app.get('/api/x', (c) => c.json({ authed: c.get('clientAuthenticated') }));
    return app;
  }

  it('Tier-0 passes through without marking authenticated', async () => {
    const res = await makeApp(false).request('/api/x');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authed: boolean }).authed).toBe(false);
  });

  it('Tier-1 allows an enrolled device + marks it authenticated', async () => {
    addDevice(dataDir, device());
    const res = await makeApp(true).request('/api/x');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authed: boolean }).authed).toBe(true);
  });

  it('Tier-1 403s a revoked device', async () => {
    addDevice(dataDir, device({ revoked: true }));
    expect((await makeApp(true).request('/api/x')).status).toBe(403);
  });

  it('Tier-1 403s an unenrolled cert', async () => {
    // no addDevice → not enrolled
    expect((await makeApp(true).request('/api/x')).status).toBe(403);
  });

  it('Tier-1 403s a cert-less peer', async () => {
    addDevice(dataDir, device());
    identity = null;
    expect((await makeApp(true).request('/api/x')).status).toBe(403);
  });
});
