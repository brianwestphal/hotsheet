/**
 * HS-9605 (docs/67 §67.17) — whether a telemetry window's cost figure can be
 * believed.
 *
 * ## The problem this exists for
 *
 * Every cost surface in Hot Sheet sums `claude_code.cost.usage`. **Codex reports
 * no cost at all** — searched codex-cli 0.146.0 for any `*.cost*` metric: zero
 * matches. It reports tokens in unusual detail and cost never, and no OTel
 * semantic convention covers cost, which is presumably why.
 *
 * So the moment codex telemetry starts arriving (HS-9603 switched its exporter
 * on), every cost figure for codex work reads **`$0.00`** — *"this work was
 * free"* — which is a worse lie than the Claude-specific labelling this epic set
 * out to fix. A missing number must look missing.
 *
 * ## Three states, and the middle one is the dangerous one
 *
 * `partial` is the case worth designing for rather than the obvious `unavailable`
 * one. A window holding **both** Claude and codex work has a real, correctly
 * computed cost that is nonetheless **incomplete** — it silently omits every
 * codex turn. An unqualified figure there under-reports while looking perfectly
 * normal, which is more misleading than a blank.
 */
import { getPlugin } from './registry.js';

export type CostAvailability =
  /** Every tool in the window reports cost. Show the figure plainly. */
  | { status: 'available' }
  /** No tool in the window reports cost. Show a dash, never a zero. */
  | { status: 'unavailable'; toolsWithoutCost: string[] }
  /** Some do, some don't — the figure is real but omits the others' work. */
  | { status: 'partial'; toolsWithoutCost: string[] };

/**
 * Judge a window from the tools that produced its telemetry (HS-9602's
 * `emitters`).
 *
 * An **empty** window is `available`: there is no cost to misreport, and the
 * existing empty state should render unchanged rather than sprouting a warning
 * about tools that were never involved.
 *
 * An **unrecognized** emitter counts as not-reporting-cost. We cannot know that
 * it reported cost, and the whole point here is to stop asserting cost we do not
 * have — so the unknown case has to fail toward honesty.
 */
export function costAvailabilityFor(emitters: readonly string[]): CostAvailability {
  if (emitters.length === 0) return { status: 'available' };

  const without = emitters.filter(id => getPlugin(id)?.telemetryReportsCost !== true);
  if (without.length === 0) return { status: 'available' };
  if (without.length === emitters.length) return { status: 'unavailable', toolsWithoutCost: without };
  return { status: 'partial', toolsWithoutCost: without };
}

/** Display name for a tool id, falling back to the id itself so an unrecognized
 *  emitter is still nameable in a tooltip rather than vanishing. */
function nameOf(id: string): string {
  return getPlugin(id)?.productName ?? id;
}

/**
 * The sentence explaining a non-`available` verdict, or `null` when there is
 * nothing to explain.
 *
 * Deliberately says which tool and what it means, because "—" on its own reads
 * as a bug. `partial` says the figure is an UNDER-count rather than merely
 * "incomplete" — a reader deciding whether to trust a number needs the direction
 * of the error, not just its existence.
 */
export function costAvailabilityNote(availability: CostAvailability): string | null {
  if (availability.status === 'available') return null;
  const names = availability.toolsWithoutCost.map(nameOf).join(' and ');
  return availability.status === 'unavailable'
    ? `${names} does not report cost, so no cost can be shown for this work.`
    : `Excludes ${names}, which does not report cost — the real total is higher.`;
}
