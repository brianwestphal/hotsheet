/**
 * HS-8631 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * Claude-channel endpoints (`src/routes/channel.ts`). The permission /
 * bell-state long-polls keep their long-poll semantics server-side; the typed
 * caller just wraps the request.
 *
 * Endpoints (client-facing):
 *   - `GET  /channel/claude-check`         → ClaudeVersionCheck
 *   - `GET  /channel/status`               → ChannelStatus
 *   - `POST /channel/trigger`              → ok (body: message?)
 *   - `GET  /channel/permission`           → PendingPermission (long-poll)
 *   - `POST /channel/permission/respond`   → PermissionResultBody (body: PermissionRespondReq)
 *   - `POST /channel/permission/dismiss`   → ok
 *   - `POST /channel/done`                 → ok
 *   - `POST /channel/enable`               → ok
 *   - `POST /channel/disable`              → ok
 *   - `GET  /channel/heartbeat-status`     → heartbeat updates
 *
 * `/channel/notify`, `/channel/permission/notify`, and `/channel/heartbeat`
 * are server-to-server (the channel server + Claude hooks call them), not part
 * of the client contract. The client's permission long-poll actually runs
 * against `/projects/permissions` (projects domain) — `/channel/permission`
 * is wrapped here for completeness but has no client call site today.
 *
 * Reuses the existing `PendingPermissionSchema` / `PermissionResultBodySchema`
 * (`src/schemas.ts`) + the `ChannelTriggerSchema` / `PermissionRespondSchema`
 * request schemas (`src/routes/validation.ts`).
 */
import { z } from 'zod';

import type { ChannelTriggerSchema, PermissionRespondSchema } from '../routes/validation.js';
import { PendingPermissionSchema, PermissionResultBodySchema } from '../schemas.js';
import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

/** `GET /channel/claude-check` — whether the `claude` CLI is installed + new enough. */
export const ClaudeVersionCheckSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  meetsMinimum: z.boolean(),
});
export type ClaudeVersionCheck = z.infer<typeof ClaudeVersionCheckSchema>;

/** `GET /channel/status` — channel enable/alive/version state for the active project. */
export const ChannelStatusSchema = z.object({
  enabled: z.boolean(),
  alive: z.boolean(),
  port: z.number().nullable(),
  done: z.boolean(),
  versionMismatch: z.boolean(),
  serverName: z.string(),
  aliveCount: z.number(),
});
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

/** `GET /channel/heartbeat-status` — drained per-project busy/idle updates. */
export const HeartbeatStatusSchema = z.object({
  updates: z.array(z.object({ secret: z.string(), state: z.string() })),
});
export type HeartbeatStatus = z.infer<typeof HeartbeatStatusSchema>;

export type ChannelTriggerReq = z.infer<typeof ChannelTriggerSchema>;
export type PermissionRespondReq = z.infer<typeof PermissionRespondSchema>;
export type PendingPermission = z.infer<typeof PendingPermissionSchema>;
export type PermissionResultBody = z.infer<typeof PermissionResultBodySchema>;

/** GET `/channel/claude-check`. */
export async function getClaudeVersionCheck(): Promise<ClaudeVersionCheck> {
  return apiCall(ClaudeVersionCheckSchema, '/channel/claude-check');
}

/** GET `/channel/status`. */
export async function getChannelStatus(): Promise<ChannelStatus> {
  return apiCall(ChannelStatusSchema, '/channel/status');
}

/** POST `/channel/trigger` → fire (or wake) the channel server for the active project. */
export async function triggerChannel(message?: string): Promise<OkResponse> {
  const body: ChannelTriggerReq = { message };
  return apiCall(OkResponseSchema, '/channel/trigger', { method: 'POST', body });
}

/** `POST /channel/cleanup-connections` → number of duplicate channel servers terminated (HS-8948). */
export const CleanupConnectionsRespSchema = z.object({ ok: z.literal(true), killed: z.number() });
export type CleanupConnectionsResp = z.infer<typeof CleanupConnectionsRespSchema>;

/** POST `/channel/cleanup-connections` → kill duplicate Claude connections (keep the leader). */
export async function cleanupChannelConnections(): Promise<CleanupConnectionsResp> {
  return apiCall(CleanupConnectionsRespSchema, '/channel/cleanup-connections', { method: 'POST' });
}

/** GET `/channel/permission` → the long-poll for a pending permission request. */
export async function pollChannelPermission(secret?: string): Promise<PendingPermission> {
  return apiCall(PendingPermissionSchema, '/channel/permission', { secret });
}

/** POST `/channel/permission/respond` → allow / deny a pending request. `secret`
 *  routes to the owning project (background popups answer cross-project). */
export async function respondChannelPermission(body: PermissionRespondReq, secret?: string): Promise<PermissionResultBody> {
  return apiCall(PermissionResultBodySchema, '/channel/permission/respond', { method: 'POST', body, secret });
}

/** POST `/channel/permission/dismiss`. */
export async function dismissChannelPermission(secret?: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/channel/permission/dismiss', { method: 'POST', secret });
}

/** POST `/channel/done` → signal the active project's channel work is idle. */
export async function signalChannelDone(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/channel/done', { method: 'POST' });
}

/** POST `/channel/enable` → turn the channel on for every project. */
export async function enableChannel(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/channel/enable', { method: 'POST' });
}

/** POST `/channel/disable` → turn the channel off for every project. */
export async function disableChannel(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/channel/disable', { method: 'POST' });
}

/** GET `/channel/heartbeat-status` → drain pending busy/idle updates. */
export async function getChannelHeartbeatStatus(): Promise<HeartbeatStatus> {
  return apiCall(HeartbeatStatusSchema, '/channel/heartbeat-status');
}
