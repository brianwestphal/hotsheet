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

    it('accepts application/x-protobuf as opaque bytes + returns 200', async () => {
      const app = makeApp();
      // Phase 1: protobuf bytes are not decoded. Any bytestream of the
      // declared content type produces a 200.
      const res = await app.request('/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: new Uint8Array([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
      });
      expect(res.status).toBe(200);
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

    it('accepts protobuf-content-type and 200s', async () => {
      const app = makeApp();
      const res = await app.request('/v1/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: new Uint8Array([0x0a, 0x01]),
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

    it('accepts protobuf-content-type and 200s', async () => {
      const app = makeApp();
      const res = await app.request('/v1/traces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: new Uint8Array([0x0a, 0x01]),
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
