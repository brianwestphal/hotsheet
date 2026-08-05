/**
 * HS-9604 (docs/67 §67.18) — resolve an incoming OTLP token datapoint to its
 * `otel_rollup_daily` column, for whichever tool emitted it.
 *
 * The routing RULES live on each plugin (`AiToolPlugin.telemetryTokenMetrics`,
 * §132's one-place rule); this module is only the lookup, and lives under
 * `db/` because it consults the registry from the ingest path — `src/aiTools/`
 * must not import `src/db/`.
 *
 * Read `aiTools/tokenMetrics.ts` first: the reason this is not a flat table is
 * that codex's counters are NESTED inside one another while Claude's are
 * disjoint, so the same-looking data needs opposite handling.
 */
import { getPlugin, listPlugins } from '../aiTools/registry.js';
import type { TokenBreakdownColumn, TokenColumn, TokenMetricMap } from '../aiTools/tokenMetrics.js';
import { GEN_AI_TOKEN_METRICS, isBreakdownColumn, routeTokenMetric } from '../aiTools/tokenMetrics.js';
import { emitterForSignalName } from './otelEmitter.js';

/** A tool's declared token map, or `undefined` if the emitter is unrecognized
 *  or declares none. */
function mapFor(metricName: string) {
  return getPlugin(emitterForSignalName(metricName))?.telemetryTokenMetrics;
}

/**
 * Claude Code's `type` attribute → column. Its four values are disjoint
 * partitions of one stream, which is why summing the columns is valid.
 *
 * An unknown or missing type yields `null`, which the caller records as a
 * datapoint with no token contribution rather than dropping — matching the
 * reads, which bucket tokens by `type`.
 */
export function tokenColumnFromTypeAttribute(attrs: Record<string, unknown>): TokenColumn | null {
  const t = attrs['type'];
  if (t === 'input') return 'input_tokens';
  if (t === 'output') return 'output_tokens';
  if (t === 'cacheRead' || t === 'cache_read') return 'cache_read_tokens';
  if (t === 'cacheCreation' || t === 'cache_creation') return 'cache_creation_tokens';
  return null;
}

/**
 * Whether this metric contributes to the daily rollup at all.
 *
 * An `'ignore'`-routed counter is **not** a rollup metric. That distinction
 * matters beyond the token columns: treating it as one would insert a row and
 * increment `datapoint_count` for a counter deliberately excluded, inflating
 * the datapoint tally with tokens that were counted elsewhere.
 */
export function isTokenRollupMetric(metricName: string): boolean {
  const routing = routeTokenMetric(metricName, mapFor(metricName));
  return routing !== null && routing !== 'ignore';
}

/**
 * The column a datapoint's value belongs in, or `null` for a recognized metric
 * whose datapoint carries no usable column (an unknown `type` attribute).
 *
 * Callers must gate on `isTokenRollupMetric` first — `null` here means "counts
 * as a datapoint, contributes no tokens", not "ignore this".
 */
export function tokenColumnForDatapoint(
  metricName: string,
  attrs: Record<string, unknown>,
): TokenColumn | null {
  const routing = routeTokenMetric(metricName, mapFor(metricName));
  if (routing === 'by-type-attribute') return tokenColumnFromTypeAttribute(attrs);
  if (routing === null || routing === 'ignore') return null;
  // A breakdown is stored separately and must never reach a summable column —
  // this is the containment invariant, enforced by the type split.
  if (isBreakdownColumn(routing)) return null;
  return routing;
}

/**
 * The BREAKDOWN column a datapoint belongs in, or `null`.
 *
 * Separate from `tokenColumnForDatapoint` on purpose: a caller wanting a total
 * uses that one and cannot accidentally pick this up, because the two return
 * incompatible types (HS-9607).
 */
export function breakdownColumnForDatapoint(metricName: string): TokenBreakdownColumn | null {
  const routing = routeTokenMetric(metricName, mapFor(metricName));
  if (routing === null || routing === 'ignore' || routing === 'by-type-attribute') return null;
  return isBreakdownColumn(routing) ? routing : null;
}

/** Every `type`-attribute spelling the by-type-attribute shape accepts, so the
 *  backfill can enumerate them rather than re-hard-coding the aliases. */
const TYPE_ALIASES = ['input', 'output', 'cacheRead', 'cache_read', 'cacheCreation', 'cache_creation'];

/** Per-column: which metric NAMES route there outright, and which `type`
 *  attribute values do (paired with the metrics that carry them). */
export interface TokenRollupSources {
  /** Metrics whose name alone determines the column (codex's shape). */
  readonly names: string[];
  /** Metrics that carry a `type` attribute (Claude's shape). */
  readonly typedMetrics: string[];
  /** The `type` values that select this column, incl. spelling variants. */
  readonly types: string[];
}

/**
 * The routing table, inverted for SQL.
 *
 * The BACKFILL rebuilds `otel_rollup_daily` from raw rows with `DELETE` +
 * recompute, so it must agree with live ingest exactly or a rebuild silently
 * rewrites history — dropping codex's tokens, or reinstating the inclusive
 * parents the live path excludes. Deriving both from one table is what makes
 * that agreement structural rather than a thing to remember.
 */
export function tokenRollupSources(): Record<TokenColumn | TokenBreakdownColumn, TokenRollupSources> {
  const out: Record<TokenColumn | TokenBreakdownColumn, TokenRollupSources> = {
    input_tokens: { names: [], typedMetrics: [], types: [] },
    output_tokens: { names: [], typedMetrics: [], types: [] },
    cache_read_tokens: { names: [], typedMetrics: [], types: [] },
    cache_creation_tokens: { names: [], typedMetrics: [], types: [] },
    // A breakdown, not an addend — the backfill must fill it and must NOT add
    // it to any total (HS-9607).
    reasoning_output_tokens: { names: [], typedMetrics: [], types: [] },
  };
  const maps = [
    GEN_AI_TOKEN_METRICS,
    ...listPlugins().map(p => p.telemetryTokenMetrics).filter((m): m is TokenMetricMap => m !== undefined),
  ];
  for (const map of maps) {
    for (const [name, routing] of Object.entries(map)) {
      if (routing === 'ignore') continue;
      if (routing === 'by-type-attribute') {
        for (const t of TYPE_ALIASES) {
          const col = tokenColumnFromTypeAttribute({ type: t });
          if (col === null) continue;
          if (!out[col].typedMetrics.includes(name)) out[col].typedMetrics.push(name);
          out[col].types.push(t);
        }
        continue;
      }
      out[routing].names.push(name);
    }
  }
  return out;
}
