/**
 * §78 Announcer (HS-8766) — token + cost accounting for the Announcer's
 * Anthropic API spend.
 *
 * One row per `POST /api/announcer/generate` that actually called the API.
 * Stored in the SHARED telemetry DB (`getTelemetryDb()`) keyed by
 * `project_secret`, exactly like `otel_metrics`, so the per-project analytics
 * dashboard (§71) and the cross-project stats page (§70) aggregate it with the
 * same project filter. Unlike Claude Code's telemetry, this is always the
 * user's real Anthropic spend on their own key — it does NOT respect the
 * `telemetryCostMode` api/subscription toggle.
 */
import { announcerCost } from '../announcer/models.js';
import { getTelemetryDb } from './connection.js';

export interface AnnouncerUsageTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  generations: number;
}

export interface AnnouncerUsageByProjectRow extends AnnouncerUsageTotals {
  projectSecret: string;
}

/** Record one summarization's usage. Cost is derived from the model + tokens
 *  (`announcerCost`) so callers only supply raw token counts. */
export async function recordAnnouncerUsage(usage: {
  projectSecret: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const cost = announcerCost(usage.model, usage.inputTokens, usage.outputTokens);
  const db = await getTelemetryDb();
  await db.query(
    `INSERT INTO announcer_usage (project_secret, model, input_tokens, output_tokens, cost)
     VALUES ($1, $2, $3, $4, $5)`,
    [usage.projectSecret, usage.model, usage.inputTokens, usage.outputTokens, cost],
  );
}

interface TotalsRow { cost: string | number | null; input_tokens: string | number | null; output_tokens: string | number | null; generations: string | number | null }

function toTotals(row: TotalsRow | undefined): AnnouncerUsageTotals {
  return {
    cost: Number(row?.cost ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    generations: Number(row?.generations ?? 0),
  };
}

/** Windowed totals for one project (§71). `since` null = all time. */
export async function getAnnouncerUsageTotals(projectSecret: string, since: Date | null): Promise<AnnouncerUsageTotals> {
  const db = await getTelemetryDb();
  const params: (string | Date)[] = [projectSecret];
  let where = 'project_secret = $1';
  if (since !== null) { params.push(since); where += ` AND ts >= $${String(params.length)}`; }
  const res = await db.query<TotalsRow>(
    `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens, COUNT(*) AS generations
       FROM announcer_usage WHERE ${where}`,
    params,
  );
  return toTotals(res.rows[0]);
}

/** Windowed per-project breakdown for the cross-project page (§70). Scoped to
 *  `allowedSecrets` (the loaded project tabs); null = every project. `since`
 *  null = all time. Highest-spend first. */
export async function getAnnouncerUsageByProject(
  allowedSecrets: readonly string[] | null,
  since: Date | null,
): Promise<AnnouncerUsageByProjectRow[]> {
  if (allowedSecrets !== null && allowedSecrets.length === 0) return [];
  const db = await getTelemetryDb();
  const params: (string | Date)[] = [];
  const clauses: string[] = [];
  if (since !== null) { params.push(since); clauses.push(`ts >= $${String(params.length)}`); }
  if (allowedSecrets !== null) {
    const placeholders = allowedSecrets.map((s) => { params.push(s); return `$${String(params.length)}`; });
    clauses.push(`project_secret IN (${placeholders.join(', ')})`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = await db.query<TotalsRow & { project_secret: string }>(
    `SELECT project_secret, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens, COUNT(*) AS generations
       FROM announcer_usage ${where}
       GROUP BY project_secret
       ORDER BY SUM(cost) DESC`,
    params,
  );
  return res.rows.map((r) => ({ projectSecret: r.project_secret, ...toTotals(r) }));
}
