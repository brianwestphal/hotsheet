/**
 * HS-8143 — OTLP/HTTP receiver Phase-1 tests. Phase-1 scope is:
 *
 *   - Accept JSON + protobuf content types (200 OK).
 *   - Parse JSON payloads + extract the `hotsheet_project` resource attr.
 *   - Reject malformed JSON (400).
 *   - Reject unsupported Content-Type (400).
 *   - Treat protobuf payloads as opaque bytes — log size, don't decode.
 *
 * Persistence / per-project routing / protobuf decode are Phase 2 — not
 * covered here. See docs/67-telemetry.md §67.5 + the route file's
 * file-level comment for the design.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { _testing, otelRoutes } from './otel.js';
import { _testing as _decoderTesting } from './otelDecoder.js';

function makeApp(): Hono {
  // The real server wires `otelRoutes` at `/`. Mirror that here.
  const app = new Hono();
  app.route('/', otelRoutes);
  return app;
}

const SAMPLE_METRICS_JSON = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: 'hotsheet_project', value: { stringValue: 'secret-A' } },
          { key: 'working_dir', value: { stringValue: '/tmp/proj-A' } },
        ],
      },
      scopeMetrics: [
        {
          metrics: [
            { name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 0.42, timeUnixNano: '1' }] } },
          ],
        },
      ],
    },
  ],
};

const SAMPLE_LOGS_JSON = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: 'hotsheet_project', value: { stringValue: 'secret-B' } }],
      },
      scopeLogs: [
        {
          logRecords: [
            { eventName: 'claude_code.user_prompt', body: { stringValue: 'hi' } },
          ],
        },
      ],
    },
  ],
};

const SAMPLE_TRACES_JSON = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'hotsheet_project', value: { stringValue: 'secret-C' } }],
      },
      scopeSpans: [
        {
          spans: [
            { name: 'turn', traceId: 'aaaa', spanId: 'bbbb', startTimeUnixNano: '1', endTimeUnixNano: '2' },
          ],
        },
      ],
    },
  ],
};

describe('OTLP receiver (HS-8143 / §67.5)', () => {
  describe('POST /v1/metrics', () => {
    it('accepts application/json + returns 200 with empty body', async () => {
      const app = makeApp();
      const res = await app.request('/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAMPLE_METRICS_JSON),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('');
    });

    it('accepts a valid OTLP/Protobuf metrics payload and returns 200 (HS-8471)', async () => {
      const app = makeApp();
      // Encode a real OTLP metrics request via protobufjs's encode API
      // (mirror of the Claude Code exporter's wire format).
      const Type = _decoderTesting.MetricsRequest;
      const msg = Type.create({
        resourceMetrics: [{
          resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'secret-A' } }] },
          scopeMetrics: [{
            metrics: [{ name: 'claude_code.cost.usage', gauge: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.42 }] } }],
          }],
        }],
      });
      const bytes = Type.encode(msg).finish();
      const res = await app.request('/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: bytes as BodyInit,
      });
      expect(res.status).toBe(200);
    });

    it('rejects malformed protobuf bytes with 400 (HS-8471)', async () => {
      const app = makeApp();
      // Tag 0x0a (field 1, wire type 2 = length-delimited) followed by
      // a length-prefix of 0xff which exceeds the remaining buffer →
      // malformed; protobufjs throws + the receiver returns 400.
      const res = await app.request('/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: new Uint8Array([0x0a, 0xff, 0x68, 0x65]),
      });
      expect(res.status).toBe(400);
    });

    it('rejects malformed JSON with 400', async () => {
      const app = makeApp();
      const res = await app.request('/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not valid json',
      });
      expect(res.status).toBe(400);
    });

    it('rejects unsupported Content-Type with 400', async () => {
      const app = makeApp();
      const res = await app.request('/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/logs', () => {
    it('accepts JSON and 200s', async () => {
      const app = makeApp();
      const res = await app.request('/v1/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAMPLE_LOGS_JSON),
      });
      expect(res.status).toBe(200);
    });

    it('accepts a valid OTLP/Protobuf logs payload and returns 200 (HS-8471)', async () => {
      const app = makeApp();
      const Type = _decoderTesting.LogsRequest;
      const msg = Type.create({
        resourceLogs: [{
          resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'secret-A' } }] },
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
      const res = await app.request('/v1/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: bytes as BodyInit,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /v1/traces', () => {
    it('accepts JSON and 200s', async () => {
      const app = makeApp();
      const res = await app.request('/v1/traces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAMPLE_TRACES_JSON),
      });
      expect(res.status).toBe(200);
    });

    it('accepts a valid OTLP/Protobuf traces payload and returns 200 (HS-8471)', async () => {
      const app = makeApp();
      const Type = _decoderTesting.TraceRequest;
      const msg = Type.create({
        resourceSpans: [{
          resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'secret-A' } }] },
          scopeSpans: [{
            spans: [{
              traceId: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]),
              spanId: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
              name: 'turn',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
            }],
          }],
        }],
      });
      const bytes = Type.encode(msg).finish();
      const res = await app.request('/v1/traces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: bytes as BodyInit,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('summarizeJsonPayload (HS-8143 internal)', () => {
    it('extracts hotsheet_project from a metrics payload', () => {
      const result = _testing.summarizeJsonPayload(SAMPLE_METRICS_JSON, 100);
      expect(result.hotsheetProject).toBe('secret-A');
      expect(result.resourceAttrFound).toBe(true);
      expect(result.recordCount).toBe(1);
    });

    it('extracts hotsheet_project from a logs payload', () => {
      const result = _testing.summarizeJsonPayload(SAMPLE_LOGS_JSON, 100);
      expect(result.hotsheetProject).toBe('secret-B');
      expect(result.recordCount).toBe(1);
    });

    it('extracts hotsheet_project from a traces payload', () => {
      const result = _testing.summarizeJsonPayload(SAMPLE_TRACES_JSON, 100);
      expect(result.hotsheetProject).toBe('secret-C');
      expect(result.recordCount).toBe(1);
    });

    it('returns null hotsheetProject when the resource attribute is absent', () => {
      const noAttr = { resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [] }] };
      const result = _testing.summarizeJsonPayload(noAttr, 50);
      expect(result.hotsheetProject).toBeNull();
      expect(result.resourceAttrFound).toBe(false);
      expect(result.recordCount).toBe(1);
    });

    it('handles a completely empty object without throwing', () => {
      const result = _testing.summarizeJsonPayload({}, 2);
      expect(result.recordCount).toBe(0);
      expect(result.hotsheetProject).toBeNull();
    });

    it('handles non-object inputs gracefully', () => {
      const result = _testing.summarizeJsonPayload('not an object', 14);
      expect(result.recordCount).toBe(0);
      expect(result.hotsheetProject).toBeNull();
    });
  });
});
