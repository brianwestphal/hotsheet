/**
 * HS-8994 — mTLS client-cert enrollment endpoints (§94.4.2 Phase 1). Mounted at
 * `/api`. Wire shapes are the SSOT in `src/api/enrollment.ts`; cert ops live in
 * `src/auth/ca.ts`; the enrolled-device registry in `src/auth/deviceRegistry.ts`.
 *
 * **Credential creation is loopback-only.** Minting a `.p12` and signing a CSR
 * both produce a credential that authenticates to the (exposed) server, so they
 * must never be invokable by an untrusted remote — even one holding the shared
 * secret. The first device is always enrolled locally (bootstrapping); QR
 * pairing for remote devices is sub-ticket 5 (HS-8996). List + revoke are
 * ordinary `/api/*` calls (already behind the auth middleware).
 */
import { randomUUID } from 'crypto';
import { Hono } from 'hono';

import { MintDeviceReqSchema, SignCsrReqSchema } from '../api/enrollment.js';
import { exportClientP12, loadOrCreateProjectCa, readCertMeta, signClientCert, signClientCsr } from '../auth/ca.js';
import { addDevice, type EnrolledDevice, listDevices, revokeDevice } from '../auth/deviceRegistry.js';
import { isLoopbackAddress } from '../trusted-origin.js';
import type { AppEnv } from '../types.js';
import { parseBody } from './validation.js';

export const enrollmentRoutes = new Hono<AppEnv>();

/** True when the request peer is loopback (the only place credential creation is
 *  allowed). `@hono/node-server` exposes the peer on `c.env.incoming.socket`. */
function isLoopbackRequest(env: unknown): boolean {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return isLoopbackAddress(incoming?.socket?.remoteAddress);
}

/** Build an `EnrolledDevice` record from a freshly-signed cert. Returns null if
 *  the cert can't be parsed (shouldn't happen — we just minted it). */
function deviceFromCert(clientId: string, label: string, certPem: string, nowIso: string): EnrolledDevice | null {
  const meta = readCertMeta(certPem);
  if (meta === null) return null;
  return {
    clientId,
    label,
    serial: meta.serial,
    fingerprint: meta.fingerprint,
    enrolledAt: nowIso,
    expiresAt: meta.notAfter,
    revoked: false,
  };
}

function slugifyLabel(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'device' : slug;
}

// GET /api/auth/devices — list enrolled devices (metadata only).
enrollmentRoutes.get('/auth/devices', (c) => {
  return c.json({ devices: listDevices(c.get('dataDir')) });
});

// POST /api/auth/devices/mint — { label, password } → mint a CA-signed client
// cert, register it, and return the password-protected `.p12` (base64).
enrollmentRoutes.post('/auth/devices/mint', async (c) => {
  if (!isLoopbackRequest(c.env)) return c.json({ error: 'Enrollment is only allowed from localhost' }, 403);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = parseBody(MintDeviceReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const dataDir = c.get('dataDir');
  const ca = await loadOrCreateProjectCa(dataDir);
  const clientId = randomUUID();
  const { certPem, keyPem } = signClientCert(ca, { clientId, label: parsed.data.label });
  const device = deviceFromCert(clientId, parsed.data.label, certPem, new Date().toISOString());
  if (device === null) return c.json({ error: 'Failed to read minted certificate' }, 500);
  addDevice(dataDir, device);

  const p12 = exportClientP12({ certPem, keyPem, caCertPem: ca.caCertPem, password: parsed.data.password, friendlyName: parsed.data.label });
  return c.json({ device, p12Base64: p12.toString('base64'), filename: `hotsheet-${slugifyLabel(parsed.data.label)}.p12` });
});

// POST /api/auth/devices/sign-csr — { csrPem, label } → sign an externally-
// generated CSR (the device keeps its own private key). Loopback-only.
enrollmentRoutes.post('/auth/devices/sign-csr', async (c) => {
  if (!isLoopbackRequest(c.env)) return c.json({ error: 'CSR signing is only allowed from localhost' }, 403);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = parseBody(SignCsrReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const dataDir = c.get('dataDir');
  const ca = await loadOrCreateProjectCa(dataDir);
  const clientId = randomUUID();
  let certPem: string;
  try {
    certPem = signClientCsr(ca, parsed.data.csrPem, { clientId, label: parsed.data.label });
  } catch {
    return c.json({ error: 'Invalid CSR' }, 400);
  }
  const device = deviceFromCert(clientId, parsed.data.label, certPem, new Date().toISOString());
  if (device === null) return c.json({ error: 'Failed to read signed certificate' }, 500);
  addDevice(dataDir, device);
  return c.json({ device, certPem });
});

// POST /api/auth/devices/:clientId/revoke — flip a device to revoked (the data
// action; connect-time enforcement is sub-ticket 4 / HS-8995).
enrollmentRoutes.post('/auth/devices/:clientId/revoke', (c) => {
  const device = revokeDevice(c.get('dataDir'), c.req.param('clientId'), new Date().toISOString());
  if (device === null) return c.json({ error: 'Not found' }, 404);
  return c.json({ device });
});
