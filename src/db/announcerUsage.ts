/**
 * §78 Announcer (HS-8766) — token + cost accounting for the Announcer's
 * Anthropic API spend.
 *
 * One row per `POST /api/announcer/generate` that actually called the API.
 *
 * **HS-8874** — like `otel_metrics`, this is now stored PER-PROJECT (in each
 * project's own DB), keyed by `project_secret`. `recordAnnouncerUsage` resolves
 * the writing project's own DB from its secret (generate runs OUTSIDE the
 * request `runWithDataDir` context, so it can't rely on the ambient DB). Reads
 * (`getAnnouncerUsageTotals` / `getAnnouncerUsageByProject`) use the ambient
 * telemetry context the caller binds (the per-project route's request context,
 * or the dashboard fan-out's `runWithTelemetryDb`). Unlike Claude Code's
 * telemetry, this is always the user's real Anthropic spend on their own key —
 * it does NOT respect the `telemetryCostMode` api/subscription toggle.
 */
import { announcerCost } from '../announcer/models.js';
import { getProjectBySecret } from '../projects.js';
import { centralTelemetryDataDir, getTelemetryDb, runWithTelemetryDb } from './connection.js';

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
  // HS-8874 — write to the project's OWN telemetry DB, resolved from its secret
  // (falls back to central if the project isn't registered, mirroring the otel
  // writers' routing).
  const project = getProjectBySecret(usage.projectSecret);
  const dataDir = project !== undefined ? project.dataDir : centralTelemetryDataDir();
  await runWithTelemetryDb(dataDir, async () => {
    const db = await getTelemetryDb();
    await db.query(
      `INSERT INTO announcer_usage (project_secret, model, input_tokens, output_tokens, cost)
       VALUES ($1, $2, $3, $4, $5)`,
      [usage.projectSecret, usage.model, usage.inputTokens, usage.outputTokens, cost],
    );
  });
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
