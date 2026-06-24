// HS-7940 — the `/api/*` access-control decision for requests that carry NO
// usable `X-Hotsheet-Secret` header (docs/46-service-client-decoupling.md §46.5).
// Extracted as a pure function so the full access matrix is unit-testable
// without spinning a server (`src/routes/server.auth.test.ts`). The middleware
// in `src/server.ts` handles the header-present cases (exact-match / foreign
// project lookup) and delegates the header-absent cases here.

import { isLoopbackAddress, isRequestTrusted } from '../trusted-origin.js';

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface NoSecretAccessInput {
  method: string;
  origin: string | undefined;
  referer: string | undefined;
  /** Is the server bound to a non-loopback address (reachable off-box)? */
  exposed: boolean;
  trustedOrigins: string[];
  /** HS-8995 — a verified, enrolled, non-revoked mTLS client cert authenticated
   *  this request (Tier-1). On the mTLS listener the cert IS the credential, so
   *  it grants access without the shared secret (which stays defense-in-depth). */
  clientAuthenticated?: boolean;
}

export type AccessDecision =
  | { allow: true }
  | { allow: false; status: 403; reason: string };

/**
 * Decide access for a no-secret request, assuming a project secret IS
 * configured (callers short-circuit when there's no secret to enforce).
 *
 * - **Mutations** (POST/PATCH/PUT/DELETE): allowed only from a trusted
 *   same-origin browser — the CSRF guard. localhost is always trusted; a remote
 *   origin must be in `trustedOrigins`. Otherwise 403 (this is unchanged in
 *   spirit from the old inline localhost regex, just origin-list-aware).
 * - **Reads** (GET/HEAD/…): open by default so the single-machine browser can
 *   poll without a secret. Once the server is **exposed** (`--bind`
 *   non-localhost), an untrusted or origin-less read must carry the secret —
 *   this is the HS-7940 lockdown that stops a remote peer from reading tickets
 *   (and OAuth-bearing plugin settings) off an exposed instance.
 */
export function evaluateNoSecretApiAccess(input: NoSecretAccessInput): AccessDecision {
  const { method, origin, referer, exposed, trustedOrigins } = input;
  // HS-8995 — a verified mTLS client cert is the credential on Tier-1: a
  // cert-authenticated request is trusted regardless of origin/secret.
  const trusted = input.clientAuthenticated === true || isRequestTrusted(origin, referer, trustedOrigins);

  if (MUTATION_METHODS.has(method)) {
    return trusted
      ? { allow: true }
      : { allow: false, status: 403, reason: 'mutation-untrusted-no-secret' };
  }

  if (exposed && !trusted) {
    return { allow: false, status: 403, reason: 'get-exposed-untrusted-no-secret' };
  }
  return { allow: true };
}

export interface OtelAccessInput {
  exposed: boolean;
  /** Raw socket peer address (from the connection info). */
  remoteAddress: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
  trustedOrigins: string[];
  /** True when the request carries a secret that resolves to a project. */
  hasSecret: boolean;
}

/**
 * HS-8983 — access decision for the OTLP receiver (`/v1/*`). These routes sit
 * OUTSIDE the `/api/*` auth middleware because Claude Code's bundled exporter
 * can't send `X-Hotsheet-Secret`; their security model was "localhost bind". On
 * an **exposed** server (`--bind` non-loopback) that assumption is gone, so this
 * re-applies it: allow a loopback peer (the local exporter), a trusted origin,
 * or a request that does carry a valid secret; reject other remotes. On a
 * loopback-only bind it's open as before.
 */
export function evaluateOtelAccess(input: OtelAccessInput): AccessDecision {
  if (!input.exposed) return { allow: true };
  if (isLoopbackAddress(input.remoteAddress)) return { allow: true };
  if (isRequestTrusted(input.origin, input.referer, input.trustedOrigins)) return { allow: true };
  if (input.hasSecret) return { allow: true };
  return { allow: false, status: 403, reason: 'otel-exposed-untrusted' };
}
