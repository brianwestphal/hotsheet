// HS-8986 — front-line request hardening applied BEFORE auth + handlers run, so
// egregiously-large payloads and floods are rejected cheaply (the user's
// directive: "pre-filter likely abusive content — too large, malformed — and
// validate every request before execution"). Two guards:
//
//   1. Body-size cap (413) — reject a request whose Content-Length exceeds a
//      generous global cap, before the handler buffers it. Generous on purpose
//      so legit attachments / OTLP batches never regress; the goal is to stop
//      the multi-GB memory-balloon, not to tightly bound every route (per-route
//      tightening is a follow-up).
//   2. Rate limit (429) — only on an EXPOSED server, and only for non-loopback
//      peers. Local dev, Claude's exporter, and the browser poll all arrive over
//      loopback and are never throttled; a remote flood is bounded per IP.
//
// Mounted on `/api/*` + `/v1/*` in `server.ts`, ahead of the auth middleware.

import type { MiddlewareHandler } from 'hono';

import { createRateLimiter } from '../rateLimiter.js';
import { isLoopbackAddress } from '../trusted-origin.js';
import type { AppEnv } from '../types.js';

/** Default global request-body cap: generous (blocks the egregious, not legit
 *  attachments / telemetry batches). Per-route tightening is a follow-up. */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Default per-IP rate limit on an exposed server: 1200 requests / minute —
 *  far above any legit single-client cadence (the poll is ~1/s), well below a
 *  flood. */
export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 1200 };

export interface RequestGuardOptions {
  /** Server bound to a non-loopback address (rate limiting only applies then). */
  exposed: boolean;
  maxBodyBytes?: number;
  rateLimit?: { windowMs: number; max: number };
  /** Test seam — override the clock. */
  now?: () => number;
}

/** Parse a `Content-Length` header into a non-negative integer, or null when
 *  absent/invalid (a chunked request has no Content-Length — the cap can't
 *  pre-check it; that streaming case is a documented follow-up). */
export function parseContentLength(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function createRequestGuards(opts: RequestGuardOptions): MiddlewareHandler<AppEnv> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limiter = createRateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
  const now = opts.now ?? ((): number => Date.now());

  return async (c, next) => {
    // (1) Body-size cap.
    const len = parseContentLength(c.req.header('content-length'));
    if (len !== null && len > maxBodyBytes) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    // (2) Rate limit — exposed + non-loopback only.
    if (opts.exposed) {
      // `@hono/node-server` provides `{ incoming }` as env in prod; it's absent
      // in the in-process test harness — default to {} so the access is safe.
      const env = (c.env ?? {}) as { incoming?: { socket?: { remoteAddress?: string } } };
      const addr = env.incoming?.socket?.remoteAddress;
      if (!isLoopbackAddress(addr)) {
        if (!limiter.tryConsume(addr ?? 'unknown', now())) {
          return c.json({ error: 'Too many requests' }, 429);
        }
      }
    }

    await next();
  };
}
