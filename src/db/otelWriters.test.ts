/**
 * HS-8470 — OTLP persistence writer tests. Insert/SELECT round-trips
 * for all three signal types + the §67.5.3 drop-on-unknown-project
 * anti-pollution gate + per-row malformed-entry handling.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getDb } from './connection.js';
import {
  _testing,
  persistLogsPayload,
  persistMetricsPayload,
  persistTracesPayload,
} from './otelWriters.js';

const KNOWN_SECRET = 'secret-known-A';
const isKnownProject = (s: string): boolean => s === KNOWN_SECRET;

const SAMPLE_METRICS_JSON = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } },
          { key: 'session.id', value: { stringValue: 'session-1' } },
        ],
      },
      scopeMetrics: [
        {
          metrics: [
            {
              name: 'claude_code.cost.usage',
              sum: {
                dataPoints: [
                  {
                    timeUnixNano: '1700000000000000000',
                    asDouble: 0.42,
                    attributes: [
                      { key: 'model', value: { stringValue: 'sonnet-4' } },
                    ],
                  },
                  {
                    timeUnixNano: '1700000060000000000',
                    asDouble: 0.18,
                    attributes: [],
                  },
                ],
              },
            },
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
        attributes: [
          { key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } },
          { key: 'session.id', value: { stringValue: 'session-1' } },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              eventName: 'claude_code.user_prompt',
              body: { stringValue: 'hi there' },
              attributes: [
                { key: 'prompt.id', value: { stringValue: 'prompt-xyz' } },
              ],
            },
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
        attributes: [
          { key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } },
          { key: 'session.id', value: { stringValue: 'session-1' } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'trace-root-abc',
              spanId: 'span-root',
              name: 'turn',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 'OK' },
              attributes: [
                { key: 'prompt.id', value: { stringValue: 'prompt-xyz' } },
              ],
            },
            {
              traceId: 'trace-root-abc',
              spanId: 'span-child',
              parentSpanId: 'span-root',
              name: 'llm.request',
              startTimeUnixNano: '1700000000100000000',
              endTimeUnixNano: '1700000000900000000',
              status: { code: 'OK' },
              attributes: [],
            },
          ],
        },
      ],
    },
  ],
};

describe('OTLP persistence writers (HS-8470 / §67.5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb(tempDir);
  });

  describe('persistMetricsPayload', () => {
    it('writes one row per data point for a known project', async () => {
      const result = await persistMetricsPayload(SAMPLE_METRICS_JSON, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(0);

      const db = await getDb();
      const rows = await db.query<{ metric_name: string; project_secret: string; session_id: string; value_json: { asDouble: number } }>(
        `SELECT metric_name, project_secret, session_id, value_json FROM otel_metrics ORDER BY ts`,
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].metric_name).toBe('claude_code.cost.usage');
      expect(rows.rows[0].project_secret).toBe(KNOWN_SECRET);
      expect(rows.rows[0].session_id).toBe('session-1');
      expect(rows.rows[0].value_json.asDouble).toBe(0.42);
      expect(rows.rows[1].value_json.asDouble).toBe(0.18);
    });

    it('drops every row when the resource is for an unknown project', async () => {
      const unknown = {
        resourceMetrics: [
          {
            resource: {
              attributes: [{ key: 'hotsheet_project', value: { stringValue: 'secret-unknown' } }],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.cost.usage',
                    sum: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.5 }] },
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = await persistMetricsPayload(unknown, isKnownProject);
      expect(result.inserted).toBe(0);
      expect(result.dropped).toBe(1);

      const db = await getDb();
      const rows = await db.query(`SELECT COUNT(*) AS c FROM otel_metrics`);
      const c = (rows.rows[0] as { c: bigint | number }).c;
      expect(Number(c)).toBe(0);
    });

    it('drops data points with missing timeUnixNano per-row, keeps the rest', async () => {
      const mixed = {
        resourceMetrics: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.cost.usage',
                    sum: {
                      dataPoints: [
                        { timeUnixNano: '1700000000000000000', asDouble: 0.1 },
                        { /* missing timeUnixNano */ asDouble: 0.2 },
                        { timeUnixNano: '1700000060000000000', asDouble: 0.3 },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = await persistMetricsPayload(mixed, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(1);
    });
  });

  describe('persistLogsPayload', () => {
    it('writes one row per log record with prompt_id extracted', async () => {
      const result = await persistLogsPayload(SAMPLE_LOGS_JSON, isKnownProject);
      expect(result.inserted).toBe(1);
      expect(result.dropped).toBe(0);

      const db = await getDb();
      const rows = await db.query<{ event_name: string; prompt_id: string; project_secret: string }>(
        `SELECT event_name, prompt_id, project_secret FROM otel_events`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].event_name).toBe('claude_code.user_prompt');
      expect(rows.rows[0].prompt_id).toBe('prompt-xyz');
      expect(rows.rows[0].project_secret).toBe(KNOWN_SECRET);
    });

    it('drops payloads for unknown projects', async () => {
      const unknown = {
        resourceLogs: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'foreign' } }] },
            scopeLogs: [{ logRecords: [{ timeUnixNano: '1700000000000000000', eventName: 'x' }] }],
          },
        ],
      };
      const result = await persistLogsPayload(unknown, isKnownProject);
      expect(result.inserted).toBe(0);
      expect(result.dropped).toBe(1);
    });
  });

  describe('persistTracesPayload', () => {
    it('writes one row per span with parent-child linkage preserved', async () => {
      const result = await persistTracesPayload(SAMPLE_TRACES_JSON, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(0);

      const db = await getDb();
      const rows = await db.query<{ span_id: string; parent_span_id: string | null; span_name: string; trace_id: string }>(
        `SELECT span_id, parent_span_id, span_name, trace_id FROM otel_spans ORDER BY span_name`,
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].span_id).toBe('span-child');
      expect(rows.rows[0].parent_span_id).toBe('span-root');
      expect(rows.rows[1].span_id).toBe('span-root');
      expect(rows.rows[1].parent_span_id).toBeNull();
    });

    it('drops spans with missing trace_id', async () => {
      const malformed = {
        resourceSpans: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
            scopeSpans: [
              {
                spans: [
                  { /* no traceId */ spanId: 'orphan', startTimeUnixNano: '1', endTimeUnixNano: '2' },
                ],
              },
            ],
          },
        ],
      };
      const result = await persistTracesPayload(malformed, isKnownProject);
      expect(result.inserted).toBe(0);
      expect(result.dropped).toBe(1);
    });
  });

  describe('helpers (_testing)', () => {
    it('unixNanoToDate converts a nano string to a Date within 1 ms', () => {
      // 1700000000 seconds = 2023-11-14T22:13:20.000Z
      const d = _testing.unixNanoToDate('1700000000000000000');
      expect(d).not.toBeNull();
      expect(d!.getTime()).toBe(1700000000000);
    });

    it('unixNanoToDate returns null for missing input', () => {
      expect(_testing.unixNanoToDate(undefined)).toBeNull();
      expect(_testing.unixNanoToDate(null)).toBeNull();
      expect(_testing.unixNanoToDate('not-a-number')).toBeNull();
    });

    it('flattenAttributes unwraps the OTLP AnyValue shape for scalar types', () => {
      const flat = _testing.flattenAttributes([
        { key: 'a', value: { stringValue: 'hi' } },
        { key: 'b', value: { intValue: '42' } },
        { key: 'c', value: { doubleValue: 3.14 } },
        { key: 'd', value: { boolValue: true } },
      ]);
      expect(flat).toEqual({ a: 'hi', b: '42', c: 3.14, d: true });
    });

    it('resolveResource returns null for missing hotsheet_project', () => {
      const r = _testing.resolveResource({ attributes: [{ key: 'service.name', value: { stringValue: 'x' } }] }, () => true);
      expect(r).toBeNull();
    });

    it('resolveResource returns null when the project lookup says unknown', () => {
      const r = _testing.resolveResource(
        { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'nope' } }] },
        () => false,
      );
      expect(r).toBeNull();
    });

    it('resolveResource returns the context when the project is known', () => {
      const r = _testing.resolveResource(
        { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'known' } }, { key: 'session.id', value: { stringValue: 'sess-1' } }] },
        (s) => s === 'known',
      );
      expect(r).not.toBeNull();
      expect(r!.projectSecret).toBe('known');
      expect(r!.sessionId).toBe('sess-1');
    });
  });
});
