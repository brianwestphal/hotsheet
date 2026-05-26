import { Hono } from 'hono';

import { clearProjectTelemetry, type DashboardWindow, getDashboardPayload, getPerTicketRollup, getProjectRollupPayload, getPromptTimeline, getTelemetryDebugInfo, getTodayCost, getTodayCostByProject } from '../db/otelQueries.js';
import { readFileSettings } from '../file-settings.js';
import { readProjectList } from '../project-list.js';
import { getAllProjects, getProjectBySecret } from '../projects.js';
import type { AppEnv } from '../types.js';

/**
 * HS-8479 / §69.2 — true when at least one registered project has
 * `telemetry_enabled === true` in its `<dataDir>/.hotsheet/settings.json`.
 * Drives the conditional visibility of the global Telemetry sidebar
 * entry (and only that — does not gate anything else).
 *
 * Iterates `~/.hotsheet/projects.json` for the dataDirs + reads each
 * file-settings file. At single-user scale (handful of projects) this
 * is cheap; no cache needed.
 */
function anyProjectHasTelemetryEnabled(): boolean {
  const dataDirs = readProjectList();
  for (const dataDir of dataDirs) {
    const settings = readFileSettings(dataDir);
    if (settings['telemetry_enabled'] === true) return true;
  }
  return false;
}

/**
 * Telemetry API surface. Routes here are gated by the same
 * `/api/*` middleware as the rest of the app (`X-Hotsheet-Secret`
 * header OR same-origin enforcement). All routes are read-only
 * `GET` — telemetry data lands via the OTLP receiver routes
 * (`POST /v1/{metrics,logs,traces}`) and the cleanup sweep is
 * triggered out-of-band.
 *
 * HS-8509 (Phase 5 cleanup) — removed the drawer-tab route
 * `GET /api/telemetry/drawer` and its `getDrawerPayload` server
 * helper along with the drawer Telemetry tab UI. The per-project
 * rollup is now served via `GET /api/telemetry/project-rollup`
 * (HS-8505) and consumed by the analytics-dashboard telemetry
 * section (HS-8508 / §71).
 */
export const telemetryRoutes = new Hono<AppEnv>();

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
  // HS-8484 — include `tracesEnabled` so the drilldown can render the
  // "no spans recorded for this prompt" diagnostic note when the active
  // project has traces enabled but the specific prompt has no spans
  // (e.g. the prompt fired before the user enabled traces).
  const activeSecret = c.get('projectSecret');
  const project = getProjectBySecret(activeSecret);
  const settings = project === undefined ? {} : readFileSettings(project.dataDir);
  const tracesEnabled = settings['telemetry_traces_enabled'] === true;
  return c.json({ ...timeline, tracesEnabled });
});

/**
 * HS-8152 / §67.10.7 — per-ticket Claude usage rollup. Returns the
 * aggregate cost / tokens / prompt count / wall-clock duration
 * attributed to a given Hot Sheet ticket by the HS-8151 marker
 * mechanism (channel-triggered prompts carry an HTML-comment marker
 * `<!-- hotsheet:ticket=HS-NNNN -->` that lands in the
 * `claude_code.user_prompt` event body).
 *
 * Returns zero values when the ticket has no attributed prompts
 * (200 OK, not 404 — the detail panel renders nothing in that case).
 *
 * Path parameter is the human-readable `ticket_number` (e.g.
 * `HS-1234`), not the numeric id, so the URL is shareable and
 * scrutable.
 */
telemetryRoutes.get('/telemetry/ticket/:number', async (c) => {
  const ticketNumber = c.req.param('number');
  const rollup = await getPerTicketRollup(ticketNumber);
  return c.json(rollup);
});

/**
 * HS-8480 / §69.4 — bundled cross-project dashboard payload. One
 * round-trip + one error point for the §69.3 cross-project dashboard
 * view. Matches the drawer-tab `getDrawerPayload` precedent.
 *
 * Query params:
 *   - `window`: `today` | `week` | `month` | `90d` | `all`. Default `month`.
 *     Narrows the cost-by-project / cost-by-model / heatmap /
 *     top-prompts sections. Window-totals chips always carry today /
 *     week / month / allTime regardless.
 *   - `tz`: IANA timezone name (e.g. `America/Los_Angeles`). Used for
 *     the 7×24 heatmap's day-of-week + hour bucketing. Default `UTC`.
 *     The client passes `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 *
 * Read-only `GET`. Subject to the existing `/api/*` middleware.
 */
/**
 * HS-8479 / §69.2 — drives the conditional Telemetry sidebar entry.
 * Returns `{ enabled: boolean }` — `true` iff at least one project
 * has the master `telemetry_enabled` toggle on. Polled at app boot;
 * the client also re-fetches on the `applyFileSettings` broadcast
 * so toggling the master setting instantly shows / hides the entry
 * (no 5 s bell-tick lag).
 */
telemetryRoutes.get('/telemetry/enabled-anywhere', (c) => {
  return c.json({ enabled: anyProjectHasTelemetryEnabled() });
});

telemetryRoutes.get('/telemetry/dashboard', async (c) => {
  const windowRaw = c.req.query('window') ?? 'month';
  const knownWindows: DashboardWindow[] = ['today', 'week', 'month', '90d', 'all'];
  const window: DashboardWindow = (knownWindows as string[]).includes(windowRaw)
    ? (windowRaw as DashboardWindow)
    : 'month';
  const timezone = c.req.query('tz') ?? 'UTC';
  // HS-8625 — the cross-project page should only ever show currently-loaded
  // project data: restrict every aggregate to the registered project tabs'
  // secrets. Telemetry rows outlive the project that produced them (the §67.6
  // shared store), so without this filter a closed project's stale data lingers
  // in the totals / cost-by-project table (the HS-8622 "Unknown project" row).
  const allowedSecrets = getAllProjects().map(p => p.secret);
  const payload = await getDashboardPayload(window, timezone, allowedSecrets);
  return c.json(payload);
});

/**
 * HS-8503 Phase 1 / §69.10.5 — per-project analytics-dashboard rollup
 * payload. Drives the new telemetry sub-region appended below the
 * existing analytics-dashboard ticket charts.
 *
 * Query params:
 *   - `window`: `today` | `week` | `month` | `90d` | `all`. Default `month`.
 *     Narrows `costByModel`, `toolLatencyHistogram`, and `costOverTime`.
 *     `windowTotals` always carries today / week / month / allTime.
 *   - `tz`: IANA timezone name for the `costOverTime` date bucketing.
 *     Default `UTC`.
 *
 * Project context: scoped to `c.get('projectSecret')` (the same
 * resolution path the drawer + cost-chip routes use). No `?project=`
 * query param — the active project is identified by the same
 * X-Hotsheet-Secret middleware that gates every other `/api/*` route.
 *
 * Read-only `GET`. Subject to the existing `/api/*` middleware.
 */
telemetryRoutes.get('/telemetry/project-rollup', async (c) => {
  const windowRaw = c.req.query('window') ?? 'month';
  const knownWindows: DashboardWindow[] = ['today', 'week', 'month', '90d', 'all'];
  const window: DashboardWindow = (knownWindows as string[]).includes(windowRaw)
    ? (windowRaw as DashboardWindow)
    : 'month';
  const timezone = c.req.query('tz') ?? 'UTC';
  const projectSecret = c.get('projectSecret');
  const payload = await getProjectRollupPayload(projectSecret, window, timezone);
  return c.json(payload);
});

/**
 * HS-8606 / §74 — clear all telemetry for the active project. Backs the
 * Settings → Telemetry → Retention "Clear telemetry data" button. Mutation,
 * so the `/api/*` middleware already enforces the secret (header or
 * same-origin). Scoped to `c.get('projectSecret')` — the same project
 * resolution every other telemetry route uses — and refuses to run with an
 * empty secret so a misconfigured request can't wipe the shared store across
 * every project. Returns `{ deleted }` for the toast / status line.
 */
telemetryRoutes.delete('/telemetry/project-data', async (c) => {
  const projectSecret = c.get('projectSecret');
  if (projectSecret === '') return c.json({ error: 'No project secret' }, 400);
  const result = await clearProjectTelemetry(projectSecret);
  return c.json(result);
});

/**
 * HS-8639 — read-only diagnostic for the "prompt count = 1 / empty
 * recent-prompts + tool histogram" report. Returns the `event_name` +
 * `token.usage` `type` distributions actually stored for the active project,
 * so we can tell whether Claude Code's LOG events are arriving at all,
 * arriving under an unexpected `event_name`, or arriving without a `prompt_id`
 * — distinguishing "logs never sent" vs "dropped" vs "ingested-but-miscounted"
 * without having to read the single-writer telemetry DB out of band. Scoped to
 * `c.get('projectSecret')` like every other telemetry route.
 */
telemetryRoutes.get('/telemetry/_debug', async (c) => {
  const projectSecret = c.get('projectSecret');
  const info = await getTelemetryDebugInfo(projectSecret === '' ? null : projectSecret);
  return c.json(info);
});
