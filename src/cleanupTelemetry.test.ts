/**
 * HS-8154 / HS-9280 — telemetry retention sweep tests. The raw otel_* tables are
 * gone; retention is now the JSONL age-sweep (`sweepOtelJsonl`, exercised directly
 * in `db/otelJsonlStore.test.ts`). These pin the CLEANUP INTEGRATION: that
 * `cleanupTelemetryRows` reads the per-project window settings and sweeps the right
 * JSONL kinds, and that `cleanupAllProjectsTelemetry` fans that across every
 * registered project + the central store.
 */
import { readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAllProjectsTelemetry, cleanupTelemetryRows } from './cleanup.js';
import { centralTelemetryDataDir, closeDbForDir, telemetryClusterDataDir } from './db/connection.js';
import { appendOtelJsonl, type OtelJsonlKind } from './db/otelJsonlStore.js';
import type * as GlobalConfigModule from './global-config.js';
import type * as ProjectListModule from './project-list.js';
import { cleanupTestDb, createTempDir, setupTestDb } from './test-helpers.js';

// Isolate the central store to a temp dir so the sweep never touches the real
// `~/.hotsheet/telemetry`.
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

// HS-8607 — control which dataDirs `cleanupAllProjectsTelemetry` sweeps.
const { mockReadProjectList } = vi.hoisted(() => ({ mockReadProjectList: vi.fn<() => string[]>(() => []) }));
vi.mock('./project-list.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectListModule>();
  return { ...actual, readProjectList: mockReadProjectList };
});

// HS-8877 — control the central retention window without touching the real config.
const { mockCentralRetention } = vi.hoisted(() => ({ mockCentralRetention: { value: undefined as number | undefined } }));
vi.mock('./global-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GlobalConfigModule>();
  return { ...actual, readGlobalConfig: () => ({ ...actual.readGlobalConfig(), centralTelemetryRetentionDays: mockCentralRetention.value }) };
});

const KNOWN_SECRET = 'secret-A';
const DAY_MS = 86_400_000;

/** Append one JSONL row for `kind` at `ageDays` before now (lands in that day's
 *  file). Uses noon UTC so the server-local day is stable across zones. */
async function seedJsonl(dataDir: string, kind: OtelJsonlKind, ageDays: number): Promise<void> {
  const ts = new Date(Date.now() - ageDays * DAY_MS);
  ts.setUTCHours(12, 0, 0, 0);
  const base = kind === 'spans'
    ? { trace_id: 't', span_id: 's', start_ts: ts.toISOString(), end_ts: ts.toISOString() }
    : { ts: ts.toISOString(), project_secret: KNOWN_SECRET };
  await appendOtelJsonl(telemetryClusterDataDir(dataDir), kind, ts, base);
}

/** Count the `otel-<kind>-*.jsonl` day files present in a cluster dir. */
function dayFileCount(dataDir: string, kind: OtelJsonlKind): number {
  try {
    return readdirSync(telemetryClusterDataDir(dataDir)).filter(f => f.startsWith(`otel-${kind}-`) && f.endsWith('.jsonl')).length;
  } catch { return 0; }
}

function writeRetentionSetting(dataDir: string, opts: { days?: number; spanDays?: number }): void {
  const obj: Record<string, unknown> = { secret: KNOWN_SECRET, port: 4174 };
  if (opts.days !== undefined) obj.telemetry_retention_days = opts.days;
  if (opts.spanDays !== undefined) obj.telemetry_span_retention_days = opts.spanDays;
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(obj));
}

describe('cleanupTelemetryRows — JSONL age-sweep (HS-9280)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  it('sweeps metric/event day-files older than telemetry_retention_days, keeps recent', async () => {
    writeRetentionSetting(tempDir, { days: 30 });
    await seedJsonl(tempDir, 'metrics', 40); // older than the window
    await seedJsonl(tempDir, 'events', 40);
    await seedJsonl(tempDir, 'metrics', 1); // recent — kept
    expect(dayFileCount(tempDir, 'metrics')).toBe(2);

    await cleanupTelemetryRows(tempDir);

    expect(dayFileCount(tempDir, 'metrics')).toBe(1); // the 40-day file swept
    expect(dayFileCount(tempDir, 'events')).toBe(0);
  });

  it('retention 0 keeps everything (no sweep)', async () => {
    writeRetentionSetting(tempDir, { days: 0, spanDays: 0 });
    await seedJsonl(tempDir, 'metrics', 400);
    await cleanupTelemetryRows(tempDir);
    expect(dayFileCount(tempDir, 'metrics')).toBe(1);
  });

  it('spans use the shorter telemetry_span_retention_days window', async () => {
    writeRetentionSetting(tempDir, { days: 30, spanDays: 7 });
    await seedJsonl(tempDir, 'spans', 10); // > 7d span window → swept
    await seedJsonl(tempDir, 'metrics', 10); // < 30d metrics window → kept
    await cleanupTelemetryRows(tempDir);
    expect(dayFileCount(tempDir, 'spans')).toBe(0);
    expect(dayFileCount(tempDir, 'metrics')).toBe(1);
  });
});

describe('cleanupAllProjectsTelemetry — fan-out (HS-8607 / HS-9280)', () => {
  let launched: string;
  let other: string;
  beforeEach(async () => {
    launched = await setupTestDb();
    other = createTempDir();
    writeRetentionSetting(launched, { days: 30 });
    writeRetentionSetting(other, { days: 30 });
    mockReadProjectList.mockReturnValue([other]);
    mockCentralRetention.value = 30;
  });
  afterEach(async () => {
    mockReadProjectList.mockReturnValue([]);
    await cleanupTestDb(launched);
    rmSync(other, { recursive: true, force: true });
  });

  it('sweeps old JSONL across the launched project, every registered project, and central', async () => {
    await seedJsonl(launched, 'metrics', 40);
    await seedJsonl(other, 'metrics', 40);
    await seedJsonl(centralTelemetryDataDir(), 'metrics', 40);
    // A recent file in each survives.
    await seedJsonl(launched, 'metrics', 1);

    await cleanupAllProjectsTelemetry(launched);

    expect(dayFileCount(launched, 'metrics')).toBe(1); // old swept, recent kept
    expect(dayFileCount(other, 'metrics')).toBe(0);
    expect(dayFileCount(centralTelemetryDataDir(), 'metrics')).toBe(0);
  });
});
