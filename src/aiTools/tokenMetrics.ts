/**
 * HS-9604 (docs/67 §67.18) — which rollup column a token counter belongs in,
 * for any AI tool.
 *
 * ## The nesting problem, which is the whole reason this is not a lookup table
 *
 * Claude Code emits ONE metric, `claude_code.token.usage`, carrying a `type`
 * attribute. Its four values — `input` / `output` / `cacheRead` /
 * `cacheCreation` — are **disjoint partitions of one stream**, which is why
 * summing the four rollup columns yields a valid total.
 *
 * Codex emits a SEPARATE metric per counter, and they are **nested**. Measured
 * over 4,778 real `TokenUsage` records from `~/.codex/sessions`:
 *
 * - `cached_input_tokens <= input_tokens` — 4778/4778 (non-zero in 4698)
 * - `reasoning_output_tokens <= output_tokens` — 4778/4778
 * - `total_tokens == input_tokens + output_tokens` — 4778/4778
 *
 * So `input_tokens` **contains** the cached portion, and `output_tokens`
 * **contains** the reasoning portion. Routing codex's `input_tokens` to
 * `input_tokens` *and* its `cached_input_tokens` to `cache_read_tokens` would
 * count cached input twice. On the largest real sample — 190,406,252 input of
 * which 186,577,664 was cached — a summed total reads **~377M against a true
 * ~190M**. Near-exactly 2×, and entirely plausible-looking, which is the worst
 * kind of wrong.
 *
 * ## Why ignoring parents beats subtracting them
 *
 * The obvious correction is `input - cached`. It cannot work here: counters
 * arrive as **independent datapoints**, so no single ingest call ever sees both.
 * Any subtraction would need cross-datapoint state on the hot ingest path.
 *
 * Instead each tool declares the counters that are already disjoint and marks
 * the inclusive parents `ignore`. Codex publishes `non_cached_input_tokens`
 * alongside `cached_input_tokens`, so the disjoint pair is available directly
 * and the inclusive `input_tokens` is simply not routed. Stateless, and correct
 * per datapoint.
 *
 * ## `reasoning_output_tokens` deliberately goes nowhere
 *
 * It is a subset of `output_tokens`, so adding it double-counts; folding is not
 * an option the measurement leaves open. Storing it faithfully means a new
 * breakdown column on `otel_rollup_daily` (a schema-version bump) — tracked
 * separately. Until then it is `ignore`d, so no wrong number is produced, and
 * the value remains visible on the raw `otel_metrics` row either way.
 */

/** The disjoint rollup columns on `otel_rollup_daily`. */
export type TokenColumn =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens';

/**
 * Where a counter goes. `'ignore'` is a **positive** declaration — "this
 * counter is real, and deliberately not routed" — distinct from a name the
 * table has never heard of, which returns `null`. Keeping them apart is what
 * makes an inclusive parent's exclusion auditable rather than looking like an
 * oversight.
 *
 * `'by-type-attribute'` is the OTHER shape a tool can use: one metric carrying
 * every counter, split by a `type` attribute on each datapoint (Claude Code).
 * The column then comes from the attribute rather than the name, so the map
 * says *how to look*, not *where it goes*.
 */
export type TokenRouting = TokenColumn | 'ignore' | 'by-type-attribute';

/**
 * A tool's token metrics: exact metric name → routing.
 *
 * Exact names rather than suffix matching, because `input_tokens` and
 * `non_cached_input_tokens` differ only by prefix and route to opposite
 * outcomes — a suffix match would silently pick the wrong one.
 */
export type TokenMetricMap = Readonly<Record<string, TokenRouting>>;

/**
 * The OTel GenAI semantic conventions, shared by every tool that follows them.
 *
 * Vendor-neutral, so a future tool emitting these is aggregated with no new
 * mapping. `cache_read` / `cache_write` are separately specified there and so
 * are taken as disjoint from `input_tokens` — the opposite of codex's own
 * vendor fields. That reading is **unverified against a live stream**: codex
 * derives its convention output from the nested fields, so if it turns out to
 * carry the nesting through, `gen_ai.usage.input_tokens` becomes an inclusive
 * parent and must move to `ignore` here.
 */
export const GEN_AI_TOKEN_METRICS: TokenMetricMap = {
  'gen_ai.usage.input_tokens': 'input_tokens',
  'gen_ai.usage.output_tokens': 'output_tokens',
  'gen_ai.usage.cache_read.input_tokens': 'cache_read_tokens',
  'gen_ai.usage.cache_write.input_tokens': 'cache_creation_tokens',
};

/**
 * Route a metric name, or `null` when the tool does not recognize it.
 *
 * A tool's own map wins over the shared conventions, so a tool that emits both
 * a vendor counter and its convention equivalent can suppress one of them and
 * avoid counting the same tokens twice.
 */
export function routeTokenMetric(name: string, own: TokenMetricMap | undefined): TokenRouting | null {
  const fromOwn = own?.[name];
  if (fromOwn !== undefined) return fromOwn;
  return GEN_AI_TOKEN_METRICS[name] ?? null;
}

/** Whether a name is a token counter this tool aggregates — i.e. recognized AND
 *  routed to a column. Used to decide what to persist for the rollup at all. */
export function isRoutedTokenMetric(name: string, own: TokenMetricMap | undefined): boolean {
  const r = routeTokenMetric(name, own);
  return r !== null && r !== 'ignore';
}
