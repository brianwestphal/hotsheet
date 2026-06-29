// HS-9189 (docs/109-multi-client-terminals.md §109.3/§109.5) — HTTP surface for
// the active-device lease, the long-poll fallback to the preferred `/ws/sync`
// `claim-active` control frame. Each route is project-scoped (the per-project
// secret resolves to `projectSecret` via the API auth middleware) and emits an
// `active-device-changed` event onto the §93 bus on a real change.

import { Hono } from 'hono';

import { ActiveDeviceReqSchema } from '../api/devices.js';
import {
  claimActiveDevice,
  getActiveDevice,
  releaseActiveDevice,
} from '../devices/activeDeviceLease.js';
import type { AppEnv } from '../types.js';
import { parseBody } from './validation.js';

export const devicesRoutes = new Hono<AppEnv>();

/** Resolve the authoritative device id: the mTLS cert's `clientId` on an exposed
 *  server (so a request can't claim on another device's behalf), else the
 *  client-supplied synthetic id from the body. */
function resolveDeviceId(c: { get: (k: 'clientIdentity') => { clientId: string } | null }, bodyDeviceId: string): string {
  return c.get('clientIdentity')?.clientId ?? bodyDeviceId;
}

devicesRoutes.post('/devices/active', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ActiveDeviceReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const change = claimActiveDevice(c.get('projectSecret'), resolveDeviceId(c, parsed.data.deviceId));
  return c.json({ active: change.active });
});

devicesRoutes.post('/devices/active/release', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ActiveDeviceReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  releaseActiveDevice(c.get('projectSecret'), resolveDeviceId(c, parsed.data.deviceId));
  return c.json({ active: getActiveDevice(c.get('projectSecret')) });
});

devicesRoutes.get('/devices/active', (c) => {
  return c.json({ active: getActiveDevice(c.get('projectSecret')) });
});
