import protobuf from 'protobufjs';

import { OTLP_PROTO_DEFINITION } from './otlpProtos.js';

/**
 * HS-8471 — OTLP/Protobuf decoder. Decodes the wire bytes Claude Code's
 * bundled exporter sends to `/v1/{metrics,logs,traces}` into a
 * JS-object shape that matches the OTLP/JSON wire format — same one
 * `src/db/otelWriters.ts` already consumes.
 *
 * **The point of this module is that the writers don't have to know
 * anything about protobuf.** Both content types (`application/json`
 * and `application/x-protobuf`) get normalized to the same parsed
 * object, and `persistMetricsPayload` / `persistLogsPayload` /
 * `persistTracesPayload` handle both transparently.
 *
 * Implementation:
 *
 * 1. **One-time schema parse.** The `.proto` string in
 *    `otlpProtos.ts` is parsed into a `protobuf.Root` exactly once on
 *    module load. Lookups for `ExportMetricsServiceRequest` etc. are
 *    cached as Type handles so the per-request decode is just
 *    `Type.decode(buffer).toJSON(options)`.
 *
 * 2. **`.toJSON()` options chosen to match the OTLP/JSON wire shape:**
 *    - `longs: String` — `fixed64` / `sfixed64` fields (timestamps,
 *      counts) come out as decimal strings, which is what our
 *      `unixNanoToDate` helper already expects (it does `BigInt(str)`
 *      internally).
 *    - `enums: String` — enum values as the symbol name. Note that
 *      OTLP/JSON spec emits enums as integers, but our writers don't
 *      currently read any enum fields, so the divergence is invisible
 *      — we just pick String here because human-debuggable logs are
 *      more useful than wire-format strictness in a field nothing
 *      consumes.
 *    - `bytes: String` — bytes come out as base64 strings. We
 *      post-process trace IDs + span IDs to hex (OTLP/JSON
 *      convention) before returning, so the writers store consistent
 *      values regardless of the input wire format.
 *
 * 3. **Hex conversion** for `traceId` / `spanId` / `parentSpanId`
 *    fields on spans. OTLP/JSON spec encodes these as lowercase hex
 *    (`"0123abcd..."`); protobufjs default is base64. We walk the
 *    decoded object's `resourceSpans[].scopeSpans[].spans[]` and
 *    convert in-place. Empty / missing values stay empty.
 *
 * 4. **Forward-compat.** Unknown fields in the wire bytes are
 *    silently skipped by protobufjs (standard protobuf semantics) so
 *    a future OTLP version adding fields we don't know about doesn't
 *    break decoding. We just ignore the new data.
 *
 * See `docs/67-telemetry.md` §67.5 + the file-level comment in
 * `otlpProtos.ts` for the schema scope.
 */

const root = protobuf.parse(OTLP_PROTO_DEFINITION, { keepCase: false }).root;
const MetricsRequest = root.lookupType('opentelemetry.proto.ExportMetricsServiceRequest');
const LogsRequest = root.lookupType('opentelemetry.proto.ExportLogsServiceRequest');
const TraceRequest = root.lookupType('opentelemetry.proto.ExportTraceServiceRequest');

const TO_JSON_OPTS: protobuf.IConversionOptions = {
  longs: String,
  enums: String,
  bytes: String,
};

export type SignalType = 'metrics' | 'logs' | 'traces';

/**
 * Decode an OTLP/Protobuf payload into the same JS-object shape the
 * OTLP/JSON wire format produces. Throws if the wire bytes don't
 * decode against the embedded schema — the receiver catches the
 * throw + returns `400`.
 */
export function decodeProtobufPayload(signalType: SignalType, body: Uint8Array): unknown {
  const Type = signalType === 'metrics' ? MetricsRequest
    : signalType === 'logs' ? LogsRequest
    : TraceRequest;
  const msg = Type.decode(body);
  const obj = Type.toObject(msg, TO_JSON_OPTS) as Record<string, unknown>;

  // OTLP/JSON spec uses hex strings for trace_id / span_id /
  // parent_span_id; protobufjs's `bytes: String` option gave us
  // base64. Convert in-place so downstream writers see consistent
  // values regardless of wire format.
  if (signalType === 'traces' && Array.isArray(obj.resourceSpans)) {
    for (const rs of obj.resourceSpans) {
      if (typeof rs !== 'object' || rs === null) continue;
      const scopes = (rs as Record<string, unknown>).scopeSpans;
      if (!Array.isArray(scopes)) continue;
      for (const ss of scopes) {
        if (typeof ss !== 'object' || ss === null) continue;
        const spans = (ss as Record<string, unknown>).spans;
        if (!Array.isArray(spans)) continue;
        for (const span of spans) {
          if (typeof span !== 'object' || span === null) continue;
          normalizeBytesToHex(span as Record<string, unknown>, 'traceId');
          normalizeBytesToHex(span as Record<string, unknown>, 'spanId');
          normalizeBytesToHex(span as Record<string, unknown>, 'parentSpanId');
        }
      }
    }
  }

  return obj;
}

/**
 * Convert a base64-string field in-place to lowercase hex. No-op when
 * the field is missing, empty, or already a non-string. Tolerates
 * malformed base64 by emitting an empty string (the writer will
 * subsequently drop the row since trace_id / span_id are required).
 */
function normalizeBytesToHex(obj: Record<string, unknown>, key: string): void {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') return;
  try {
    obj[key] = Buffer.from(v, 'base64').toString('hex');
  } catch {
    obj[key] = '';
  }
}

/** HS-8471 — exported for tests. NOT part of the public API. */
export const _testing = {
  MetricsRequest,
  LogsRequest,
  TraceRequest,
  normalizeBytesToHex,
};
