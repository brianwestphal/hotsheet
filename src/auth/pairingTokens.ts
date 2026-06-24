/**
 * HS-8996 — short-lived, single-use pairing tokens for QR enrollment (§94.4.2
 * Phase 2). The desktop shows a QR encoding `{token, url}`; the scanning device
 * generates a keypair + CSR and submits it WITH the token; the server validates
 * the token (consume-once, short TTL) and signs the cert via the sub-ticket-3
 * CSR path. The token authorizes a remote (phone) to enroll without the `.p12`
 * dance and without loopback — its single-use + short life is the gate.
 *
 * Tokens are **in-memory + per-project** (keyed by data dir): they're ephemeral
 * by design (a restart invalidating outstanding QRs is fine — re-show the QR),
 * so no persistence. The clock is injectable for tests.
 */
import { randomBytes } from 'crypto';

/** How long a freshly-issued pairing token is valid. Short on purpose — the user
 *  scans the QR within a minute or two; a stale token shouldn't linger. */
export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface TokenRecord {
  dataDir: string;
  expiresAt: number;
}

/** A pairing-token store. One module-level instance backs the routes; tests make
 *  their own with an injected clock. */
export class PairingTokenStore {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Issue a token bound to a project (data dir). Opportunistically prunes
   *  expired entries so the map can't grow unbounded. */
  issue(dataDir: string): { token: string; expiresAt: number } {
    this.pruneExpired();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + PAIRING_TOKEN_TTL_MS;
    this.tokens.set(token, { dataDir, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Consume a token: returns its bound data dir if the token is valid (exists +
   * unexpired), else null. **Single-use** — a valid token is removed so it can't
   * be replayed. An expired token is also removed and rejected.
   */
  consume(token: string): { dataDir: string } | null {
    const rec = this.tokens.get(token);
    if (rec === undefined) return null;
    this.tokens.delete(token); // single-use, whether valid or expired
    if (rec.expiresAt <= this.now()) return null;
    return { dataDir: rec.dataDir };
  }

  /** Test/inspection helper: number of live (unexpired) tokens. */
  size(): number {
    this.pruneExpired();
    return this.tokens.size;
  }

  private pruneExpired(): void {
    const t = this.now();
    for (const [token, rec] of this.tokens) {
      if (rec.expiresAt <= t) this.tokens.delete(token);
    }
  }
}

/** The process-wide pairing-token store used by the enrollment routes. */
export const pairingTokens = new PairingTokenStore();
