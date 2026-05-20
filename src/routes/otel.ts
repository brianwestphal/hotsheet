import { Hono } from 'hono';

import { persistLogsPayload, persistMetricsPayload, persistTracesPayload } from '../db/otelWriters.js';
import { getProjectBySecret } from '../projects.js';
import type { AppEnv } from '../types.js';

/**
 * HS-8143 — OTLP/HTTP receiver foundation (Phase 1: hello-world).
 *
 * Three routes (`POST /v1/metrics` / `/v1/logs` / `/v1/traces`) accept
 * payloads from Claude Code's bundled OTLP exporter when a terminal
 * Hot Sheet spawned is running `claude` with `CLAUDE_CODE_ENABLE_TELEMETRY=1`
 * + the OTLP env vars (see HS-8145 / §67.3 for the spawn-env injection that
 * makes that happen).
 *
 * Per docs/67-telemetry.md §67.5 the design is:
 *
 *   - **Same-port topology** (decision §67.4) — these routes live on the
 *     main Hono server's port. The spawn-env's
 *     `OTEL_EXPORTER_OTLP_ENDPOINT` points at `http://localhost:<mainPort>`.
 *
 *   - **Both content types accepted**: `application/x-protobuf` (Claude
 *     Code's default exporter format) and `application/json` (humans +
 *     curl + tests).
 *
 *   - **Phase 1 (HS-8143)**: log a one-line summary and return `200 OK`.
 *     No persistence.
 *   - **Phase 2 (HS-8470, this commit extends here)**: JSON payloads
 *     are now persisted to `otel_metrics` / `otel_events` /
 *     `otel_spans` via `src/db/otelWriters.ts`. The receiver still
 *     returns `200 OK` regardless of how many records actually landed
 *     (drops on unknown `hotsheet_project` are logged but not surfaced
 *     to the client — OTLP retry-storm avoidance).
 *
 *   - **Protobuf decode deferred to Phase 2b** (separate follow-up
 *     ticket after HS-8470 lands). Phase 2 + Phase 1 read protobuf
 *     payloads as opaque bytes + log the length without decoding.
 *     This is intentional — adding `@opentelemetry/otlp-transformer`
 *     (or hand-rolling protobuf decoding) only pays off once the
 *     persistence + rollup-query path is proven against JSON shape.
 *     Phase 2b will simply decode protobuf into the same JSON-shaped
 *     object the writers in `otelWriters.ts` already handle.
 *
 *   - **Security model** (§67.8): localhost-bind already means foreign
 *     hosts can't reach the receiver. The real anti-pollution gate is
 *     the `hotsheet_project` resource-attribute check — payloads with
 *     no `hotsheet_project` attribute, or a value that doesn't match a
 *     known project secret, are dropped. (Implementation of the
 *     project-secret lookup lands in the persistence phase — Phase 1
 *     just logs whether the resource attribute was present.) We do NOT
 *     mirror the `/api/*` `X-Hotsheet-Secret` middleware because OTLP
 *     clients (Claude Code's bundled exporter) won't send that header
 *     — the secret-routing model replaces it.
 *
 *   - **OTLP success contract**: every successful response is `200 OK`
 *     with empty body. Even when we drop a payload (unknown
 *     `hotsheet_project`) we return `200` to avoid OTLP retry storms
 *     from misconfigured upstream exporters. Failures the client should
 *     fix (malformed payload, wrong Content-Type) return `400`.
 */
export const otelRoutes = new Hono<AppEnv>();

const SIGNAL_PROTOBUF = 'application/x-protobuf' as const;
const SIGNAL_JSON = 'application/json' as const;

interface OtlpSummary {
  contentType: string;
  byteLength: number;
  resourceAttrFound: boolean;
  hotsheetProject: string | null;
  recordCount: number | null;
}

/**
 * Phase-1 summary builder. For JSON payloads, parses + counts records +
 * extracts the first `hotsheet_project` resource attribute it can find.
 * For protobuf payloads, just reports byte length — decoding is deferred
 * to the persistence phase per the file-level comment.
 *
 * Returns `null` if the payload is malformed (caller returns `400`).
 */
function summarizeOtlpPayload(contentType: string, body: ArrayBuffer): OtlpSummary | null {
  const byteLength = body.byteLength;

  if (contentType.startsWith(SIGNAL_JSON)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return null;
    }
    return summarizeJsonPayload(parsed, byteLength);
  }

  if (contentType.startsWith(SIGNAL_PROTOBUF)) {
    return {
      contentType: SIGNAL_PROTOBUF,
      byteLength,
      resourceAttrFound: false, // unknowable without decoding
      hotsheetProject: null,
      recordCount: null,
    };
  }

  return null;
}

/**
 * OTLP/JSON record shape is `{ resourceMetrics: [...] }` for metrics,
 * `{ resourceLogs: [...] }` for logs, `{ resourceSpans: [...] }` for
 * traces. Each top-level array entry has a `resource.attributes`
 * key-value list. We walk down to find the `hotsheet_project`
 * attribute. The traversal is shape-tolerant — malformed payloads
 * return a summary with `recordCount: 0`.
 */
function summarizeJsonPayload(parsed: unknown, byteLength: number): OtlpSummary {
  let hotsheetProject: string | null = null;
  let recordCount = 0;

  if (typeof parsed === 'object' && parsed !== null) {
    const root = parsed as Record<string, unknown>;
    for (const key of ['resourceMetrics', 'resourceLogs', 'resourceSpans']) {
      const arr = root[key];
      if (!Array.isArray(arr)) continue;
      recordCount += arr.length;
      for (const entry of arr) {
        if (typeof entry !== 'object' || entry === null) continue;
        const resource = (entry as Record<string, unknown>).resource;
        if (typeof resource !== 'object' || resource === null) continue;
        const attrs = (resource as Record<string, unknown>).attributes;
        if (!Array.isArray(attrs)) continue;
        for (const a of attrs) {
          if (typeof a !== 'object' || a === null) continue;
          const aR = a as Record<string, unknown>;
          if (aR.key === 'hotsheet_project') {
            const v = aR.value as { stringValue?: unknown } | undefined;
            if (v !== undefined && typeof v.stringValue === 'string') {
              hotsheetProject = v.stringValue;
            }
          }
        }
      }
    }
  }

  return {
    contentType: SIGNAL_JSON,
    byteLength,
    resourceAttrFound: hotsheetProject !== null,
    hotsheetProject,
    recordCount,
  };
}

/**
 * One-line stdout log per accepted payload. HS-8470 extends the
 * Phase-1 shape with `inserted=N dropped=N` so the persistence
 * outcome is visible in logs without grepping the DB.
 */
function logOtlp(signalType: string, summary: OtlpSummary, persist: { inserted: number; dropped: number } | null): void {
  const project = summary.hotsheetProject ?? '(none)';
  const recordPart = summary.recordCount !== null ? ` records=${summary.recordCount}` : '';
  const persistPart = persist !== null ? ` inserted=${persist.inserted} dropped=${persist.dropped}` : '';
  console.log(
    `[otel] ${signalType} ct=${summary.contentType} bytes=${summary.byteLength} project=${project}${recordPart}${persistPart}`,
  );
}

/**
 * HS-8470 — JSON payload persistence dispatch. Calls the writer for
 * the matching signal type. Returns `null` for protobuf payloads
 * (Phase 2b will handle those). The `isKnownProject` lookup gates
 * the §67.5.3 anti-pollution drop — `getProjectBySecret` returns
 * `undefined` for an unknown secret.
 */
async function persistJsonPayload(
  signalType: 'metrics' | 'logs' | 'traces',
  parsed: unknown,
): Promise<{ inserted: number; dropped: number }> {
  const isKnownProject = (s: string): boolean => getProjectBySecret(s) !== undefined;
  if (signalType === 'metrics') return persistMetricsPayload(parsed, isKnownProject);
  if (signalType === 'logs') return persistLogsPayload(parsed, isKnownProject);
  return persistTracesPayload(parsed, isKnownProject);
}

async function handleOtlpRoute(c: { req: { header: (n: string) => string | undefined; arrayBuffer: () => Promise<ArrayBuffer> }; body: (s: string | null, init?: { status: number }) => Response }, signalType: 'metrics' | 'logs' | 'traces'): Promise<Response> {
  const contentType = c.req.header('Content-Type') ?? '';
  let body: ArrayBuffer;
  try {
    body = await c.req.arrayBuffer();
  } catch {
    return c.body(null, { status: 400 });
  }
  const summary = summarizeOtlpPayload(contentType, body);
  if (summary === null) {
    return c.body(null, { status: 400 });
  }

  // HS-8470 — Phase 2 persistence. JSON payloads get parsed-and-written;
  // protobuf payloads still flow through (Phase 1 shape) — Phase 2b
  // will decode them and call the same writers.
  let persist: { inserted: number; dropped: number } | null = null;
  if (summary.contentType === SIGNAL_JSON) {
    try {
      // Safe to re-parse — `summarizeOtlpPayload` already validated the JSON.
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      persist = await persistJsonPayload(signalType, parsed);
    } catch (err) {
      // Persistence failure is logged but doesn't surface as a 5xx —
      // OTLP retry-storm avoidance. The receiver still returns 200.
      console.debug('[otel] persistence failed:', err);
    }
  }

  logOtlp(signalType, summary, persist);
  // OTLP convention: 200 with empty body. Even on a dropped payload
  // (unknown hotsheet_project) we still return 200 to avoid client
  // retry storms — drops are logged but not surfaced to the client.
  return c.body(null, { status: 200 });
}

otelRoutes.post('/v1/metrics', (c) => handleOtlpRoute(c, 'metrics'));
otelRoutes.post('/v1/logs', (c) => handleOtlpRoute(c, 'logs'));
otelRoutes.post('/v1/traces', (c) => handleOtlpRoute(c, 'traces'));

/** HS-8143 — exported for tests. NOT part of the public API. */
export const _testing = {
  summarizeOtlpPayload,
  summarizeJsonPayload,
};
