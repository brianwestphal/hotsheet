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

import type { ChannelTriggerSchema, ChannelTriggerTarget, PermissionRespondSchema } from '../routes/validation.js';
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

/** `GET /channel/heartbeat-status` — per-project busy/idle updates since the
 *  client's cursor (HS-9261). `seq` is the latest server cursor; the client
 *  passes it back as `?since` next poll so each client drains independently
 *  (non-destructive ring — fixes the multi-tab stuck-on drain race). */
export const HeartbeatStatusSchema = z.object({
  updates: z.array(z.object({ secret: z.string(), state: z.string(), seq: z.number() })),
  seq: z.number(),
});
export type HeartbeatStatus = z.infer<typeof HeartbeatStatusSchema>;

export type ChannelTriggerReq = z.infer<typeof ChannelTriggerSchema>;
/** HS-9084 — a channel-trigger routing target (main / a worker / all workers).
 *  Re-exported from the wire schema so client callers + the picker share it. */
export type { ChannelTriggerTarget };
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

/** POST `/channel/trigger` → fire (or wake) the channel server for the active
 *  project. HS-9084 — pass `target` to route to a specific worker / all workers;
 *  omit it for the FIFO-leader default (the play-button / worklist path). */
export async function triggerChannel(message?: string, target?: ChannelTriggerTarget): Promise<OkResponse> {
  const body: ChannelTriggerReq = { message, target };
  return apiCall(OkResponseSchema, '/channel/trigger', { method: 'POST', body });
}

/** `POST /channel/cleanup-connections` → number of MAIN channel servers disconnected (HS-8948 / HS-9225). */
export const CleanupConnectionsRespSchema = z.object({ ok: z.literal(true), killed: z.number() });
export type CleanupConnectionsResp = z.infer<typeof CleanupConnectionsRespSchema>;

/** POST `/channel/cleanup-connections` → disconnect ALL main Claude connections (HS-9225 — the
 *  user then reconnects the instance they want via `/mcp`). Workers are spared. */
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

/** GET `/channel/heartbeat-status` → busy/idle updates after the client's `since`
 *  cursor (HS-9261). Omit `since` on the first poll to sync the cursor without
 *  replaying history. */
export async function getChannelHeartbeatStatus(since?: number): Promise<HeartbeatStatus> {
  const q = since !== undefined ? `?since=${String(since)}` : '';
  return apiCall(HeartbeatStatusSchema, `/channel/heartbeat-status${q}`);
}
