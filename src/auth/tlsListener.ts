/**
 * HS-8993 — mTLS sub-ticket 2/6 (§94.4 + §94.4.3): the in-process TLS listener
 * plumbing for the **exposed (Tier-1) path only**. When the server is not on
 * localhost, `server.ts` stands up a Node HTTPS server that presents the
 * project CA's server cert AND requires a CA-signed client cert
 * (`requestCert: true` + `rejectUnauthorized: true`), so an unauthenticated
 * connection is rejected at the TLS layer before any handler runs.
 * **Loopback / Tier-0 never calls this — it stays plain HTTP + shared secret.**
 *
 * This module is the testable seam: cert-host selection + the `serve()` TLS
 * options + reading the verified peer identity off a live request socket. The
 * wiring (when to call it) lives in `server.ts`.
 */
import type { IncomingMessage } from 'http';
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from 'https';
import type { TLSSocket } from 'tls';

import { type ClientIdentity, loadOrCreateProjectCa, readIdentityFromPeerCertificate, signServerCert } from './ca.js';

/** `serve()`'s HTTPS plumbing — `@hono/node-server` accepts a `createServer` +
 *  `serverOptions` path (its `createHttpsOptions` overload). */
export interface MtlsServeConfig {
  createServer: typeof createHttpsServer;
  serverOptions: HttpsServerOptions;
}

function isWildcardBind(bind: string): boolean {
  return bind === '0.0.0.0' || bind === '::' || bind === '';
}

/**
 * Hosts to embed as SANs in the server cert so a client validating the cert
 * against the address it dialed succeeds. Loopback is always added by
 * `signServerCert`; here we add the concrete bind address (skipping a wildcard
 * bind, which is not a connectable address), any plain host/IP entry from
 * `trustedOrigins` (skipping CIDRs / origin URLs / the `tailscale` keyword), and
 * the explicit `tlsServerHosts` config. De-duplicated.
 */
export function collectServerCertHosts(bind: string, trustedOrigins: string[], tlsServerHosts: string[]): string[] {
  const hosts: string[] = [];
  if (!isWildcardBind(bind)) hosts.push(bind);
  for (const origin of trustedOrigins) {
    const h = origin.trim();
    if (h === '' || h === 'tailscale' || h.includes('/') || h.includes('://')) continue;
    hosts.push(h);
  }
  for (const h of tlsServerHosts) {
    const t = h.trim();
    if (t !== '') hosts.push(t);
  }
  return [...new Set(hosts)];
}

/**
 * Build the `serve()` TLS plumbing for the exposed path: an HTTPS server
 * presenting the project CA-signed server cert and requiring a CA-signed client
 * cert. Generates/loads the per-project CA on first use (keychain, sub-ticket 1)
 * — **throws if no durable keychain is available** (an mTLS deployment must not
 * silently fall back to plaintext or an ephemeral CA; see HS-9019).
 */
export async function buildMtlsServeConfig(dataDir: string, hosts: string[]): Promise<MtlsServeConfig> {
  const ca = await loadOrCreateProjectCa(dataDir);
  const server = signServerCert(ca, { hosts });
  return {
    createServer: createHttpsServer,
    serverOptions: {
      key: server.keyPem,
      cert: server.certPem,
      ca: [ca.caCertPem],
      requestCert: true,
      rejectUnauthorized: true,
    },
  };
}

/**
 * Read the verified client identity from a request's TLS socket. The Hono
 * node-server adapter exposes the Node IncomingMessage as the env's `incoming`;
 * on the mTLS listener its `.socket` is a `TLSSocket` whose peer cert was
 * already verified against the CA (the connection wouldn't exist otherwise).
 * Returns `null` on a plain-HTTP (Tier-0) connection, or a verified peer with no
 * Hot Sheet client URI. Never throws.
 */
export function peerIdentityFromEnv(env: unknown): ClientIdentity | null {
  if (env == null || typeof env !== 'object') return null;
  const incoming = (env as { incoming?: { socket?: unknown } }).incoming;
  const socket = incoming?.socket;
  if (socket == null || typeof socket !== 'object') return null;
  const getter = (socket as { getPeerCertificate?: unknown }).getPeerCertificate;
  if (typeof getter !== 'function') return null; // plain TCP socket — not TLS
  try {
    const cert = (socket as TLSSocket).getPeerCertificate();
    return readIdentityFromPeerCertificate(cert);
  } catch {
    return null;
  }
}

/** The verified peer's stable client id + cert expiry from a WebSocket upgrade
 *  request's TLS socket — what the HS-9025 revocation sweep needs to re-check a
 *  long-lived socket. Returns null on a plain-HTTP (Tier-0) upgrade or a verified
 *  peer with no Hot Sheet client URI. `notAfterMs` is the cert's `valid_to` in
 *  epoch ms (Infinity if unparseable, so the sweep never expires it spuriously). */
export function peerCertInfoFromRequest(req: IncomingMessage): { clientId: string; notAfterMs: number } | null {
  const socket: unknown = req.socket;
  if (socket == null || typeof socket !== 'object') return null;
  const getter = (socket as { getPeerCertificate?: unknown }).getPeerCertificate;
  if (typeof getter !== 'function') return null; // plain TCP socket — not TLS
  try {
    const cert = (socket as TLSSocket).getPeerCertificate();
    const identity = readIdentityFromPeerCertificate(cert);
    if (identity === null) return null;
    const parsed = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
    return { clientId: identity.clientId, notAfterMs: Number.isNaN(parsed) ? Infinity : parsed };
  } catch {
    return null;
  }
}
