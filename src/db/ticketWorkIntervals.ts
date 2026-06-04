/**
 * HS-8730 (per-ticket cost, time-window correlation; follow-up to HS-8729) —
 * record when each ticket was actively being worked, so the per-ticket cost
 * rollup can attribute `api_request` cost by timestamp.
 *
 * Background: the original per-ticket correlation (HS-8151 Option 3) tagged a
 * channel-triggered prompt with the ONE ticket open in the detail panel at
 * trigger time. That misses every ticket in the agentic worklist flow (Claude
 * pulls tickets off Up Next and marks each started→completed itself). This
 * module captures the actual work windows from those status transitions: a
 * ticket's cost is the `api_request` events whose timestamp falls inside a
 * window during which the ticket was `started`.
 *
 * Storage: `ticket_work_intervals` lives in the telemetry DB (the default
 * project's DB per `getTelemetryDb`), keyed by `project_secret` to match the
 * `otel_events` rows — so the rollup join (`getPerTicketRollup`) is single-DB.
 *
 * All writes are best-effort and swallow errors: cost attribution must never
 * break a ticket status update.
 */

import type { TicketStatus } from '../types.js';
import { getTelemetryDb } from './connection.js';

/**
 * Record a ticket status transition for cost attribution.
 *
 * - `→ started`: close any stale open interval for this (project, ticket) —
 *   defensive against a previous interval that was never closed — then open a
 *   fresh interval.
 * - any other status (completed / verified / not_started / backlog / archive /
 *   deleted): close the open interval, ending the work window.
 *
 * No-ops (and never throws) when `secret` is empty or the telemetry DB is
 * unavailable.
 */
export async function recordTicketWorkTransition(
  secret: string,
  ticketNumber: string,
  status: TicketStatus,
): Promise<void> {
  if (secret === '' || ticketNumber === '') return;
  try {
    const db = await getTelemetryDb();
    // Close any currently-open interval either way (a re-`started` supersedes a
    // stale open one; leaving `started` ends the window).
    await db.query(
      `UPDATE ticket_work_intervals SET ended_at = NOW()
       WHERE project_secret = $1 AND ticket_number = $2 AND ended_at IS NULL`,
      [secret, ticketNumber],
    );
    if (status === 'started') {
      await db.query(
        `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at)
         VALUES ($1, $2, NOW())`,
        [secret, ticketNumber],
      );
    }
  } catch (err) {
    console.warn('[ticketWorkIntervals] failed to record transition:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Close every open interval for a project. Called when the channel signals
 * `done` so a ticket left `started` (e.g. a FEEDBACK NEEDED hand-off) doesn't
 * keep an interval open and accrue unrelated future cost — it bounds
 * attribution to the actual work session. Best-effort; never throws.
 */
export async function closeOpenTicketIntervalsForProject(secret: string): Promise<void> {
  if (secret === '') return;
  try {
    const db = await getTelemetryDb();
    await db.query(
      `UPDATE ticket_work_intervals SET ended_at = NOW()
       WHERE project_secret = $1 AND ended_at IS NULL`,
      [secret],
    );
  } catch (err) {
    console.warn('[ticketWorkIntervals] failed to close open intervals:', err instanceof Error ? err.message : String(err));
  }
}
