import { getPerTicketRollup, type TicketRollup } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';
// HS-8566 — shared cost formatter (the $1000-cutoff + half-up rule).
// HS-8670 — shared token formatter (was duplicated here + 3 other surfaces).
import { formatCost, formatTokens } from './telemetryFormat.js';

/**
 * HS-8152 — per-ticket Claude usage stats block (§67.10.7). Renders
 * inside the detail panel just above the Notes section (HS-8648 moved
 * it there from the bottom). Shows aggregate
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


function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

/**
 * HS-9249 — per-ticket rollup cache. `loadDetail` re-runs on every background
 * poll / WebSocket ticket update, and editing the details field auto-saves on a
 * debounce — so each keystroke's save round-trips into a `loadDetail` and, before
 * this cache, blanked this block (`clearTicketTelemetryStats`) and re-fetched,
 * flashing it empty then back. Keyed by ticket number, refreshed on every
 * successful fetch, so a same-ticket reload re-paints the LAST value immediately
 * and only updates once the fresh value lands.
 */
const rollupCache = new Map<string, TicketRollup>();

/**
 * The ticket the block currently represents. Lets a switch clear a stale block
 * only when there's no cached value to show for the new ticket, and lets an
 * in-flight fetch detect that the user moved to another ticket before it resolved
 * (so it doesn't clobber the newer ticket's block).
 */
let currentTicket: string | null = null;

/** Paint one rollup into the container, or hide the block (empty container) when
 *  the ticket has zero attributed prompts. `replaceChildren` keeps it idempotent. */
function renderRollup(container: HTMLElement, rollup: TicketRollup): void {
  if (rollup.promptCount === 0) {
    container.replaceChildren();
    return;
  }
  container.replaceChildren(toElement(
    <div className="ticket-telemetry-block">
      <h4 className="ticket-telemetry-label">Claude Usage on This Ticket</h4>
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
 * Fetch the per-ticket rollup + render into `#detail-telemetry-stats`.
 * Called from `loadDetail` after the meta-info paint.
 *
 * HS-9249 — never flashes empty on a same-ticket reload: if we have a cached
 * value for this ticket, it's painted synchronously up front (before the async
 * fetch), so a background poll / auto-save round-trip keeps the last value on
 * screen and only swaps in the fresh one when it arrives. On a SWITCH to a ticket
 * we've never loaded, the previous ticket's stats are cleared so they can't
 * linger during the fetch. Renders nothing (empty container) when the ticket has
 * zero attributed prompts.
 */
export async function loadAndRenderTicketTelemetry(ticketNumber: string): Promise<void> {
  const container = byIdOrNull('detail-telemetry-stats');
  if (container === null) return;

  const switching = currentTicket !== ticketNumber;
  currentTicket = ticketNumber;

  const cached = rollupCache.get(ticketNumber);
  if (cached !== undefined) {
    // Same-ticket reload OR a revisit — show the cached value immediately so the
    // block never blanks while the fresh fetch is in flight.
    renderRollup(container, cached);
  } else if (switching) {
    // First time we've seen this ticket AND we're switching away from another —
    // clear the previous ticket's stats so they don't show under the new ticket.
    container.replaceChildren();
  }

  let rollup: TicketRollup;
  try {
    rollup = await getPerTicketRollup(ticketNumber);
  } catch {
    // Network hiccup / receiver down: keep whatever's shown (a cached value if we
    // had one) rather than blanking a good value on a transient failure.
    return;
  }

  rollupCache.set(ticketNumber, rollup);

  // The user switched tickets while this fetch was in flight — the block now
  // belongs to another ticket. Keep the cache warm, but don't repaint over it.
  if (currentTicket !== ticketNumber) return;

  renderRollup(container, rollup);
}

/**
 * Clear the stats block. Called on detail-panel close so a later reopen of a
 * DIFFERENT ticket can't briefly show this one's stats. The rollup cache is left
 * intact so revisiting a ticket still re-paints instantly (HS-9249).
 */
export function clearTicketTelemetryStats(): void {
  const container = byIdOrNull('detail-telemetry-stats');
  if (container !== null) container.replaceChildren();
  currentTicket = null;
}

/** HS-8152 — exported for tests. HS-9249 — `resetCache` clears the module-level
 *  cache + current-ticket tracker so unit tests start from a clean slate. */
export const _testing = {
  formatCost,
  formatTokens,
  formatDuration,
  resetCache(): void { rollupCache.clear(); currentTicket = null; },
};
