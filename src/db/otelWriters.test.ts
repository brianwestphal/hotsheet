/**
 * HS-8470 — OTLP persistence writer tests. Insert/SELECT round-trips
 * for all three signal types + the §67.5.3 drop-on-unknown-project
 * anti-pollution gate + per-row malformed-entry handling.
 */
import { promises as fsp, rmSync } from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerExistingProject, unregisterProject } from '../projects.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDb, getDbForDir, telemetryClusterDataDir } from './connection.js';
import { readOtelJsonlDay } from './otelJsonlStore.js';
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

  // HS-9236 — read every row across all day-files for a kind from the cluster
  // dir (the sample payloads' ts determines the day, so read them all).
  // HS-9280 — raw otel_* tables are gone; the writers' raw store is JSONL. Read all
  // rows for a kind from a cluster dir (default `tempDir`), sorted by `ts` /
  // `start_ts` so assertions that used `ORDER BY ts` still line up.
  async function readAllJsonl(kind: 'events' | 'metrics' | 'spans', clusterBase: string = tempDir): Promise<Record<string, unknown>[]> {
    const dir = telemetryClusterDataDir(clusterBase);
    const prefix = `otel-${kind}-`;
    let files: string[];
    try { files = (await fsp.readdir(dir)).filter(f => f.startsWith(prefix) && f.endsWith('.jsonl')); }
    catch { return []; }
    const out: Record<string, unknown>[] = [];
    for (const f of files) out.push(...await readOtelJsonlDay(dir, kind, f.slice(prefix.length, -'.jsonl'.length)));
    const tsKey = kind === 'spans' ? 'start_ts' : 'ts';
    out.sort((a, b) => String(a[tsKey]).localeCompare(String(b[tsKey])));
    return out;
  }

  describe('persistMetricsPayload', () => {
    it('writes one row per data point for a known project', async () => {
      const result = await persistMetricsPayload(SAMPLE_METRICS_JSON, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(0);

      const rows = await readAllJsonl('metrics');
      expect(rows).toHaveLength(2);
      expect(rows[0].metric_name).toBe('claude_code.cost.usage');
      expect(rows[0].project_secret).toBe(KNOWN_SECRET);
      expect(rows[0].session_id).toBe('session-1');
      expect((rows[0].value_json as { asDouble: number }).asDouble).toBe(0.42);
      expect((rows[1].value_json as { asDouble: number }).asDouble).toBe(0.18);
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

      expect(await readAllJsonl('metrics')).toHaveLength(0);
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

      const rows = await readAllJsonl('metrics');
      expect(rows[0]).toMatchObject({ metric_name: 'claude_code.cost.usage', aggregation_temporality: 'delta', is_monotonic: true });
      expect(rows[1]).toMatchObject({ metric_name: 'claude_code.token.usage', aggregation_temporality: 'cumulative', is_monotonic: true });
      expect(rows[2]).toMatchObject({ metric_name: 'claude_code.some.gauge', aggregation_temporality: null, is_monotonic: null });
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

      // Stored value_json (in the JSONL store) no longer carries the nested attributes array.
      const raw = await readAllJsonl('metrics');
      expect('attributes' in (raw[0].value_json as Record<string, unknown>)).toBe(false);
      expect((raw[0].value_json as { asDouble: number }).asDouble).toBe(0.42); // rest of the point preserved
    });

    // HS-9243 — the cost/token metrics' session.id lands in the daily dedup set
    // (main db) so the reads can derive an exact distinct session_count.
    it('records the metric session.id in otel_daily_seen (main db)', async () => {
      await persistMetricsPayload(SAMPLE_METRICS_JSON, isKnownProject);
      const mainDb = await getDb();
      const seen = await mainDb.query<{ id: string; day: string }>(
        `SELECT id, day::text AS day FROM otel_daily_seen WHERE project_secret=$1 AND kind='session'`, [KNOWN_SECRET]);
      expect(seen.rows).toHaveLength(1);
      expect(seen.rows[0].id).toBe('session-1');
    });

    it('HS-9236 — dual-writes each metric row to the rotating JSONL store', async () => {
      await persistMetricsPayload(SAMPLE_METRICS_JSON, isKnownProject);
      const rows = await readAllJsonl('metrics');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]).toHaveProperty('metric_name');
      expect(rows[0]).toHaveProperty('value_json');
      expect(rows[0].project_secret).toBe(KNOWN_SECRET);
    });
  });

  describe('persistLogsPayload', () => {
    it('writes one row per log record with prompt_id extracted', async () => {
      const result = await persistLogsPayload(SAMPLE_LOGS_JSON, isKnownProject);
      expect(result.inserted).toBe(1);
      expect(result.dropped).toBe(0);

      const rows = await readAllJsonl('events');
      expect(rows).toHaveLength(1);
      expect(rows[0].event_name).toBe('claude_code.user_prompt');
      expect(rows[0].prompt_id).toBe('prompt-xyz');
      expect(rows[0].project_secret).toBe(KNOWN_SECRET);
    });

    it('HS-9236 — dual-writes each event row to the rotating JSONL store', async () => {
      await persistLogsPayload(SAMPLE_LOGS_JSON, isKnownProject);
      const rows = await readAllJsonl('events');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]).toMatchObject({ event_name: 'claude_code.user_prompt', prompt_id: 'prompt-xyz', project_secret: KNOWN_SECRET });
      expect(rows[0]).toHaveProperty('body_json');
    });

    // HS-9243 — an event's prompt_id lands in the daily dedup set (main db) so
    // the reads can derive an exact distinct prompt_count.
    it('records the event prompt_id in otel_daily_seen (main db)', async () => {
      await persistLogsPayload(SAMPLE_LOGS_JSON, isKnownProject);
      const mainDb = await getDb();
      const seen = await mainDb.query<{ id: string }>(
        `SELECT id FROM otel_daily_seen WHERE project_secret=$1 AND kind='prompt'`, [KNOWN_SECRET]);
      expect(seen.rows).toHaveLength(1);
      expect(seen.rows[0].id).toBe('prompt-xyz');
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

      const rows = await readAllJsonl('events');
      expect(rows[0].session_id).toBe('sess-from-record');
      // Stored bare, exactly as Claude Code sends it.
      expect(rows[0].event_name).toBe('user_prompt');
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

      // body_json (JSONL) stored without the nested attributes array.
      const raw = await readAllJsonl('events');
      expect('attributes' in (raw[0].body_json as Record<string, unknown>)).toBe(false);
    });
  });

  describe('persistTracesPayload', () => {
    it('writes one row per span with parent-child linkage preserved', async () => {
      const result = await persistTracesPayload(SAMPLE_TRACES_JSON, isKnownProject);
      expect(result.inserted).toBe(2);
      expect(result.dropped).toBe(0);

      const rows = (await readAllJsonl('spans')).sort((a, b) => String(a.span_name).localeCompare(String(b.span_name)));
      expect(rows).toHaveLength(2);
      expect(rows[0].span_id).toBe('span-child');
      expect(rows[0].parent_span_id).toBe('span-root');
      expect(rows[1].span_id).toBe('span-root');
      expect(rows[1].parent_span_id).toBeNull();
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

        // Each project's row landed in its OWN cluster's JSONL, not the other's.
        expect((await readAllJsonl('metrics', tempDir)).map(r => r.project_secret)).toEqual([KNOWN_SECRET]);
        expect((await readAllJsonl('metrics', dir2)).map(r => r.project_secret)).toEqual([SECRET_2]);
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

        // Did NOT land in the project's JSONL.
        expect(await readAllJsonl('metrics', tempDir)).toHaveLength(0);

        // Landed in the central store's JSONL with a NULL project_secret.
        const central = (await readAllJsonl('metrics', centralTelemetryDataDir()))
          .filter(r => r.project_secret === null && (r.value_json as { asDouble: number }).asDouble === MARKER);
        expect(central).toHaveLength(1);
        // HS-8877 — the central write marks the central store dirty for a snapshot.
        expect(snapshotSpy).toHaveBeenCalledWith(centralTelemetryDataDir());
      } finally {
        // HS-9280 — the central store is a temp override (afterAll cleans it), so no
        // per-row cleanup is needed (the JSONL raw store can't line-delete anyway).
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
