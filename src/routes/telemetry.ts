import { Hono } from 'hono';

import { getDrawerPayload, getPromptTimeline, getTodayCost, getTodayCostByProject } from '../db/otelQueries.js';
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

/**
 * HS-8147 — single-number "today's cost" for the per-project tab
 * cost chip. The chip polls this on the same cadence as the existing
 * tab-bell-state long-poll so the response shape stays tiny.
 *
 * Returns `{ cost: number }` — `0` when there's no telemetry yet for
 * this project. Chip is rendered only when cost is non-zero (HS-8147 §67.10.1).
 */
telemetryRoutes.get('/telemetry/today-cost', async (c) => {
  const projectSecret = c.get('projectSecret');
  const cost = await getTodayCost(projectSecret);
  return c.json({ cost });
});

/**
 * HS-8147 — bulk today-cost-by-project for the project-tab chips.
 * Returns `{ costs: {secret → number} }` for every project with
 * non-zero cost today. The chip rendering filters out zero-cost
 * projects naturally (the chip is hidden when the secret isn't a
 * key in the response). Polled on the bell-state cadence.
 */
telemetryRoutes.get('/telemetry/today-cost-by-project', async (c) => {
  const costs = await getTodayCostByProject();
  return c.json({ costs });
});

/**
 * HS-8149 — per-prompt timeline for the drilldown modal. Returns
 * every event correlated by `prompt_id` in start-ts order. The
 * modal renders each row clickable; expanding shows the verbatim
 * `attributes_json` + `body_json` for debugging.
 *
 * NOT scoped by project_secret — prompt IDs are globally unique
 * (Claude Code generates them per-session, sessions are per-process
 * which is per-terminal which is per-project, so collision across
 * projects is implausible). The returned `projectSecret` field lets
 * the modal display a project-name badge for cross-project
 * disambiguation in the dashboard view.
 *
 * Returns an empty-entries timeline (200 OK, not 404) when the
 * prompt id is unknown so the modal can show a friendly message
 * instead of a hard error.
 */
telemetryRoutes.get('/telemetry/prompt/:id', async (c) => {
  const promptId = c.req.param('id');
  const timeline = await getPromptTimeline(promptId);
  return c.json(timeline);
});
