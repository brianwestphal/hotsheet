/**
 * HS-8471 — protobuf decoder tests + e2e round-trip from
 * protobufjs-encoded bytes → persisted rows in PGLite. Validates that
 * a Claude-Code-shaped OTLP protobuf payload (encoded via the same
 * schemas the receiver decodes) lands rows identical to what an
 * OTLP/JSON payload of the same content produces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../db/connection.js';
import { persistMetricsPayload } from '../db/otelWriters.js';
import { registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { _testing, decodeProtobufPayload } from './otelDecoder.js';

const KNOWN_SECRET = 'secret-A';
const isKnown = (s: string): boolean => s === KNOWN_SECRET;

describe('decodeProtobufPayload (HS-8471)', () => {
  it('decodes a metrics payload into OTLP/JSON shape', () => {
    const Type = _testing.MetricsRequest;
    const msg = Type.create({
      resourceMetrics: [{
        resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
        scopeMetrics: [{
          metrics: [{ name: 'claude_code.cost.usage', gauge: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.42 }] } }],
        }],
      }],
    });
    const bytes = Type.encode(msg).finish();
    const decoded = decodeProtobufPayload('metrics', bytes) as { resourceMetrics: unknown[] };
    expect(Array.isArray(decoded.resourceMetrics)).toBe(true);
    expect(decoded.resourceMetrics).toHaveLength(1);
    const rm = decoded.resourceMetrics[0] as Record<string, unknown>;
    const res = rm.resource as { attributes: Array<{ key: string; value: { stringValue: string } }> };
    expect(res.attributes[0].key).toBe('hotsheet_project');
    expect(res.attributes[0].value.stringValue).toBe(KNOWN_SECRET);
  });

  it('decodes a logs payload + extracts prompt.id from attributes', () => {
    const Type = _testing.LogsRequest;
    const msg = Type.create({
      resourceLogs: [{
        resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1700000000000000000',
            eventName: 'claude_code.user_prompt',
            body: { stringValue: 'hi' },
            attributes: [{ key: 'prompt.id', value: { stringValue: 'prompt-xyz' } }],
          }],
        }],
      }],
    });
    const bytes = Type.encode(msg).finish();
    const decoded = decodeProtobufPayload('logs', bytes) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ eventName: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> }> }> };
    expect(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].eventName).toBe('claude_code.user_prompt');
    expect(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0].key).toBe('prompt.id');
  });

  it('decodes a traces payload + normalizes traceId/spanId from base64 to hex', () => {
    const Type = _testing.TraceRequest;
    const traceBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
    const spanBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const msg = Type.create({
      resourceSpans: [{
        resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
        scopeSpans: [{
          spans: [{
            traceId: traceBytes,
            spanId: spanBytes,
            name: 'turn',
            startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000001000000000',
          }],
        }],
      }],
    });
    const bytes = Type.encode(msg).finish();
    const decoded = decodeProtobufPayload('traces', bytes) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string; parentSpanId?: string }> }> }> };
    const span = decoded.resourceSpans[0].scopeSpans[0].spans[0];
    // HS-8471's `normalizeBytesToHex` post-processes the protobufjs-default
    // base64 strings to lowercase hex — OTLP/JSON wire convention.
    expect(span.traceId).toBe('aabbccddeeff00112233445566778899');
    expect(span.spanId).toBe('0102030405060708');
  });

  it('throws on malformed protobuf bytes (caller returns 400)', () => {
    // 0x0a = field 1 wire-type 2 (length-delimited), 0xff = length 255,
    // but only 2 bytes follow — protobufjs sees the truncation + throws.
    expect(() => decodeProtobufPayload('metrics', new Uint8Array([0x0a, 0xff, 0x68, 0x65]))).toThrow();
  });
});

describe('protobuf → persistence end-to-end (HS-8471)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
    // HS-8874 — the writer routes per-resource via `getProjectBySecret(secret).dataDir`.
    // Register KNOWN_SECRET against the test DB so the persisted rows land where
    // the assertion reads them (`getDb()` = tempDir).
    registerExistingProject(tempDir, KNOWN_SECRET, await getDb());
  });

  afterEach(async () => {
    unregisterProject(KNOWN_SECRET);
    await cleanupTestDb(tempDir);
  });

  it('a protobuf metrics payload decodes + persists exactly like the equivalent JSON payload', async () => {
    const Type = _testing.MetricsRequest;
    const msg = Type.create({
      resourceMetrics: [{
        resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.cost.usage',
            gauge: {
              dataPoints: [
                { timeUnixNano: '1700000000000000000', asDouble: 0.5 },
                { timeUnixNano: '1700000060000000000', asDouble: 0.25 },
              ],
            },
          }],
        }],
      }],
    });
    const bytes = Type.encode(msg).finish();

    // Decode through the same path the receiver uses + hand to the writer.
    const decoded = decodeProtobufPayload('metrics', bytes);
    const result = await persistMetricsPayload(decoded, isKnown);

    expect(result.inserted).toBe(2);
    expect(result.dropped).toBe(0);

    const db = await getDb();
    const rows = await db.query<{ metric_name: string; value_json: { asDouble: number } }>(
      `SELECT metric_name, value_json FROM otel_metrics ORDER BY ts`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].metric_name).toBe('claude_code.cost.usage');
    expect(rows.rows[0].value_json.asDouble).toBe(0.5);
    expect(rows.rows[1].value_json.asDouble).toBe(0.25);
  });
});

describe('normalizeBytesToHex (HS-8471 helper)', () => {
  it('converts a base64 string to lowercase hex in place', () => {
    const obj: Record<string, unknown> = { traceId: 'qrvM3e7/ABEiM0RVZneImQ==' };
    _testing.normalizeBytesToHex(obj, 'traceId');
    expect(obj.traceId).toBe('aabbccddeeff00112233445566778899');
  });

  it('leaves empty strings unchanged', () => {
    const obj: Record<string, unknown> = { traceId: '' };
    _testing.normalizeBytesToHex(obj, 'traceId');
    expect(obj.traceId).toBe('');
  });

  it('leaves missing keys unchanged', () => {
    const obj: Record<string, unknown> = {};
    _testing.normalizeBytesToHex(obj, 'parentSpanId');
    expect(obj.parentSpanId).toBeUndefined();
  });
});
