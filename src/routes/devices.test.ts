/**
 * HS-9189 — HTTP surface for the active-device lease (the long-poll fallback to
 * the `/ws/sync` claim frame). Verifies the request contract + the Tier-1
 * cert-id-wins rule. The lease state machine itself is covered exhaustively in
 * `src/devices/activeDeviceLease.test.ts`.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClientIdentity } from '../auth/ca.js';
import { stopActiveDeviceLeaseSweep } from '../devices/activeDeviceLease.js';
import type { AppEnv } from '../types.js';
import { devicesRoutes } from './devices.js';

function makeApp(secret: string, clientIdentity: ClientIdentity | null = null) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('projectSecret', secret);
    c.set('clientIdentity', clientIdentity);
    await next();
  });
  app.route('/', devicesRoutes);
  return app;
}

const post = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

afterEach(() => { stopActiveDeviceLeaseSweep(); });

describe('POST /api/devices/active (HS-9189)', () => {
  it('claims the slot and returns the active holder', async () => {
    const app = makeApp('sec-claim');
    const res = await post(app, '/devices/active', { deviceId: 'dev-1' });
    expect(res.status).toBe(200);
    const body = await res.json() as { active: { deviceId: string; expiresAt: number } | null };
    expect(body.active?.deviceId).toBe('dev-1');
    expect(typeof body.active?.expiresAt).toBe('number');
  });

  it('rejects a body with no deviceId (400)', async () => {
    const app = makeApp('sec-bad');
    const res = await post(app, '/devices/active', {});
    expect(res.status).toBe(400);
  });

  it('GET reflects the current holder and DELETE-via-release frees it', async () => {
    const app = makeApp('sec-rt');
    await post(app, '/devices/active', { deviceId: 'dev-a' });
    let res = await app.request('/devices/active');
    expect((await res.json() as { active: { deviceId: string } | null }).active?.deviceId).toBe('dev-a');

    await post(app, '/devices/active/release', { deviceId: 'dev-a' });
    res = await app.request('/devices/active');
    expect((await res.json() as { active: unknown }).active).toBeNull();
  });

  it('on an exposed server the cert clientId wins over a spoofed body deviceId', async () => {
    const app = makeApp('sec-mtls', { clientId: 'cert-device', label: 'Laptop' });
    const res = await post(app, '/devices/active', { deviceId: 'spoofed' });
    const body = await res.json() as { active: { deviceId: string } | null };
    expect(body.active?.deviceId).toBe('cert-device'); // not 'spoofed'
  });

  it('a release by a non-holder does not free the current holder', async () => {
    const app = makeApp('sec-nh');
    await post(app, '/devices/active', { deviceId: 'holder' });
    await post(app, '/devices/active/release', { deviceId: 'someone-else' });
    const res = await app.request('/devices/active');
    expect((await res.json() as { active: { deviceId: string } | null }).active?.deviceId).toBe('holder');
  });
});
