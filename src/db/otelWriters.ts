import { getProjectBySecret } from '../projects.js';
import { centralTelemetryDataDir, getDbForDir } from './connection.js';

/**
 * HS-8470 — OTLP persistence layer. Phase 2 of HS-8143's receiver work.
 * Phase 1 (HS-8143) parsed OTLP/JSON payloads and logged a one-line
 * summary; this phase actually writes parsed payloads to the
 * `otel_metrics` / `otel_events` / `otel_spans` schema landed under
 * HS-8144 (§67.6).
 *
 * Three pure-ish writers (`persistMetricsPayload` / `persistLogsPayload`
 * / `persistTracesPayload`) each take:
 *
 *   - `parsed: unknown` — the JSON-decoded OTLP payload. Shape-tolerant
 *     traversal mirrors what `src/routes/otel.ts::summarizeJsonPayload`
 *     already does, except we go deeper (each `resourceMetrics[].scopeMetrics[].metrics[].dataPoints[]`
 *     becomes one row).
 *   - `isKnownProject: (secret) => boolean` — the §67.5.3 anti-pollution
 *     gate. Resource entries whose `hotsheet_project` attr isn't a
 *     registered project are dropped (their `inserted` count is zero,
 *     their entries contribute to `dropped` instead).
 *
 * Returns `{ inserted, dropped }` so the receiver's stdout log can
 * report both counts. Per-row malformed entries are dropped (logged
 * once per row at debug level — `console.debug`) and the writer
 * continues with the next entry; no exceptions surface to the
 * receiver because OTLP convention is to return `200 OK` regardless.
 *
 * **Protobuf payloads are not handled here.** A future Phase 2b will
 * add protobuf decoding (either via `@opentelemetry/otlp-transformer`
 * or a hand-rolled decoder) and pass the decoded JSON-shaped object
 * straight into these writers — no writer changes needed.
 *
 * **Per-project store (HS-8874).** Each OTLP resource is routed to a DB by
 * its `hotsheet_project` attr: a KNOWN project's rows go to THAT project's own
 * `<dataDir>/db`; rows with NO `hotsheet_project` attr go to the centralized
 * store (`~/.hotsheet/telemetry`); rows for an UNKNOWN project are DROPPED
 * (the §67.5.3 anti-pollution gate). Rows still carry the `project_secret`
 * column (NULL for central rows). The target DB is resolved PER RESOURCE via
 * `telemetryDataDirForSecret` + `getDbForDir`, replacing the pre-HS-8874
 * single shared store (`getTelemetryDb()` of the launch-default project).
 *
 * See docs/67-telemetry.md §67.5 + §67.6 for the full design.
 */

export interface PersistResult {
  inserted: number;
  dropped: number;
}

/**
 * Convert an OTLP `*UnixNano` field (string of decimal digits, picoseconds
 * unused since the OTLP spec says nanoseconds) to a JS Date suitable
 * for the `TIMESTAMPTZ` columns. The 1 ms precision loss is documented
 * in §67.6 — PGLite's `TIMESTAMPTZ` ms-precision is sufficient for
 * the rollups we render.
 *
 * Returns `null` if the input is missing or not numeric — the caller
 * drops the row in that case.
 */
function unixNanoToDate(nano: unknown): Date | null {
  if (typeof nano !== 'string' && typeof nano !== 'number') return null;
  try {
    const big = BigInt(String(nano));
    const ms = Number(big / 1_000_000n);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  } catch {
    return null;
  }
}

/**
 * Walk an OTLP `attributes` array of `{key, value}` pairs and produce a
 * flat string-keyed map of the values. OTLP wraps every value in a
 * one-key `AnyValue` shape (`stringValue` / `intValue` / `doubleValue`
 * / `boolValue` / `arrayValue` / `kvlistValue` / `bytesValue`). We
 * unwrap the scalars and pass arrays / kvlists through as-is.
 *
 * Returns `{}` for missing or malformed attribute lists — never throws.
 */
function flattenAttributes(attrs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs) {
    if (typeof a !== 'object' || a === null) continue;
    const aR = a as Record<string, unknown>;
    if (typeof aR.key !== 'string') continue;
    const v = aR.value;
    if (typeof v !== 'object' || v === null) {
      out[aR.key] = v;
      continue;
    }
    const vR = v as Record<string, unknown>;
    if (typeof vR.stringValue === 'string') { out[aR.key] = vR.stringValue; continue; }
    if (typeof vR.intValue === 'string' || typeof vR.intValue === 'number') { out[aR.key] = vR.intValue; continue; }
    if (typeof vR.doubleValue === 'number') { out[aR.key] = vR.doubleValue; continue; }
    if (typeof vR.boolValue === 'boolean') { out[aR.key] = vR.boolValue; continue; }
    if (Array.isArray(vR.arrayValue)) { out[aR.key] = vR.arrayValue; continue; }
    if (typeof vR.kvlistValue === 'object') { out[aR.key] = vR.kvlistValue; continue; }
    if (typeof vR.bytesValue === 'string') { out[aR.key] = vR.bytesValue; continue; }
    out[aR.key] = vR;
  }
  return out;
}

interface ResourceContext {
  /** HS-8874 — NULL means "no `hotsheet_project` attr" → route to the central
   *  store; a non-null secret is a known, registered project. */
  projectSecret: string | null;
  sessionId: string | null;
  resourceAttrs: Record<string, unknown>;
}

/**
 * HS-8874 — sentinel for "this resource named a project that ISN'T currently
 * registered" — the §67.5.3 anti-pollution drop. Distinct from `null`, which
 * is reserved for a malformed resource (also a drop, but counted the same way
 * by the caller).
 */
type ResolveResult = ResourceContext | 'drop' | null;

/**
 * Extract the routing-relevant resource attributes from an OTLP resource entry.
 * Three outcomes (HS-8874):
 *   - malformed resource (not an object) → `null` (caller drops),
 *   - no `hotsheet_project` attr → `{ projectSecret: null, … }` (route CENTRAL),
 *   - `hotsheet_project` present but NOT a known project → `'drop'` (caller
 *     drops; preserves the anti-pollution gate),
 *   - a known project → `{ projectSecret: <secret>, … }`.
 */
function resolveResource(
  resource: unknown,
  isKnownProject: (s: string) => boolean,
): ResolveResult {
  if (typeof resource !== 'object' || resource === null) return null;
  const attrs = (resource as Record<string, unknown>).attributes;
  const flat = flattenAttributes(attrs);
  const projectSecret = flat['hotsheet_project'];
  const sessionId = typeof flat['session.id'] === 'string'
    ? flat['session.id']
    : null;
  if (typeof projectSecret !== 'string' || projectSecret === '') {
    // No project attr → centralized store.
    return { projectSecret: null, sessionId, resourceAttrs: flat };
  }
  if (!isKnownProject(projectSecret)) return 'drop';
  return { projectSecret, sessionId, resourceAttrs: flat };
}

/**
 * HS-8874 — map a resolved row's `project_secret` to the dataDir of the DB it
 * should be written to / read from. A null secret (no `hotsheet_project`) → the
 * centralized store; a known project → its own dataDir; an (unexpected)
 * un-registered secret also falls back to central rather than throwing.
 * Lives here (not in `connection.ts`) so the project lookup stays out of the
 * connection module and no import cycle forms.
 */
function telemetryDataDirForSecret(secret: string | null): string {
  if (secret === null) return centralTelemetryDataDir();
  const p = getProjectBySecret(secret);
  return p !== undefined ? p.dataDir : centralTelemetryDataDir();
}

/**
 * HS-8470 — metrics writer. Walks
 * `resourceMetrics[].scopeMetrics[].metrics[]` and inserts one row per
 * metric's data points into `otel_metrics`. Each data point is
 * serialized whole into `value_json` so sum / gauge / histogram /
 * exponentialHistogram all round-trip without per-type column
 * mapping.
 */
export async function persistMetricsPayload(
  parsed: unknown,
  isKnownProject: (s: string) => boolean,
): Promise<PersistResult> {
  let inserted = 0;
  let dropped = 0;

  if (typeof parsed !== 'object' || parsed === null) return { inserted, dropped };
  const root = parsed as Record<string, unknown>;
  const resources = root['resourceMetrics'];
  if (!Array.isArray(resources)) return { inserted, dropped };

  for (const entry of resources) {
    if (typeof entry !== 'object' || entry === null) continue;
    const eR = entry as Record<string, unknown>;
    const resCtx = resolveResource(eR.resource, isKnownProject);
    if (resCtx === null || resCtx === 'drop') {
      const scopes = Array.isArray(eR.scopeMetrics) ? eR.scopeMetrics : [];
      for (const sm of scopes) {
        const ms = Array.isArray((sm as Record<string, unknown> | null)?.metrics)
          ? (sm as { metrics: unknown[] }).metrics
          : [];
        for (const m of ms) {
          const points = collectDataPoints(m);
          dropped += points.length;
        }
      }
      continue;
    }

    // HS-8874 — resolve the target DB from THIS resource's secret (project DB
    // for a known project, central for a no-project row).
    const db = await getDbForDir(telemetryDataDirForSecret(resCtx.projectSecret));
    const scopes = Array.isArray(eR.scopeMetrics) ? eR.scopeMetrics : [];
    for (const sm of scopes) {
      if (typeof sm !== 'object' || sm === null) continue;
      const metrics = (sm as Record<string, unknown>).metrics;
      if (!Array.isArray(metrics)) continue;
      for (const m of metrics) {
        if (typeof m !== 'object' || m === null) continue;
        const mR = m as Record<string, unknown>;
        const metricName = typeof mR.name === 'string' ? mR.name : null;
        if (metricName === null) { dropped += collectDataPoints(m).length; continue; }
        const points = collectDataPoints(m);
        // HS-8600 — capture the metric-level aggregation temporality +
        // isMonotonic so each row records whether it's a DELTA increment
        // (safe to SUM) or a CUMULATIVE running total (summing re-inflates —
        // the HS-8599 overcount). `warnIfCumulativeCounter` surfaces the
        // first cumulative monotonic cost/token counter as a stderr warning
        // so a future config that re-enables cumulative export is visible
        // instead of silently wrong.
        const agg = extractMetricAggregation(m);
        warnIfCumulativeCounter(metricName, agg);
        for (const point of points) {
          const ts = unixNanoToDate(point.timeUnixNano);
          if (ts === null) { dropped++; continue; }
          const attrs = flattenAttributes(point.attributes);
          // HS-8514 — Claude Code's exporter stamps `session.id` on
          // the per-data-point attributes, NOT the resource. Prefer
          // the data-point value when the resource didn't carry one
          // so the `session_id` column gets populated for downstream
          // session-count proxies.
          const sessionId = resCtx.sessionId ??
            (typeof attrs['session.id'] === 'string' ? attrs['session.id'] : null);
          try {
            await db.query(
              `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
              [ts, resCtx.projectSecret, sessionId, metricName, JSON.stringify(attrs), JSON.stringify(point), agg.temporality, agg.isMonotonic],
            );
            inserted++;
          } catch (err) {
            console.debug('[otel] metrics insert failed:', err);
            dropped++;
          }
        }
      }
    }
  }

  return { inserted, dropped };
}

interface DataPoint {
  timeUnixNano?: unknown;
  attributes?: unknown;
  [k: string]: unknown;
}

/**
 * OTLP metrics have data points nested under one of `sum.dataPoints` /
 * `gauge.dataPoints` / `histogram.dataPoints` / `exponentialHistogram.dataPoints`
 * / `summary.dataPoints`. This walks all of them and returns the flat
 * list of data-point objects (which the writer then serializes whole
 * into `value_json`).
 */
function collectDataPoints(metric: unknown): DataPoint[] {
  if (typeof metric !== 'object' || metric === null) return [];
  const mR = metric as Record<string, unknown>;
  const out: DataPoint[] = [];
  for (const wrapper of ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']) {
    const w = mR[wrapper];
    if (typeof w !== 'object' || w === null) continue;
    const dps = (w as Record<string, unknown>).dataPoints;
    if (!Array.isArray(dps)) continue;
    for (const dp of dps) {
      if (typeof dp === 'object' && dp !== null) {
        out.push(dp as DataPoint);
      }
    }
  }
  return out;
}

export interface MetricAggregation {
  /** `'delta'` (each export carries the increment — safe to SUM), `'cumulative'`
   *  (each export carries the running total — SUMming re-inflates), or `null`
   *  when the metric type has no temporality (gauge / summary) or it's
   *  unknown / unspecified. */
  temporality: 'delta' | 'cumulative' | null;
  /** Whether the counter is monotonic (only sums carry this). `null` for
   *  gauges / summaries. Combined with `cumulative`, a monotonic cumulative
   *  counter is the shape that produced the HS-8599 18–60× overcount. */
  isMonotonic: boolean | null;
}

/**
 * HS-8600 — read the OTLP metric-level `aggregationTemporality` + `isMonotonic`
 * off whichever wrapper carries them (`sum` / `histogram` / `exponentialHistogram`;
 * `gauge` + `summary` have neither). Normalizes the temporality enum from
 * either the numeric form (1 = DELTA, 2 = CUMULATIVE per the OTLP spec) or the
 * protobuf-JSON string form (`AGGREGATION_TEMPORALITY_DELTA` / `…_CUMULATIVE`)
 * into `'delta'` / `'cumulative'`. Anything else (0 / UNSPECIFIED / missing /
 * a gauge) → `null`. Pure; exported for unit-testing.
 */
export function extractMetricAggregation(metric: unknown): MetricAggregation {
  if (typeof metric !== 'object' || metric === null) return { temporality: null, isMonotonic: null };
  const mR = metric as Record<string, unknown>;
  for (const wrapper of ['sum', 'histogram', 'exponentialHistogram'] as const) {
    const w = mR[wrapper];
    if (typeof w !== 'object' || w === null) continue;
    const wR = w as Record<string, unknown>;
    const raw = wR.aggregationTemporality;
    let temporality: 'delta' | 'cumulative' | null = null;
    if (raw === 1 || raw === '1' || raw === 'AGGREGATION_TEMPORALITY_DELTA') temporality = 'delta';
    else if (raw === 2 || raw === '2' || raw === 'AGGREGATION_TEMPORALITY_CUMULATIVE') temporality = 'cumulative';
    const isMonotonic = typeof wR.isMonotonic === 'boolean' ? wR.isMonotonic : null;
    return { temporality, isMonotonic };
  }
  return { temporality: null, isMonotonic: null };
}

/** HS-8600 — the metrics the dashboards SUM (so a cumulative monotonic source
 *  re-inflates their totals — see HS-8599). */
const SUMMED_COUNTER_METRICS = new Set(['claude_code.cost.usage', 'claude_code.token.usage']);

/** HS-8600 — module-once guard so the warning isn't emitted per data point. */
let warnedCumulativeCounter = false;

/**
 * HS-8600 — surface the first cumulative monotonic cost/token counter as a
 * stderr warning. HS-8599 forces `delta` temporality in the spawn env so Hot
 * Sheet's own `claude` runs never hit this; the guard exists so a future
 * telemetry source (different Claude Code version, a non-default config,
 * another tool) that emits cumulative counters becomes VISIBLE instead of
 * silently re-introducing the 18–60× SUM overcount. Resettable for tests.
 */
export function warnIfCumulativeCounter(metricName: string, agg: MetricAggregation): void {
  if (warnedCumulativeCounter) return;
  if (agg.temporality !== 'cumulative') return;
  if (agg.isMonotonic !== true) return;
  if (!SUMMED_COUNTER_METRICS.has(metricName)) return;
  warnedCumulativeCounter = true;
  console.warn(
    `[otel] WARNING: received a CUMULATIVE monotonic counter for "${metricName}". `
    + `The dashboards SUM these rows, which is only correct for DELTA temporality — `
    + `cumulative rows re-inflate cost/token totals (HS-8599 / HS-8600). Hot Sheet's own `
    + `spawn env forces delta, so this implies a different telemetry source. The `
    + `aggregation_temporality column now records this; rows can be filtered/repaired.`,
  );
}

/**
 * HS-8470 — logs writer. Walks
 * `resourceLogs[].scopeLogs[].logRecords[]` and inserts one row per
 * log record into `otel_events`. The `event_name` is sourced from
 * either `record.eventName` (newer OTLP) or `record.attributes['event.name']`
 * (older); falls back to `'log'` when neither is present. `prompt_id`
 * is sourced from the log record's attributes when present (Claude
 * Code stamps it on `user_prompt` / `api_request` / `tool_result`
 * records). The full record (incl. body + severity) goes into
 * `body_json`.
 */
export async function persistLogsPayload(
  parsed: unknown,
  isKnownProject: (s: string) => boolean,
): Promise<PersistResult> {
  let inserted = 0;
  let dropped = 0;

  if (typeof parsed !== 'object' || parsed === null) return { inserted, dropped };
  const root = parsed as Record<string, unknown>;
  const resources = root['resourceLogs'];
  if (!Array.isArray(resources)) return { inserted, dropped };

  for (const entry of resources) {
    if (typeof entry !== 'object' || entry === null) continue;
    const eR = entry as Record<string, unknown>;
    const resCtx = resolveResource(eR.resource, isKnownProject);
    if (resCtx === null || resCtx === 'drop') {
      dropped += countLogRecords(eR);
      continue;
    }

    // HS-8874 — per-resource target DB.
    const db = await getDbForDir(telemetryDataDirForSecret(resCtx.projectSecret));
    const scopes = Array.isArray(eR.scopeLogs) ? eR.scopeLogs : [];
    for (const sl of scopes) {
      if (typeof sl !== 'object' || sl === null) continue;
      const records = (sl as Record<string, unknown>).logRecords;
      if (!Array.isArray(records)) continue;
      for (const rec of records) {
        if (typeof rec !== 'object' || rec === null) { dropped++; continue; }
        const rR = rec as Record<string, unknown>;
        const ts = unixNanoToDate(rR.timeUnixNano ?? rR.observedTimeUnixNano);
        if (ts === null) { dropped++; continue; }
        const attrs = flattenAttributes(rR.attributes);
        const eventName = typeof rR.eventName === 'string' ? rR.eventName
          : typeof attrs['event.name'] === 'string' ? attrs['event.name']
          : 'log';
        const promptId = typeof attrs['prompt.id'] === 'string'
          ? attrs['prompt.id']
          : null;
        // HS-8514 / HS-8639 — same as the metrics writer: Claude Code stamps
        // `session.id` on the per-record attributes, not the resource (the
        // `/api/telemetry/_debug` paste showed `distinctSessions: 0` because
        // this column was always taking the null resource value). Prefer the
        // record attribute when the resource didn't carry one.
        const sessionId = resCtx.sessionId ??
          (typeof attrs['session.id'] === 'string' ? attrs['session.id'] : null);
        try {
          await db.query(
            `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
            [ts, resCtx.projectSecret, sessionId, promptId, eventName, JSON.stringify(attrs), JSON.stringify(rec)],
          );
          inserted++;
        } catch (err) {
          console.debug('[otel] logs insert failed:', err);
          dropped++;
        }
      }
    }
  }

  return { inserted, dropped };
}

function countLogRecords(entry: Record<string, unknown>): number {
  const scopes = Array.isArray(entry.scopeLogs) ? entry.scopeLogs : [];
  let n = 0;
  for (const sl of scopes) {
    const records = (sl as Record<string, unknown> | null)?.logRecords;
    if (Array.isArray(records)) n += records.length;
  }
  return n;
}

/**
 * HS-8470 — traces writer. Walks `resourceSpans[].scopeSpans[].spans[]`
 * and inserts one row per span into `otel_spans`. Spans carry their
 * own `traceId` / `spanId` / `parentSpanId` (hex strings per the OTLP
 * spec — passed through to PGLite as-is). `start_ts` / `end_ts` come
 * from `startTimeUnixNano` / `endTimeUnixNano`. `prompt_id` is sourced
 * from the span attributes when Claude Code stamps it.
 */
export async function persistTracesPayload(
  parsed: unknown,
  isKnownProject: (s: string) => boolean,
): Promise<PersistResult> {
  let inserted = 0;
  let dropped = 0;

  if (typeof parsed !== 'object' || parsed === null) return { inserted, dropped };
  const root = parsed as Record<string, unknown>;
  const resources = root['resourceSpans'];
  if (!Array.isArray(resources)) return { inserted, dropped };

  for (const entry of resources) {
    if (typeof entry !== 'object' || entry === null) continue;
    const eR = entry as Record<string, unknown>;
    const resCtx = resolveResource(eR.resource, isKnownProject);
    if (resCtx === null || resCtx === 'drop') {
      dropped += countSpans(eR);
      continue;
    }

    // HS-8874 — per-resource target DB.
    const db = await getDbForDir(telemetryDataDirForSecret(resCtx.projectSecret));
    const scopes = Array.isArray(eR.scopeSpans) ? eR.scopeSpans : [];
    for (const ss of scopes) {
      if (typeof ss !== 'object' || ss === null) continue;
      const spans = (ss as Record<string, unknown>).spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        if (typeof span !== 'object' || span === null) { dropped++; continue; }
        const sR = span as Record<string, unknown>;
        const traceId = typeof sR.traceId === 'string' ? sR.traceId : null;
        const spanId = typeof sR.spanId === 'string' ? sR.spanId : null;
        const startTs = unixNanoToDate(sR.startTimeUnixNano);
        const endTs = unixNanoToDate(sR.endTimeUnixNano);
        if (traceId === null || spanId === null || startTs === null || endTs === null) {
          dropped++;
          continue;
        }
        const parentSpanId = typeof sR.parentSpanId === 'string' && sR.parentSpanId !== '' ? sR.parentSpanId : null;
        const spanName = typeof sR.name === 'string' ? sR.name : 'span';
        const attrs = flattenAttributes(sR.attributes);
        const promptId = typeof attrs['prompt.id'] === 'string' ? attrs['prompt.id'] : null;
        // HS-8514 / HS-8639 — prefer the span's own `session.id` attribute when
        // the resource didn't carry one (mirrors the metrics + events writers).
        const sessionId = resCtx.sessionId ??
          (typeof attrs['session.id'] === 'string' ? attrs['session.id'] : null);
        const status = sR.status as Record<string, unknown> | undefined;
        const statusCode = status !== undefined && typeof status.code === 'string'
          ? status.code
          : (status !== undefined && typeof status.code === 'number' ? String(status.code) : null);

        try {
          await db.query(
            `INSERT INTO otel_spans
               (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
            [traceId, spanId, parentSpanId, resCtx.projectSecret, sessionId, promptId, spanName, startTs, endTs, JSON.stringify(attrs), statusCode],
          );
          inserted++;
        } catch (err) {
          console.debug('[otel] spans insert failed:', err);
          dropped++;
        }
      }
    }
  }

  return { inserted, dropped };
}

function countSpans(entry: Record<string, unknown>): number {
  const scopes = Array.isArray(entry.scopeSpans) ? entry.scopeSpans : [];
  let n = 0;
  for (const ss of scopes) {
    const spans = (ss as Record<string, unknown> | null)?.spans;
    if (Array.isArray(spans)) n += spans.length;
  }
  return n;
}

/** HS-8470 — exported for tests. NOT part of the public API. */
export const _testing = {
  unixNanoToDate,
  flattenAttributes,
  resolveResource,
  collectDataPoints,
  extractMetricAggregation,
  warnIfCumulativeCounter,
  /** HS-8600 — reset the module-once cumulative-counter warn guard so each
   *  test starts fresh. */
  resetCumulativeWarnForTesting(): void { warnedCumulativeCounter = false; },
};
