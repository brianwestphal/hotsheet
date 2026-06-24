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
 *  attachments / telemetry batches). Used when a single override is given. */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024; // 100 MiB

// HS-8990 — per-route-class body caps. The default is path-aware so a JSON
// mutation can't ship 100 MiB (only an attachment upload should), tightening the
// JSON surface while never regressing legit uploads / telemetry batches.
export const JSON_BODY_CAP_BYTES = 8 * 1024 * 1024;     // ticket/settings JSON
export const UPLOAD_BODY_CAP_BYTES = 100 * 1024 * 1024; // attachment multipart
export const OTLP_BODY_CAP_BYTES = 16 * 1024 * 1024;    // /v1/* telemetry ingest

/** Path → body cap. Attachment uploads get the large cap, OTLP ingest a moderate
 *  one, everything else the JSON cap. */
export function defaultBodyCap(path: string): number {
  if (path.includes('/attachments')) return UPLOAD_BODY_CAP_BYTES;
  if (path.startsWith('/v1/')) return OTLP_BODY_CAP_BYTES;
  return JSON_BODY_CAP_BYTES;
}

/** Default per-IP rate limit on an exposed server: 1200 requests / minute —
 *  far above any legit single-client cadence (the poll is ~1/s), well below a
 *  flood. */
export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 1200 };

export interface RequestGuardOptions {
  /** Server bound to a non-loopback address (rate limiting only applies then). */
  exposed: boolean;
  /** A single cap for every path (overrides `bodyCapForPath`). */
  maxBodyBytes?: number;
  /** Per-path body cap (defaults to `defaultBodyCap`). */
  bodyCapForPath?: (path: string) => number;
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
  const bodyCap: (path: string) => number = opts.maxBodyBytes !== undefined
    ? () => opts.maxBodyBytes as number
    : (opts.bodyCapForPath ?? defaultBodyCap);
  const limiter = createRateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
  const now = opts.now ?? ((): number => Date.now());

  return async (c, next) => {
    // (1) Body-size cap (per route class).
    const len = parseContentLength(c.req.header('content-length'));
    if (len !== null && len > bodyCap(c.req.path)) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    // (1b) Chunked-body gap (HS-8998). The Content-Length cap above can't
    // pre-check a `Transfer-Encoding: chunked` body (no declared length), so a
    // chunked request would slip past the byte cap. On an EXPOSED server, reject
    // chunked on the body-bearing routes the guard covers (`/api/*` + `/v1/*`)
    // with 411 Length Required — legit clients (browser fetch, Claude Code's
    // OTLP exporter, curl with a buffered body) all send Content-Length, so this
    // only trips a streaming/abusive caller. Loopback/Tier-0 is unaffected (the
    // trusted local case); the OTLP receiver additionally re-checks the actual
    // byte length post-read as defense-in-depth (see `routes/otel.ts`).
    if (opts.exposed) {
      const te = c.req.header('transfer-encoding');
      if (te !== undefined && te.toLowerCase().includes('chunked')) {
        return c.json({ error: 'Length required' }, 411);
      }
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
