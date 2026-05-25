/**
 * HS-8577 — Snapshot Persistence Phase 1 benchmark (docs/72-snapshot-persistence.md).
 *
 * Measures the two axes the §72 design says gate the memory-primary decision:
 *   1. RAM footprint  — memory-primary (`memory://`) holds the whole PGDATA in
 *      WASM linear memory; file-backed (`nodefs`, today's default) pages to disk
 *      and only keeps shared_buffers + working set resident. The delta is the
 *      cost of going memory-primary.
 *   2. Snapshot (dump) latency — `CHECKPOINT` + `dumpDataDir('gzip')`, the work
 *      every persist trigger pays. Grows with DB size (esp. the §67 telemetry
 *      tables), which is the write-amplification concern (§72.3 #3/#4).
 *
 * Both are measured against a realistically large §67 telemetry set, single-
 * AND multi-project, exactly per the HS-8577 deliverable. The numbers feed the
 * Phase 3 telemetry-split decision (HS-8579) and any eventual default flip.
 *
 * Each (mode, events, projects) config runs in a FRESH child process so the
 * RAM number is a clean resident footprint — no cross-run WASM-memory
 * accumulation (WASM linear memory isn't returned to the OS on close) and no
 * first-run warmup contamination. The parent spawns one child per config and
 * collects a JSON result line.
 *
 * Run (`--expose-gc` stabilizes the RAM sample):
 *   node --import tsx --expose-gc scripts/bench-memory-primary.ts
 *   node --import tsx --expose-gc scripts/bench-memory-primary.ts 0 50000 200000   # custom event counts
 *
 * NOT a vitest test (slow, measure-only) and NOT shipped in any bundle.
 */
import { type ChildProcess, spawn } from 'child_process';
import { rmSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createPglite } from '../src/db/pglite.js';

// The §67 telemetry DDL, copied verbatim from src/db/connection.ts::initSchema
// (the tables whose volume drives the RAM/latency question) + a minimal
// durable-set table so the "tickets are tiny" baseline is visible.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY, ticket_number TEXT, title TEXT, details TEXT,
    category TEXT, priority TEXT, status TEXT, up_next BOOLEAN, notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS otel_metrics (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL, project_secret TEXT NOT NULL,
    session_id TEXT, metric_name TEXT NOT NULL, attributes_json JSONB, value_json JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_otel_metrics_project_ts ON otel_metrics(project_secret, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_otel_metrics_session_ts ON otel_metrics(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics(metric_name);
  CREATE TABLE IF NOT EXISTS otel_events (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL, project_secret TEXT NOT NULL,
    session_id TEXT, prompt_id TEXT, event_name TEXT NOT NULL, attributes_json JSONB, body_json JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_otel_events_project_ts ON otel_events(project_secret, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_otel_events_session_ts ON otel_events(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_otel_events_prompt ON otel_events(prompt_id);
  CREATE TABLE IF NOT EXISTS otel_spans (
    id SERIAL PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
    project_secret TEXT NOT NULL, session_id TEXT, prompt_id TEXT, span_name TEXT NOT NULL,
    start_ts TIMESTAMPTZ NOT NULL, end_ts TIMESTAMPTZ NOT NULL, attributes_json JSONB, status_code TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_otel_spans_project_ts ON otel_spans(project_secret, start_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_otel_spans_session_ts ON otel_spans(session_id, start_ts);
  CREATE INDEX IF NOT EXISTS idx_otel_spans_prompt ON otel_spans(prompt_id);
  CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans(trace_id);
`;

interface Pgish {
  waitReady: Promise<unknown>;
  exec(sql: string): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  dumpDataDir(c: 'gzip'): Promise<Blob>;
  close(): Promise<void>;
}

const DURABLE_TICKETS = 500; // a busy project's ticket set — the "tiny durable" baseline
const ATTR = JSON.stringify({ 'service.name': 'claude-code', 'hotsheet_project': 'x'.repeat(40), model: 'claude-opus-4-7', extra: 'y'.repeat(80) });

async function seed(db: Pgish, otelEvents: number): Promise<void> {
  // Durable set (tickets) — proportionally tiny, present in every run.
  for (let i = 0; i < DURABLE_TICKETS; i += 500) {
    const vals = Array.from({ length: Math.min(500, DURABLE_TICKETS - i) }, (_, k) =>
      `('HS-${i + k}', 'Ticket ${i + k}', '${'detail '.repeat(20)}', 'task', 'default', 'not_started')`).join(',');
    await db.exec(`INSERT INTO tickets (ticket_number, title, details, category, priority, status) VALUES ${vals}`);
  }
  if (otelEvents === 0) return;
  // §67 telemetry: events dominate (every ~5 s); metrics ~1/12 the rate;
  // spans roughly event-rate when traces are on. Batch 1000 rows/INSERT.
  const metrics = Math.round(otelEvents / 12);
  const spans = otelEvents;
  const batch = 1000;
  const now = Date.now();
  for (let i = 0; i < otelEvents; i += batch) {
    const n = Math.min(batch, otelEvents - i);
    const vals = Array.from({ length: n }, (_, k) => {
      const ts = new Date(now - (i + k) * 5000).toISOString();
      return `('${ts}', 'proj-secret-0', 'sess-${(i + k) % 50}', 'prompt-${(i + k) % 5000}', 'tool_decision', '${ATTR}'::jsonb, '${ATTR}'::jsonb)`;
    }).join(',');
    await db.exec(`INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json) VALUES ${vals}`);
  }
  for (let i = 0; i < metrics; i += batch) {
    const n = Math.min(batch, metrics - i);
    const vals = Array.from({ length: n }, (_, k) => {
      const ts = new Date(now - (i + k) * 60000).toISOString();
      return `('${ts}', 'proj-secret-0', 'sess-${(i + k) % 50}', 'claude_code.token.usage', '${ATTR}'::jsonb, '{"value":${i + k}}'::jsonb)`;
    }).join(',');
    await db.exec(`INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json) VALUES ${vals}`);
  }
  for (let i = 0; i < spans; i += batch) {
    const n = Math.min(batch, spans - i);
    const vals = Array.from({ length: n }, (_, k) => {
      const ts = new Date(now - (i + k) * 5000).toISOString();
      return `('trace-${(i + k) % 5000}', 'span-${i + k}', 'parent-${(i + k) % 5000}', 'proj-secret-0', 'sess-${(i + k) % 50}', 'prompt-${(i + k) % 5000}', 'tool.execute', '${ts}', '${ts}', '${ATTR}'::jsonb, 'OK')`;
    }).join(',');
    await db.exec(`INSERT INTO otel_spans (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code) VALUES ${vals}`);
  }
}

function gc(): void { if (typeof (globalThis as { gc?: () => void }).gc === 'function') (globalThis as { gc?: () => void }).gc!(); }

interface Result { mode: string; events: number; projects: number; rssMB: number; extMB: number; dumpMs: number; snapMB: number }

const BENCH_MARKER = '__BENCH_RESULT__ ';

/** CHILD: build `projects` instances in a FRESH process, measure resident
 *  footprint vs the empty-process baseline, snapshot the first, emit JSON. */
async function runChild(mode: 'memory' | 'file', events: number, projects: number): Promise<void> {
  gc();
  const base = process.memoryUsage();
  const tmpDirs: string[] = [];
  const dbs: Pgish[] = [];
  for (let p = 0; p < projects; p++) {
    const dataDir = mode === 'file' ? await mkdtemp(join(tmpdir(), 'bench-file-')) : undefined;
    if (dataDir !== undefined) tmpDirs.push(dataDir);
    const db = createPglite(dataDir === undefined ? undefined : join(dataDir, 'db')) as unknown as Pgish;
    await db.waitReady;
    await db.exec(SCHEMA);
    await seed(db, events);
    dbs.push(db);
  }
  // Snapshot the first instance — dump latency/size is per-instance, not cumulative.
  const t0 = performance.now();
  await dbs[0].exec('CHECKPOINT');
  const blob = await dbs[0].dumpDataDir('gzip');
  const dumpMs = performance.now() - t0;
  const snapMB = blob.size / 1024 / 1024;

  gc();
  const peak = process.memoryUsage();
  const result: Result = {
    mode, events, projects,
    rssMB: (peak.rss - base.rss) / 1024 / 1024,
    extMB: (peak.external + peak.arrayBuffers - base.external - base.arrayBuffers) / 1024 / 1024,
    dumpMs, snapMB,
  };
  process.stdout.write(BENCH_MARKER + JSON.stringify(result) + '\n');

  for (const db of dbs) { try { await db.close(); } catch { /* ignore */ } }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** PARENT: spawn one child per config and parse its JSON result line. */
function spawnChild(mode: 'memory' | 'file', events: number, projects: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const self = new URL(import.meta.url).pathname;
    const child: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', '--expose-gc', self, '--child', mode, String(events), String(projects)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith(BENCH_MARKER));
      if (line === undefined) { reject(new Error(`child (${mode},${events},${projects}) exited ${code} with no result`)); return; }
      resolve(JSON.parse(line.slice(BENCH_MARKER.length)) as Result);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const childIdx = argv.indexOf('--child');
  if (childIdx !== -1) {
    const [mode, events, projects] = argv.slice(childIdx + 1);
    await runChild(mode as 'memory' | 'file', Number(events), Number(projects));
    return;
  }

  const nums = argv.map(Number).filter((n) => !Number.isNaN(n));
  const eventCounts = nums.length > 0 ? nums : [0, 50_000, 200_000];
  const results: Result[] = [];
  // Single-project sweep across telemetry volume, both modes.
  for (const ev of eventCounts) {
    for (const mode of ['file', 'memory'] as const) results.push(await spawnChild(mode, ev, 1));
  }
  // Multi-project axis = cumulative RAM. Use a moderate per-project telemetry
  // volume (a heavy project is ~50k events/month) so N×projects rows stays
  // bounded; the per-instance baseline + per-project scaling is the finding.
  const MULTI_EVENTS = 50_000;
  for (const projects of [3, 5]) {
    for (const mode of ['file', 'memory'] as const) results.push(await spawnChild(mode, MULTI_EVENTS, projects));
  }

  console.log('\n=== HS-8577 memory-primary benchmark (PG 17.5 / PGLite 0.4.5) ===');
  console.log('Each row = a fresh process. RSS = total resident growth over an empty-process baseline');
  console.log('(Node + WASM + data); External = WASM linear memory + ArrayBuffers (the PGDATA-in-RAM signal).\n');
  console.log('mode    events   projects   RSS(MB)   External(MB)  dump(ms)  snapshot(MB)');
  for (const r of results) {
    console.log(
      `${r.mode.padEnd(7)} ${String(r.events).padStart(7)} ${String(r.projects).padStart(9)}  ` +
      `${r.rssMB.toFixed(0).padStart(7)}  ${r.extMB.toFixed(0).padStart(12)}  ${r.dumpMs.toFixed(0).padStart(7)}  ${r.snapMB.toFixed(2).padStart(11)}`,
    );
  }
}

void main();
