// HS-7940 — the `/api/*` access-control decision for requests that carry NO
// usable `X-Hotsheet-Secret` header (docs/46-service-client-decoupling.md §46.5).
// Extracted as a pure function so the full access matrix is unit-testable
// without spinning a server (`src/routes/server.auth.test.ts`). The middleware
// in `src/server.ts` handles the header-present cases (exact-match / foreign
// project lookup) and delegates the header-absent cases here.

import { isRequestTrusted } from '../trusted-origin.js';

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface NoSecretAccessInput {
  method: string;
  origin: string | undefined;
  referer: string | undefined;
  /** Is the server bound to a non-loopback address (reachable off-box)? */
  exposed: boolean;
  trustedOrigins: string[];
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
  const trusted = isRequestTrusted(origin, referer, trustedOrigins);

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
