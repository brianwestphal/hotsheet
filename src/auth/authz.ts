/**
 * HS-8995 — mTLS sub-ticket 4/6 (§94.4.1 + §94.5): authorization for the
 * exposed (Tier-1) path. The mTLS listener (sub-ticket 2) already authenticates
 * the connection (a CA-signed client cert, else no connection); this turns that
 * verified identity into an access decision BEFORE any handler runs:
 *
 *   - the cert must map to an **enrolled** device (in the registry), and
 *   - that device must not be **revoked** (sub-ticket 3's registry flag).
 *
 * v1 authz is "enrolled + not revoked = full project access" — the seed of the
 * §88 per-project roles model (the `role` lookup grows here). On **Tier-0**
 * (loopback, not exposed) this is a no-op: the shared-secret path is unchanged.
 *
 * A passing decision marks the request `clientAuthenticated`, so the existing
 * HS-7940 secret/origin gate treats the cert as the credential (the shared
 * secret becomes defense-in-depth on Tier-1, not the gate — per §94.4.1).
 */
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types.js';
import type { ClientIdentity } from './ca.js';
import { type EnrolledDevice, getDevice } from './deviceRegistry.js';

export interface ClientAuthzInput {
  /** Server bound to a non-loopback address (mTLS engaged). */
  exposed: boolean;
  /** Verified peer identity from the TLS layer (null on a non-TLS connection). */
  clientIdentity: ClientIdentity | null;
  /** The enrolled-device record for that identity, or null if not enrolled. */
  device: EnrolledDevice | null;
}

export type AuthzDecision =
  | { allow: true; authenticated: boolean }
  | { allow: false; status: 403; reason: string };

/**
 * Pure authz decision. On Tier-0 (not exposed) → allow, not cert-authenticated
 * (defer to the shared-secret path). On Tier-1 (exposed) the connection is mTLS,
 * so require a verified identity that maps to an enrolled, non-revoked device.
 */
export function evaluateClientAuthz(input: ClientAuthzInput): AuthzDecision {
  if (!input.exposed) return { allow: true, authenticated: false };

  // Tier-1: the TLS layer should have rejected a cert-less peer already; this is
  // defense-in-depth if a non-TLS path ever reaches here.
  if (input.clientIdentity === null) {
    return { allow: false, status: 403, reason: 'mtls-no-client-cert' };
  }
  // A cert validly signed by our CA but never enrolled (e.g. an out-of-band
  // signing) is not authorized — v1 requires an explicit registry entry.
  if (input.device === null) {
    return { allow: false, status: 403, reason: 'mtls-unenrolled' };
  }
  if (input.device.revoked) {
    return { allow: false, status: 403, reason: 'mtls-revoked' };
  }
  // Enrolled + not revoked = full project access (v1; roles grow here).
  return { allow: true, authenticated: true };
}

/**
 * `/api/*` mTLS authz middleware. No-op on Tier-0. On Tier-1 it resolves the
 * peer identity → device → decision; a denial returns 403 before any handler, a
 * pass sets `clientAuthenticated` so the secret/origin gate trusts the cert.
 * Mounted AFTER the identity middleware (which sets `clientIdentity`) and BEFORE
 * `createApiAuthMiddleware`.
 */
export function createMtlsAuthzMiddleware({ exposed }: { exposed: boolean }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!exposed) { await next(); return; }
    const clientIdentity = c.get('clientIdentity');
    const device = clientIdentity !== null ? getDevice(c.get('dataDir'), clientIdentity.clientId) : null;
    const decision = evaluateClientAuthz({ exposed, clientIdentity, device });
    if (!decision.allow) return c.json({ error: 'Forbidden', reason: decision.reason }, decision.status);
    if (decision.authenticated) c.set('clientAuthenticated', true);
    await next();
  };
}
