import { Hono } from 'hono';

import { appendFreezeLog, type FreezeEntry } from '../diagnostics/freezeLogger.js';
import type { AppEnv } from '../types.js';

/**
 * HS-8054 v3 — diagnostic ingestion routes. The companion to
 * `src/diagnostics/freezeLogger.ts`. The client-side longTaskObserver
 * (HS-8054 v1/v2) POSTs to `/api/diagnostics/freeze` whenever it detects
 * a UI hang, and the server appends the entry to `<dataDir>/freeze.log`
 * so the user gets a single file with both client-side and server-side
 * hangs interleaved by timestamp — paste-ready for the next debugging
 * round-trip without needing DevTools open at the moment of the hang.
 *
 * Same-origin browser requests are accepted without `X-Hotsheet-Secret`
 * (the global API middleware in `src/server.ts` already covers same-
 * origin POSTs); cross-origin posts must include the project's secret
 * so a malicious external page can't spam the freeze log.
 */
export const diagnosticsRoutes = new Hono<AppEnv>();

diagnosticsRoutes.post('/diagnostics/freeze', async (c) => {
  const dataDir = c.get('dataDir');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const entry = coerceFreezeEntry(raw);
  if (entry === null) return c.json({ error: 'Invalid freeze entry shape' }, 400);
  await appendFreezeLog(dataDir, entry);
  return c.json({ ok: true });
});

/**
 * Pure: validate + normalise a client-supplied freeze entry. Rejects any
 * shape we don't recognize so a malformed payload can't poison freeze.log
 * with garbage. Caller-supplied `source` is constrained to the client
 * detector tags (`client-observer` / `client-heartbeat`) — server tags
 * are produced server-side only.
 *
 * Exported for the unit test.
 */
export function coerceFreezeEntry(raw: unknown): FreezeEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const source = r.source;
  if (source !== 'client-observer' && source !== 'client-heartbeat') return null;
  const durationMs = r.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const context = typeof r.context === 'string' ? r.context : '';
  const ts = typeof r.ts === 'string' && r.ts !== '' ? r.ts : new Date().toISOString();
  const clientWallClock = typeof r.clientWallClock === 'string' ? r.clientWallClock : undefined;
  const extra = r.extra !== null && typeof r.extra === 'object' && !Array.isArray(r.extra)
    ? (r.extra as Record<string, unknown>)
    : undefined;
  return { ts, source, durationMs: Math.round(durationMs), context, clientWallClock, extra };
}
