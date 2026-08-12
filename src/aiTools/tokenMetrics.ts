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
 * ## `reasoning_output_tokens` is a BREAKDOWN, not a fifth column
 *
 * It is a subset of `output_tokens` (4778/4778), so adding it to the disjoint
 * set would double-count in any caller that sums them. HS-9607 stores it in its
 * own column typed `TokenBreakdownColumn` — a separate type from `TokenColumn`,
 * so the compiler refuses to treat it as an addend rather than a comment asking
 * readers not to.
 */

/**
 * The **disjoint** rollup columns on `otel_rollup_daily`. Summing all four is a
 * valid total — that property is what the routing rules exist to protect, and
 * nothing that is a subset of another column may join this type.
 */
export type TokenColumn =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens';

/**
 * A **breakdown** column: a counter that is already INSIDE one of the disjoint
 * columns, stored for detail rather than for summing (HS-9607).
 *
 * Deliberately a separate type from `TokenColumn` rather than a fifth member.
 * Measured 4778/4778, `reasoning_output_tokens` is a subset of
 * `output_tokens` — so a caller that sums "all the token columns" would
 * double-count it. Keeping it out of `TokenColumn` means the type system
 * refuses that mistake instead of a comment asking readers not to make it.
 */
export type TokenBreakdownColumn = 'reasoning_output_tokens';

/** Which disjoint column each breakdown lives inside, so a reader (or a future
 *  consistency check) can see the containment rather than infer it. */
export const BREAKDOWN_PARENT: Readonly<Record<TokenBreakdownColumn, TokenColumn>> = {
  reasoning_output_tokens: 'output_tokens',
};

/** Type guard separating the two, since `routeTokenMetric` returns either. */
export function isBreakdownColumn(r: TokenRouting): r is TokenBreakdownColumn {
  return r in BREAKDOWN_PARENT;
}

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
export type TokenRouting = TokenColumn | TokenBreakdownColumn | 'ignore' | 'by-type-attribute';

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

/**
 * HS-9621 — one usage record's token counts, already resolved to the disjoint
 * rollup columns (summing the four disjoint columns is a valid total;
 * `reasoning_output_tokens` is a breakdown of `output_tokens`, never summed).
 */
export interface DisjointTokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_output_tokens: number;
}

/**
 * HS-9621 (docs/67 §67.16) — how a tool reports token usage on a single OTLP LOG
 * event, as opposed to as metrics (`telemetryTokenMetrics`).
 *
 * Measured against codex-cli 0.147.0: codex exports token usage ONLY via a log
 * record (`event.name='codex.sse_event'`, `event.kind='response.completed'`) and
 * emits NO token metrics at all — so the metric-name map can never reach it.
 * This spec names the event and its per-counter attributes.
 *
 * The metrics path must `ignore` the inclusive parents (`input` ⊇ cached,
 * `output` ⊇ reasoning) because each counter is an independent datapoint and no
 * single ingest sees both. A log record carries EVERY counter together, so here
 * the nesting is resolved directly by subtraction — stateless and exact.
 */
export interface LogTokenSpec {
  /** The `event.name` attribute identifying the usage event. */
  readonly eventName: string;
  /** The `event.kind` value to require, if the event has kinds (codex sends
   *  `response.created` etc. without token totals; only `response.completed`
   *  carries them). */
  readonly eventKind?: string;
  /** Attribute carrying the model id; absent ⇒ '(unknown)'. */
  readonly modelAttr?: string;
  /** Attribute of the input counter, INCLUSIVE of `cacheRead`. */
  readonly inputInclusive: string;
  /** Attribute of the output counter, INCLUSIVE of `reasoning`. */
  readonly outputInclusive: string;
  /** Attribute of the cached-input (cache read) counter. */
  readonly cacheRead: string;
  /** Attribute of the cache-write (cache creation) counter. */
  readonly cacheCreation: string;
  /** Attribute of the reasoning-output counter (a breakdown of output). */
  readonly reasoning: string;
}

/** Coerce a flattened OTLP attribute to a finite, non-negative number. codex
 *  sends some counts as strings ("14769") and some as ints (11008) on the SAME
 *  record, so both must be accepted. */
function tokenNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Resolve a flattened log record's attributes to disjoint token counts + model
 * using a tool's `LogTokenSpec`, or `null` when the record is not that event.
 *
 * `input`/`output` are made disjoint by subtracting their nested child, clamped
 * at 0 so a malformed record can never contribute a negative addend to the SUM.
 */
export function disjointTokensFromLog(
  attrs: Record<string, unknown>,
  spec: LogTokenSpec,
): (DisjointTokenCounts & { model: string }) | null {
  if (attrs['event.name'] !== spec.eventName) return null;
  if (spec.eventKind !== undefined && attrs['event.kind'] !== spec.eventKind) return null;
  const cacheRead = tokenNum(attrs[spec.cacheRead]);
  const reasoning = tokenNum(attrs[spec.reasoning]);
  const input = tokenNum(attrs[spec.inputInclusive]);
  const output = tokenNum(attrs[spec.outputInclusive]);
  const modelRaw = spec.modelAttr !== undefined ? attrs[spec.modelAttr] : undefined;
  return {
    model: typeof modelRaw === 'string' && modelRaw !== '' ? modelRaw : '(unknown)',
    input_tokens: Math.max(0, input - cacheRead),
    output_tokens: Math.max(0, output - reasoning),
    cache_read_tokens: cacheRead,
    cache_creation_tokens: tokenNum(attrs[spec.cacheCreation]),
    reasoning_output_tokens: reasoning,
  };
}
