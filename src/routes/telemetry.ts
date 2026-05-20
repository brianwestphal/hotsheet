import { Hono } from 'hono';

import { getDrawerPayload } from '../db/otelQueries.js';
import type { AppEnv } from '../types.js';

/**
 * HS-8148 — backend API for the footer drawer Telemetry tab (§67.10.2).
 *
 * `GET /api/telemetry/drawer?scope=project|all` returns a single
 * `DrawerPayload` with every section the drawer renders (today / week
 * / all-time totals, by-model + by-tool + by-query-source rollups,
 * recent prompts list). One round-trip per drawer refresh keeps the
 * poll cadence light.
 *
 * `scope=project` (default) — restrict to the active project's
 * `project_secret`. `scope=all` — drop the project filter (the
 * drawer's "all projects" toolbar toggle).
 *
 * Subject to the same `/api/*` middleware as other API routes:
 * `X-Hotsheet-Secret` header validation OR same-origin enforcement.
 * Read-only — `GET` only.
 */
export const telemetryRoutes = new Hono<AppEnv>();

telemetryRoutes.get('/telemetry/drawer', async (c) => {
  const scope = c.req.query('scope') ?? 'project';
  const projectSecret = scope === 'all' ? null : c.get('projectSecret');
  const payload = await getDrawerPayload(projectSecret);
  return c.json(payload);
});
