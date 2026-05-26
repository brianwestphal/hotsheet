import { getPerTicketRollup, type TicketRollup } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';
// HS-8566 — shared cost formatter (the $1000-cutoff + half-up rule).
import { formatCost } from './telemetryFormat.js';

/**
 * HS-8152 — per-ticket Claude usage stats block (§67.10.7). Renders
 * inside the detail panel under the meta-info row. Shows aggregate
 * cost / tokens / prompt count / wall-clock duration attributed to
 * the active ticket via the HS-8151 marker mechanism (channel-
 * triggered prompts prepend `<!-- hotsheet:ticket=HS-NNNN -->` to
 * the message; the per-ticket rollup query in
 * `src/db/otelQueries.ts::getPerTicketRollup` parses it back).
 *
 * Hidden entirely when the ticket has zero attributed prompts —
 * keeps the detail panel uncluttered for tickets that pre-date
 * telemetry or were worked on without Hot Sheet channel triggers.
 */


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

/**
 * Fetch the per-ticket rollup + render into `#detail-telemetry-stats`.
 * Called from `loadDetail` after the meta-info paint. Idempotent —
 * every call replaces the container's contents.
 *
 * Renders nothing (empty container) when the ticket has zero
 * attributed prompts so we don't take up vertical real estate on
 * tickets nobody's used Claude on.
 */
export async function loadAndRenderTicketTelemetry(ticketNumber: string): Promise<void> {
  const container = byIdOrNull('detail-telemetry-stats');
  if (container === null) return;

  let rollup: TicketRollup;
  try {
    rollup = await getPerTicketRollup(ticketNumber);
  } catch {
    // Network hiccup / receiver down → leave the container empty.
    container.replaceChildren();
    return;
  }

  if (rollup.promptCount === 0) {
    // No attributed prompts — hide the block entirely.
    container.replaceChildren();
    return;
  }

  container.replaceChildren(toElement(
    <div className="ticket-telemetry-block">
      <h4 className="ticket-telemetry-label">Claude usage on this ticket</h4>
      <div className="ticket-telemetry-stats-grid">
        <div className="ticket-telemetry-stat">
          <span className="ticket-telemetry-stat-label">Cost</span>
          <span className="ticket-telemetry-stat-value">{formatCost(rollup.totalCost)}</span>
        </div>
        <div className="ticket-telemetry-stat">
          <span className="ticket-telemetry-stat-label">Tokens</span>
          <span className="ticket-telemetry-stat-value">{formatTokens(rollup.totalTokens)}</span>
        </div>
        <div className="ticket-telemetry-stat">
          <span className="ticket-telemetry-stat-label">Prompts</span>
          <span className="ticket-telemetry-stat-value">{String(rollup.promptCount)}</span>
        </div>
        <div className="ticket-telemetry-stat">
          <span className="ticket-telemetry-stat-label">Time spent</span>
          <span className="ticket-telemetry-stat-value">{formatDuration(rollup.totalDurationSeconds)}</span>
        </div>
      </div>
    </div>
  ));
}

/**
 * Clear the stats block. Called on detail-panel close + on ticket
 * switch (before the new ticket's stats land) to avoid showing
 * stale data during the loading window.
 */
export function clearTicketTelemetryStats(): void {
  const container = byIdOrNull('detail-telemetry-stats');
  if (container !== null) container.replaceChildren();
}

/** HS-8152 — exported for tests. */
export const _testing = {
  formatCost,
  formatTokens,
  formatDuration,
};
