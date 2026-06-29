// HS-9189 (docs/109-multi-client-terminals.md §109.3/§109.5) — the active-device
// lease wire shapes + typed callers, defined ONCE here and shared by the server
// handler (`src/routes/devices.ts`, validates the request) and the client (the
// Phase 3 claim/renew/release callers). The preferred transport is the `/ws/sync`
// `claim-active` control frame; this HTTP surface is the long-poll fallback for
// clients not on a live socket.

import { z } from 'zod';

import { apiCall } from './_runner.js';

/** The active holder of a project's terminals, or null when the slot is free. */
export const ActiveDeviceSchema = z.object({
  deviceId: z.string(),
  /** Lease expiry, ms epoch. */
  expiresAt: z.number(),
}).nullable();
export type ActiveDevice = z.infer<typeof ActiveDeviceSchema>;

/** Claim/renew or release the active slot. On an exposed (mTLS) server the
 *  `deviceId` is ignored in favor of the client cert's `clientId`; on localhost
 *  the client supplies a stable synthetic id (a localStorage UUID). */
export const ActiveDeviceReqSchema = z.object({
  deviceId: z.string().min(1).max(200),
});
export type ActiveDeviceReq = z.infer<typeof ActiveDeviceReqSchema>;

export const ActiveDeviceRespSchema = z.object({ active: ActiveDeviceSchema });
export type ActiveDeviceResp = z.infer<typeof ActiveDeviceRespSchema>;

/** Claim/renew the active-device slot for the active project. */
export async function claimActiveDevice(req: ActiveDeviceReq): Promise<ActiveDeviceResp> {
  return apiCall(ActiveDeviceRespSchema, '/devices/active', { method: 'POST', body: req });
}

/** Release the active-device slot (no-op unless this device holds it). */
export async function releaseActiveDevice(req: ActiveDeviceReq): Promise<ActiveDeviceResp> {
  return apiCall(ActiveDeviceRespSchema, '/devices/active/release', { method: 'POST', body: req });
}

/** Read the current active device for the active project. */
export async function getActiveDevice(): Promise<ActiveDeviceResp> {
  return apiCall(ActiveDeviceRespSchema, '/devices/active');
}
