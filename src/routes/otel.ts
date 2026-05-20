import { Hono } from 'hono';

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
 *   - **Phase 1 (this commit)**: log a one-line summary (signal type +
 *     payload size + resource-attribute fingerprint) and return `200 OK`
 *     with empty body — OTLP convention. NO persistence. The schema
 *     landed in HS-8144 but the writer-side wiring is its own follow-up
 *     in the persistence phase (will attach `attributes_json` /
 *     `value_json` / `body_json` to insert statements once the protobuf
 *     decode lands).
 *
 *   - **Protobuf decode deferred to the persistence phase.** Phase 1
 *     reads protobuf payloads as bytes + logs the length without
 *     decoding. This is intentional — adding `@opentelemetry/otlp-transformer`
 *     (or hand-rolling protobuf decoding) is non-trivial dependency
 *     churn that pays off once we're actually persisting rows. JSON
 *     payloads are parsed in Phase 1 because they're free (the Claude
 *     Code exporter doesn't emit JSON by default but humans + tests do).
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
 * Phase-1 hello-world logger. One line to stdout per accepted payload.
 * `signalType` is one of 'metrics' / 'logs' / 'traces'.
 */
function logOtlpHello(signalType: string, summary: OtlpSummary): void {
  const project = summary.hotsheetProject ?? '(none)';
  const recordPart = summary.recordCount !== null ? ` records=${summary.recordCount}` : '';
  console.log(
    `[otel] ${signalType} ct=${summary.contentType} bytes=${summary.byteLength} project=${project}${recordPart}`,
  );
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
  logOtlpHello(signalType, summary);
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
