// HS-9330 (docs/114 §114.5.1, item 1) — the MAIN-SERVER permission relay for the ACP
// transport.
//
// The Claude channel holds pending permissions in the per-project CHANNEL-SERVER PROCESS
// (`channelPermissions.ts`); the main server proxies to it. ACP is different: `acpDrive`
// spawns `opencode acp` IN THE MAIN SERVER, and the agent's `session/request_permission`
// reaches `acpClient` in-process — there is no channel-server hop. So ACP permission
// requests are held HERE, in a main-server store, and surfaced to the browser through the
// SAME `/api/projects/permissions` long-poll the Claude popup already uses (keyed by
// project secret) — so ONE overlay serves both transports (the option-driven overlay,
// `permissionOptions.ts`).
//
// Flow: `acpDrive.requestPermission` → `injectAcpPermission(...)` returns a Promise that
// resolves when the user clicks an option in the overlay (`/channel/permission/respond`
// routes an ACP `request_id` to `resolveAcpPermission`) or dismisses it
// (`dismissAcpPermission`). The reply (`{ optionId } | { cancelled }`) is exactly the
// shape `acpClient`'s `requestPermission` callback returns. Injecting/resolving bumps the
// permission version + wakes the long-poll (`notifyPermission`) so the popup appears /
// clears promptly.
//
// Pure in-process state (a Map + a counter) so the store + resolver logic is
// unit-testable without spawning an agent or the HTTP server.

import { notifyPermission } from '../routes/notify.js';
import type { AcpPermissionOption } from './acpMapping.js';

/** The reply an overlay choice produces — mirrors `acpClient.ts::AcpPermissionReply`. */
export type AcpPermissionReply = { optionId: string } | { cancelled: true };

/** A pending ACP permission, surfaced to the browser via `/projects/permissions`. */
export interface AcpPendingPermission {
  request_id: string;
  /** Owning project secret — the poll response is keyed by it. */
  secret: string;
  tool_name: string;
  description: string;
  input_preview?: string;
  /** The agent-supplied options the overlay renders (`{ optionId, name, kind }`). */
  options: AcpPermissionOption[];
  timestamp: number;
}

interface Entry {
  pending: AcpPendingPermission;
  resolve: (reply: AcpPermissionReply) => void;
}

/** request_id → entry. */
const entries = new Map<string, Entry>();
let counter = 0;

export interface InjectAcpPermissionInput {
  secret: string;
  tool_name: string;
  description: string;
  input_preview?: string;
  options: AcpPermissionOption[];
}

/**
 * Register a pending ACP permission and return its `request_id` + a Promise that resolves
 * when the user responds (an option) or the request is dismissed/cancelled. Bumps the
 * permission version so the `/projects/permissions` long-poll surfaces it immediately.
 */
export function injectAcpPermission(input: InjectAcpPermissionInput, now: number = Date.now()): {
  request_id: string;
  promise: Promise<AcpPermissionReply>;
} {
  counter += 1;
  const request_id = `acp-perm-${String(counter)}`;
  const pending: AcpPendingPermission = {
    request_id,
    secret: input.secret,
    tool_name: input.tool_name,
    description: input.description,
    input_preview: input.input_preview,
    options: input.options,
    timestamp: now,
  };
  const promise = new Promise<AcpPermissionReply>((resolve) => {
    entries.set(request_id, { pending, resolve });
  });
  notifyPermission(); // wake the /projects/permissions long-poll so the popup appears
  return { request_id, promise };
}

/** True when `request_id` is an ACP-bridge request (vs a Claude-channel one). */
export function hasAcpPermission(request_id: string): boolean {
  return entries.has(request_id);
}

/**
 * The options a pending request was raised with, or null when the id isn't ours.
 *
 * HS-9586 — used by `/channel/permission/respond` to recover an `option_id` from
 * the binary `behavior` when a client sends one without the other. That combination
 * should not happen, but when it did the consequence was invisible and severe: the
 * route read the missing id as a dismissal, so "Allow" reached the agent as a
 * refusal with nothing logged. Recovering from the agent's OWN option list keeps
 * the fallback in the agent's vocabulary rather than guessing a literal.
 */
export function acpPermissionOptions(request_id: string): AcpPermissionOption[] | null {
  return entries.get(request_id)?.pending.options ?? null;
}

/**
 * Resolve a pending ACP permission with the chosen reply. Returns false when the
 * `request_id` isn't ours (the caller then falls through to the Claude-channel path).
 * Idempotent: a second resolve for the same id is a no-op false.
 */
export function resolveAcpPermission(request_id: string, reply: AcpPermissionReply): boolean {
  const entry = entries.get(request_id);
  if (entry === undefined) return false;
  entries.delete(request_id);
  notifyPermission(); // clear the popup on the next poll
  entry.resolve(reply);
  return true;
}

/** Dismiss a pending ACP permission (user closed the popup) → resolves as cancelled. */
export function dismissAcpPermission(request_id: string): boolean {
  return resolveAcpPermission(request_id, { cancelled: true });
}

/**
 * The oldest pending ACP permission for a project secret, or null. `/projects/permissions`
 * uses this to surface an ACP request through the same per-secret poll as the Claude one.
 */
export function pendingAcpPermissionForSecret(secret: string): AcpPendingPermission | null {
  for (const { pending } of entries.values()) {
    if (pending.secret === secret) return pending;
  }
  return null;
}

/** Test-only: current pending count. */
export function _acpPendingCountForTesting(): number {
  return entries.size;
}

/** Test-only: reset the store between tests. */
export function _resetAcpPermissionsForTesting(): void {
  entries.clear();
  counter = 0;
}
