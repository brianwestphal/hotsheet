/**
 * HS-8994 — mTLS enrollment endpoints. Mint round-trips a `.p12` that re-imports
 * + verifies against the CA; the CSR endpoint signs a valid CSR and rejects a
 * non-loopback caller / a bad CSR; list + revoke behave. The CA is keychain-
 * backed via an in-memory keychain stub (no OS keychain touched).
 */
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { Hono } from 'hono';
import forge from 'node-forge';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

const store = new Map<string, string>();
vi.mock('../keychain.js', () => ({
  keychainSet: vi.fn((p: string, a: string, v: string) => { store.set(`${p}/${a}`, v); return Promise.resolve(true); }),
  keychainGet: vi.fn((p: string, a: string) => Promise.resolve(store.get(`${p}/${a}`) ?? null)),
  keychainDelete: vi.fn((p: string, a: string) => { store.delete(`${p}/${a}`); return Promise.resolve(true); }),
}));

const { enrollmentRoutes } = await import('./enrollment.js');
const { loadOrCreateProjectCa, readP12, verifyClientCert, readIdentity } = await import('../auth/ca.js');
const { listDevices } = await import('../auth/deviceRegistry.js');

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const REMOTE = { incoming: { socket: { remoteAddress: '203.0.113.9' } } };

let dataDir: string;
function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('dataDir', dataDir); c.set('clientIdentity', null); await next(); });
  app.route('/', enrollmentRoutes);
  return app;
}

/** A CSR signed by a fresh device keypair (the external-CSR enrollment path). */
function makeCsr(cn = 'device'): string {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(publicKey);
  csr.setSubject([{ name: 'commonName', value: cn }]);
  csr.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

beforeEach(() => { store.clear(); dataDir = mkdtempSync(join(tmpdir(), 'hs-enroll-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('POST /auth/devices/mint', () => {
  it('mints a .p12 that re-imports + verifies against the CA, and registers the device', async () => {
    const app = makeApp();
    const res = await app.request('/auth/devices/mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: "Brian's Laptop", password: 'hunter2' }),
    }, LOOPBACK);
    expect(res.status).toBe(200);
    const json = await res.json() as { device: { clientId: string; label: string; revoked: boolean }; p12Base64: string; filename: string };
    expect(json.device.label).toBe("Brian's Laptop");
    expect(json.device.revoked).toBe(false);
    expect(json.filename).toBe('hotsheet-brian-s-laptop.p12');

    // The .p12 re-imports with the password and the leaf identity is intact.
    const ca = await loadOrCreateProjectCa(dataDir);
    const back = readP12(Buffer.from(json.p12Base64, 'base64'), 'hunter2');
    expect(verifyClientCert(ca.caCertPem, back.certPem)).toBe(true);
    expect(readIdentity(back.certPem)).toEqual({ clientId: json.device.clientId, label: "Brian's Laptop" });

    // Device is in the registry.
    expect(listDevices(dataDir).map(d => d.clientId)).toEqual([json.device.clientId]);
  });

  it('rejects a non-loopback caller with 403', async () => {
    const app = makeApp();
    const res = await app.request('/auth/devices/mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x', password: 'pw' }),
    }, REMOTE);
    expect(res.status).toBe(403);
    expect(listDevices(dataDir)).toEqual([]); // nothing minted
  });

  it('rejects a malformed body with 400', async () => {
    const app = makeApp();
    const res = await app.request('/auth/devices/mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x' }), // no password
    }, LOOPBACK);
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/devices/sign-csr', () => {
  it('signs a valid CSR (loopback) with our identity + registers the device', async () => {
    const app = makeApp();
    const res = await app.request('/auth/devices/sign-csr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrPem: makeCsr('untrusted-cn'), label: 'iPhone' }),
    }, LOOPBACK);
    expect(res.status).toBe(200);
    const json = await res.json() as { device: { clientId: string }; certPem: string };
    const ca = await loadOrCreateProjectCa(dataDir);
    expect(verifyClientCert(ca.caCertPem, json.certPem)).toBe(true);
    expect(readIdentity(json.certPem)).toEqual({ clientId: json.device.clientId, label: 'iPhone' });
    expect(listDevices(dataDir)).toHaveLength(1);
  });

  it('rejects a non-loopback caller with 403', async () => {
    const app = makeApp();
    const res = await app.request('/auth/devices/sign-csr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrPem: makeCsr(), label: 'x' }),
    }, REMOTE);
    expect(res.status).toBe(403);
  });

  it('rejects a malformed CSR with 400', async () => {
    const app = makeApp();
    const res = await app.request('/auth/devices/sign-csr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrPem: 'not a csr', label: 'x' }),
    }, LOOPBACK);
    expect(res.status).toBe(400);
  });
});

describe('QR pairing (/auth/pair/*)', () => {
  async function startToken(app: Hono<AppEnv>): Promise<string> {
    const res = await app.request('/auth/pair/start', { method: 'POST' }, LOOPBACK);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  it('start is loopback-only (403 from a remote caller)', async () => {
    const app = makeApp();
    expect((await app.request('/auth/pair/start', { method: 'POST' }, REMOTE)).status).toBe(403);
  });

  it('complete signs a CSR with a valid token (from a REMOTE caller — token is the gate) + registers', async () => {
    const app = makeApp();
    const token = await startToken(app);
    const res = await app.request('/auth/pair/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, csrPem: makeCsr('phone'), label: 'Pixel' }),
    }, REMOTE);
    expect(res.status).toBe(200);
    const json = await res.json() as { device: { clientId: string }; certPem: string };
    const ca = await loadOrCreateProjectCa(dataDir);
    expect(verifyClientCert(ca.caCertPem, json.certPem)).toBe(true);
    expect(readIdentity(json.certPem)).toEqual({ clientId: json.device.clientId, label: 'Pixel' });
    expect(listDevices(dataDir).some(d => d.clientId === json.device.clientId)).toBe(true);
  });

  it('rejects a reused token (single-use) with 401', async () => {
    const app = makeApp();
    const token = await startToken(app);
    const body = JSON.stringify({ token, csrPem: makeCsr(), label: 'x' });
    expect((await app.request('/auth/pair/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, REMOTE)).status).toBe(200);
    // Second use of the same token is rejected.
    expect((await app.request('/auth/pair/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, csrPem: makeCsr(), label: 'x' }) }, REMOTE)).status).toBe(401);
  });

  it('rejects an unknown token with 401', async () => {
    const app = makeApp();
    const res = await app.request('/auth/pair/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bogus', csrPem: makeCsr(), label: 'x' }),
    }, REMOTE);
    expect(res.status).toBe(401);
  });

  it('rejects a bad CSR (with a valid token) with 400', async () => {
    const app = makeApp();
    const token = await startToken(app);
    const res = await app.request('/auth/pair/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, csrPem: 'not a csr', label: 'x' }),
    }, REMOTE);
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/devices + revoke', () => {
  it('lists devices and revokes one (404 for unknown)', async () => {
    const app = makeApp();
    const mint = await app.request('/auth/devices/mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Desktop', password: 'pw' }),
    }, LOOPBACK);
    const { device } = await mint.json() as { device: { clientId: string } };

    const list = await app.request('/auth/devices', {}, LOOPBACK);
    expect(((await list.json()) as { devices: unknown[] }).devices).toHaveLength(1);

    const revoke = await app.request(`/auth/devices/${device.clientId}/revoke`, { method: 'POST' }, LOOPBACK);
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { device: { revoked: boolean } }).device.revoked).toBe(true);

    const missing = await app.request('/auth/devices/nope/revoke', { method: 'POST' }, LOOPBACK);
    expect(missing.status).toBe(404);
  });
});
