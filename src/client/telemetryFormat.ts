/**
 * HS-8566 — shared cost formatter for every telemetry surface (per-ticket
 * stats, analytics dashboard, cross-project page, cost-over-time chart,
 * project-tab cost chip, sidebar widget, etc.).
 *
 * Pre-HS-8566 each surface (`ticketTelemetryStats.tsx`,
 * `crossProjectStatsPage.tsx`, `telemetryCostOverTimeChart.tsx`,
 * `dashboardMode.tsx`) carried its own near-identical `$${n.toFixed(2)}`
 * inline. The user reported the cents column eats horizontal space on the
 * cross-project totals and the cost-over-time chart's Y-axis ticks once
 * the running total crosses $1000 — at that scale `$1234.56` carries no
 * useful precision vs `$1235`.
 *
 * Format rules (HS-8566):
 *  - `n === 0` → `$0.00` (preserve the always-present cent column for
 *    parity with the chart axis ticks before the first prompt).
 *  - `0 < n < 0.01` → `<$0.01` (sub-cent floor; the user can tell something
 *    happened without us claiming $0).
 *  - `0.01 <= n < 1000` → `$X.XX` (two decimals, half-up via `Math.round`
 *    to avoid `toFixed`'s engine-dependent banker's-rounding).
 *  - `n >= 1000` → `$X,XXX` (integer dollars, half-up rounded, comma
 *    thousands separator).
 *
 * `Math.round` rounds half-AWAY-from-zero for positive numbers, which is
 * the standard "half-up" the user asked for. Costs are always non-
 * negative, so the negative-number quirk of `Math.round` (rounds toward
 * +Infinity, not away-from-zero) doesn't apply.
 */
/**
 * HS-8628 — effective price-per-token estimate for a model, expressed per
 * million tokens (the unit Anthropic prices in). Derived from observed usage:
 * `cost / tokens * 1e6`. Self-updating (no hardcoded price table) but blends
 * the input + output rates into one figure since `cost` is a single
 * already-priced number. Returns `—` when there are no tokens to divide by (a
 * cost-only window, or zero usage) so the UI doesn't render `$Infinity`.
 *
 * Always shows 2 decimals (rates are small per-Mtok dollars; `$3.00/Mtok` reads
 * better than the `formatCost` integer collapse at the $1000-plus tier, so this
 * is a separate formatter rather than reusing `formatCost`).
 */
export function formatRatePerMtok(cost: number, tokens: number): string {
  if (!Number.isFinite(cost) || !Number.isFinite(tokens) || tokens <= 0) return '—';
  const perMtok = (cost / tokens) * 1_000_000;
  return `$${perMtok.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/Mtok`;
}

export function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 1000) {
    // Half-up to 2 decimals. `Math.round(n * 100) / 100` is deterministic
    // across V8 / JSC / SpiderMonkey; `toFixed(2)` is not (it uses
    // banker's rounding on some engines for the exact-half case). The
    // `<$0.01` floor fires only when the rounded value is 0 cents (so
    // 0.005 displays as $0.01 — half-up — but 0.004 displays as
    // <$0.01).
    const cents = Math.round(n * 100);
    if (cents === 0) return '<$0.01';
    const dollars = Math.floor(cents / 100);
    const remainder = String(cents % 100).padStart(2, '0');
    return `$${dollars.toLocaleString('en-US')}.${remainder}`;
  }
  // >= 1000 — drop the cents, half-up to integer, comma-grouped.
  const rounded = Math.round(n);
  return `$${rounded.toLocaleString('en-US')}`;
}
