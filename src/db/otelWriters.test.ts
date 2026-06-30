/**
 * HS-8470 — OTLP persistence writer tests. Insert/SELECT round-trips
 * for all three signal types + the §67.5.3 drop-on-unknown-project
 * anti-pollution gate + per-row malformed-entry handling.
 */
import { rmSync } from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDb, getDbForDir, telemetryClusterDataDir } from './connection.js';
import {
  _testing,
  persistLogsPayload,
  persistMetricsPayload,
  persistTracesPayload,
} from './otelWriters.js';

// HS-8877 — central (no-project) writes mark the central store dirty for a
// snapshot. Mock the trigger so the test asserts the wiring without a real
// debounce timer firing after teardown.
const { snapshotSpy } = vi.hoisted(() => ({ snapshotSpy: vi.fn() }));
vi.mock('./snapshot.js', () => ({ scheduleSnapshot: snapshotSpy }));

const KNOWN_SECRET = 'secret-known-A';
const isKnownProject = (s: string): boolean => s === KNOWN_SECRET;

// HS-8874 — isolate the central non-project store to a temp dir so these tests
// (which exercise the real no-project → central routing) never instantiate a
// PGlite cluster in the developer's real `~/.hotsheet/telemetry`.
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

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
    // HS-8874 — writers route per-resource via `getProjectBySecret(secret).dataDir`.
    // Register KNOWN_SECRET against the test's own dataDir. HS-9230 — telemetry is
    // now written to the relocated `<tempDir>/telemetry/db` cluster, so the
    // round-trip assertions below read that cluster (not `getDb()` = `<tempDir>/db`).
    const projectDb = await getDb();
    registerExistingProject(tempDir, KNOWN_SECRET, projectDb);
  });

  afterEach(async () => {
    unregisterProject(KNOWN_SECRET);
    await cleanupTestDb(tempDir);
  });

  describe('persistMetricsPayload', () => {
    it('writes one row per data point for a known project', async () => {
      const result = await persistMetricsPayload(SAMPLE_METRICS_JSON, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(0);

      const db = await getDbForDir(telemetryClusterDataDir(tempDir));
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

      const db = await getDbForDir(telemetryClusterDataDir(tempDir));
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

    // HS-8600 — every row records the metric's aggregation temporality +
    // isMonotonic so a cumulative source can be detected instead of silently
    // re-inflating the SUM-based dashboards.
    it('persists aggregation_temporality + is_monotonic onto each metric row', async () => {
      const payload = {
        resourceMetrics: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
            scopeMetrics: [
              {
                metrics: [
                  // Delta monotonic counter (the post-HS-8599 default).
                  { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.5 }] } },
                  // Cumulative monotonic counter (the dangerous shape).
                  { name: 'claude_code.token.usage', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ timeUnixNano: '1700000060000000000', asInt: 100 }] } },
                  // A gauge — no temporality.
                  { name: 'claude_code.some.gauge', gauge: { dataPoints: [{ timeUnixNano: '1700000120000000000', asDouble: 3 }] } },
                ],
              },
            ],
          },
        ],
      };
      const result = await persistMetricsPayload(payload, isKnownProject);
      expect(result.inserted).toBe(3);

      const db = await getDbForDir(telemetryClusterDataDir(tempDir));
      const rows = await db.query<{ metric_name: string; aggregation_temporality: string | null; is_monotonic: boolean | null }>(
        `SELECT metric_name, aggregation_temporality, is_monotonic FROM otel_metrics ORDER BY ts`,
      );
      expect(rows.rows[0]).toMatchObject({ metric_name: 'claude_code.cost.usage', aggregation_temporality: 'delta', is_monotonic: true });
      expect(rows.rows[1]).toMatchObject({ metric_name: 'claude_code.token.usage', aggregation_temporality: 'cumulative', is_monotonic: true });
      expect(rows.rows[2]).toMatchObject({ metric_name: 'claude_code.some.gauge', aggregation_temporality: null, is_monotonic: null });
    });

    // HS-9233 — dual-write the compact daily rollup into the SNAPSHOTTED main db
    // (not the cluster), and strip the redundant nested attributes from value_json.
    it('rolls up cost into otel_rollup_daily (main db) and strips nested attributes', async () => {
      const result = await persistMetricsPayload(SAMPLE_METRICS_JSON, isKnownProject);
      expect(result.inserted).toBe(2);

      // Rollup lives in the main snapshotted db (getDb), NOT the telemetry cluster.
      const mainDb = await getDb();
      const roll = await mainDb.query<{ model: string; cost_usd: string; datapoint_count: number }>(
        `SELECT model, cost_usd, datapoint_count FROM otel_rollup_daily WHERE project_secret = $1 ORDER BY model`,
        [KNOWN_SECRET],
      );
      // Two cost data points: one model='sonnet-4' (0.42), one with no attrs → '(unknown)' (0.18).
      const total = roll.rows.reduce((s, r) => s + Number(r.cost_usd), 0);
      expect(total).toBeCloseTo(0.6, 6);
      expect(roll.rows.reduce((s, r) => s + r.datapoint_count, 0)).toBe(2);

      // The cluster has NO rollup rows (rollups are main-db only).
      const clusterDb = await getDbForDir(telemetryClusterDataDir(tempDir));
      const clusterRoll = await clusterDb.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM otel_rollup_daily`);
      expect(clusterRoll.rows[0].c).toBe(0);

      // Stored value_json no longer carries the nested attributes array.
      const raw = await clusterDb.query<{ value_json: Record<string, unknown> }>(
        `SELECT value_json FROM otel_metrics ORDER BY ts`,
      );
      expect('attributes' in raw.rows[0].value_json).toBe(false);
      expect(raw.rows[0].value_json.asDouble).toBe(0.42); // rest of the point preserved
    });
  });

  describe('persistLogsPayload', () => {
    it('writes one row per log record with prompt_id extracted', async () => {
      const result = await persistLogsPayload(SAMPLE_LOGS_JSON, isKnownProject);
      expect(result.inserted).toBe(1);
      expect(result.dropped).toBe(0);

      const db = await getDbForDir(telemetryClusterDataDir(tempDir));
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

    // HS-8639 — Claude Code stamps `session.id` on the per-record attributes,
    // not the resource (the `/api/telemetry/_debug` paste showed the events
    // `session_id` column was always null → `distinctSessions: 0`). The writer
    // must fall back to the record attribute, mirroring the metrics writer.
    it('populates session_id from the log RECORD attributes when the resource omits it', async () => {
      const recordOnlySession = {
        resourceLogs: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: '1700000000000000000',
                    eventName: 'user_prompt',
                    attributes: [
                      { key: 'prompt.id', value: { stringValue: 'prompt-rec' } },
                      { key: 'session.id', value: { stringValue: 'sess-from-record' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = await persistLogsPayload(recordOnlySession, isKnownProject);
      expect(result.inserted).toBe(1);

      const db = await getDbForDir(telemetryClusterDataDir(tempDir));
      const rows = await db.query<{ session_id: string | null; event_name: string }>(
        `SELECT session_id, event_name FROM otel_events`,
      );
      expect(rows.rows[0].session_id).toBe('sess-from-record');
      // Stored bare, exactly as Claude Code sends it.
      expect(rows.rows[0].event_name).toBe('user_prompt');
    });

    // HS-9233 — ingest-time per-ticket cost attribution (time-window path): an
    // api_request whose ts falls inside an open ticket_work_intervals window is
    // attributed to that ticket's rollup in the main db.
    it('attributes an api_request to the open ticket via ticket_work_intervals', async () => {
      // The interval lives in the CLUSTER db (alongside the raw events).
      const clusterDb = await getDbForDir(telemetryClusterDataDir(tempDir));
      const eventTs = new Date(1700000000000); // == timeUnixNano below (ms)
      await clusterDb.query(
        `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at) VALUES ($1,$2,$3,$4)`,
        [KNOWN_SECRET, 'HS-1234', new Date(eventTs.getTime() - 60_000), null],
      );

      const payload = {
        resourceLogs: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: '1700000000000000000',
                    eventName: 'api_request',
                    attributes: [
                      { key: 'cost', value: { doubleValue: 0.25 } },
                      { key: 'tokens', value: { intValue: '1500' } },
                      { key: 'model', value: { stringValue: 'sonnet-4' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = await persistLogsPayload(payload, isKnownProject);
      expect(result.inserted).toBe(1);

      const mainDb = await getDb();
      const roll = await mainDb.query<{ cost_usd: string; total_tokens: string; model_breakdown: unknown }>(
        `SELECT cost_usd, total_tokens, model_breakdown FROM otel_rollup_ticket WHERE project_secret=$1 AND ticket_number='HS-1234'`,
        [KNOWN_SECRET],
      );
      expect(roll.rows).toHaveLength(1);
      expect(Number(roll.rows[0].cost_usd)).toBeCloseTo(0.25, 6);
      expect(Number(roll.rows[0].total_tokens)).toBe(1500);

      // body_json stored without the nested attributes array.
      const raw = await clusterDb.query<{ body_json: Record<string, unknown> }>(`SELECT body_json FROM otel_events`);
      expect('attributes' in raw.rows[0].body_json).toBe(false);
    });
  });

  describe('persistTracesPayload', () => {
    it('writes one row per span with parent-child linkage preserved', async () => {
      const result = await persistTracesPayload(SAMPLE_TRACES_JSON, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(0);

      const db = await getDbForDir(telemetryClusterDataDir(tempDir));
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

  // HS-8874 — per-resource routing: each project's rows go to that project's
  // own DB; no-`hotsheet_project` rows go to central; unknown-project rows drop.
  describe('per-project write routing (HS-8874)', () => {
    it('routes two resources for two known projects to their two separate DBs', async () => {
      const SECRET_2 = 'secret-known-B';
      const dir2 = createTempDir();
      const db2 = await getDbForDir(telemetryClusterDataDir(dir2));
      registerExistingProject(dir2, SECRET_2, db2);
      try {
        const payload = {
          resourceMetrics: [
            {
              resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: KNOWN_SECRET } }] },
              scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.5 }] } }] }],
            },
            {
              resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: SECRET_2 } }] },
              scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.9 }] } }] }],
            },
          ],
        };
        const result = await persistMetricsPayload(payload, (s) => s === KNOWN_SECRET || s === SECRET_2);
        expect(result.inserted).toBe(2);
        expect(result.dropped).toBe(0);

        // Each project's row landed in its OWN DB, not the other's.
        const a = await (await getDbForDir(telemetryClusterDataDir(tempDir))).query<{ project_secret: string }>(`SELECT project_secret FROM otel_metrics`);
        expect(a.rows.map(r => r.project_secret)).toEqual([KNOWN_SECRET]);
        const b = await db2.query<{ project_secret: string }>(`SELECT project_secret FROM otel_metrics`);
        expect(b.rows.map(r => r.project_secret)).toEqual([SECRET_2]);
      } finally {
        unregisterProject(SECRET_2);
        await closeDbForDir(dir2);
      }
    });

    it('routes a no-hotsheet_project resource to the central store (NULL project_secret)', async () => {
      // A unique marker cost so the assertion + cleanup target only this row in
      // the real `~/.hotsheet/telemetry` central store.
      const MARKER = 0.700123;
      try {
        snapshotSpy.mockClear();
        const payload = {
          resourceMetrics: [
            {
              resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
              scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: MARKER }] } }] }],
            },
          ],
        };
        const result = await persistMetricsPayload(payload, () => true);
        expect(result.inserted).toBe(1);
        expect(result.dropped).toBe(0);

        // Did NOT land in the project DB.
        const proj = await (await getDbForDir(telemetryClusterDataDir(tempDir))).query(`SELECT COUNT(*) AS c FROM otel_metrics`);
        expect(Number((proj.rows[0] as { c: bigint | number }).c)).toBe(0);

        // Landed in central with a NULL project_secret.
        const central = await (await getDbForDir(centralTelemetryDataDir())).query<{ project_secret: string | null }>(
          `SELECT project_secret FROM otel_metrics WHERE project_secret IS NULL AND (value_json->>'asDouble')::numeric = $1`,
          [MARKER],
        );
        expect(central.rows.length).toBe(1);
        // HS-8877 — the central write marks the central store dirty for a snapshot.
        expect(snapshotSpy).toHaveBeenCalledWith(centralTelemetryDataDir());
      } finally {
        // Don't leave a marker row behind in the user's real central store.
        const c = await getDbForDir(centralTelemetryDataDir());
        await c.query(`DELETE FROM otel_metrics WHERE project_secret IS NULL AND (value_json->>'asDouble')::numeric = $1`, [MARKER]);
      }
    });

    it('drops an unknown-project resource (anti-pollution gate preserved)', async () => {
      const payload = {
        resourceMetrics: [
          {
            resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'not-registered' } }] },
            scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 0.4 }] } }] }],
          },
        ],
      };
      const result = await persistMetricsPayload(payload, (s) => s === KNOWN_SECRET);
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

    // HS-8874 — missing hotsheet_project routes to CENTRAL (projectSecret: null),
    // not a drop.
    it('resolveResource returns a central context (projectSecret null) for missing hotsheet_project', () => {
      const r = _testing.resolveResource({ attributes: [{ key: 'service.name', value: { stringValue: 'x' } }] }, () => true);
      expect(r).not.toBeNull();
      expect(r).not.toBe('drop');
      if (r !== null && r !== 'drop') expect(r.projectSecret).toBeNull();
    });

    // HS-8874 — an unknown (un-registered) project is the 'drop' signal.
    it('resolveResource returns the drop signal when the project lookup says unknown', () => {
      const r = _testing.resolveResource(
        { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'nope' } }] },
        () => false,
      );
      expect(r).toBe('drop');
    });

    it('resolveResource returns null for a malformed (non-object) resource', () => {
      expect(_testing.resolveResource(null, () => true)).toBeNull();
      expect(_testing.resolveResource('nope', () => true)).toBeNull();
    });

    it('resolveResource returns the context when the project is known', () => {
      const r = _testing.resolveResource(
        { attributes: [{ key: 'hotsheet_project', value: { stringValue: 'known' } }, { key: 'session.id', value: { stringValue: 'sess-1' } }] },
        (s) => s === 'known',
      );
      expect(r).not.toBeNull();
      expect(r).not.toBe('drop');
      if (r !== null && r !== 'drop') {
        expect(r.projectSecret).toBe('known');
        expect(r.sessionId).toBe('sess-1');
      }
    });

    // HS-8600 — aggregation-temporality extraction + cumulative-counter warning.
    describe('extractMetricAggregation (HS-8600)', () => {
      it('reads delta temporality from the numeric form + isMonotonic off a sum', () => {
        expect(_testing.extractMetricAggregation({ sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [] } }))
          .toEqual({ temporality: 'delta', isMonotonic: true });
      });
      it('reads cumulative temporality from the protobuf-JSON string form', () => {
        expect(_testing.extractMetricAggregation({ sum: { aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE', isMonotonic: false, dataPoints: [] } }))
          .toEqual({ temporality: 'cumulative', isMonotonic: false });
      });
      it('reads temporality off a histogram wrapper too', () => {
        expect(_testing.extractMetricAggregation({ histogram: { aggregationTemporality: 2, dataPoints: [] } }))
          .toEqual({ temporality: 'cumulative', isMonotonic: null });
      });
      it('returns nulls for a gauge (no temporality / monotonicity)', () => {
        expect(_testing.extractMetricAggregation({ gauge: { dataPoints: [] } }))
          .toEqual({ temporality: null, isMonotonic: null });
      });
      it('returns nulls for unspecified / missing / non-object', () => {
        expect(_testing.extractMetricAggregation({ sum: { aggregationTemporality: 0, dataPoints: [] } })).toEqual({ temporality: null, isMonotonic: null });
        expect(_testing.extractMetricAggregation({ sum: { dataPoints: [] } })).toEqual({ temporality: null, isMonotonic: null });
        expect(_testing.extractMetricAggregation(null)).toEqual({ temporality: null, isMonotonic: null });
      });
    });

    describe('warnIfCumulativeCounter (HS-8600)', () => {
      beforeEach(() => { _testing.resetCumulativeWarnForTesting(); });

      it('warns ONCE for a cumulative monotonic cost/token counter', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          _testing.warnIfCumulativeCounter('claude_code.cost.usage', { temporality: 'cumulative', isMonotonic: true });
          _testing.warnIfCumulativeCounter('claude_code.token.usage', { temporality: 'cumulative', isMonotonic: true });
          expect(spy).toHaveBeenCalledTimes(1); // module-once guard
        } finally { spy.mockRestore(); }
      });

      it('does NOT warn for delta, non-monotonic, or non-summed metrics', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          _testing.warnIfCumulativeCounter('claude_code.cost.usage', { temporality: 'delta', isMonotonic: true });
          _testing.warnIfCumulativeCounter('claude_code.cost.usage', { temporality: 'cumulative', isMonotonic: false });
          _testing.warnIfCumulativeCounter('some.other.metric', { temporality: 'cumulative', isMonotonic: true });
          expect(spy).not.toHaveBeenCalled();
        } finally { spy.mockRestore(); }
      });
    });
  });
});
