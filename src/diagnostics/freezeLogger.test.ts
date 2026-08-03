/**
 * HS-8054 v3 — freezeLogger tests. Exercises the file-append helper, the
 * sync / async instrumentation wrappers, and the heartbeat detector
 * (with a synthetic event-loop block to fire it).
 */
import { mkdtempSync, promises as fsp, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getHeapStatistics } from 'v8';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { externalCeilingBytes } from '../db/memoryCeiling.js';
import { diagnosticsDir } from './diagnosticsDir.js';
import {
  _resetForTesting,
  _simulateHeartbeatGapForTesting,
  appendFreezeLog,
  FREEZE_LOG_FILENAME,
  FREEZE_LOG_MAX_BYTES,
  FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE,
  getRecentEventLoopLagMs,
  instrumentAsync,
  instrumentSync,
  isSuspendGap,
  memorySnapshot,
  onServerWake,
  setFreezeLogClusterCounter,
  setFreezeLogEvictionStats,
  startServerEventLoopHeartbeat,
  stopServerEventLoopHeartbeat,
  WAKE_GAP_THRESHOLD_MS,
} from './freezeLogger.js';

// HS-9531 — `tmpDir` is now the PROJECT a diagnostic came from, not where it is
// written. Every entry lands in one process-wide log under `HOTSHEET_HOME`, which
// each test relocates so the runs cannot see each other's lines (or the
// maintainer's real log — see the note in `vitest.setup.ts`).
let tmpDir: string;
let hotsheetHome: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hotsheet-freeze-test-'));
  hotsheetHome = mkdtempSync(join(tmpdir(), 'hotsheet-freeze-home-'));
  process.env.HOTSHEET_HOME = hotsheetHome;
});

afterEach(() => {
  _resetForTesting();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(hotsheetHome, { recursive: true, force: true }); } catch { /* */ }
});

/** The one process-wide log every writer now appends to. */
function freezeLogPath(): string {
  return join(diagnosticsDir(), FREEZE_LOG_FILENAME);
}

async function readFreezeLog(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(freezeLogPath(), 'utf8');
    return raw.split('\n').filter(line => line !== '');
  } catch {
    return [];
  }
}

describe('wake detection (HS-8726, corrected by HS-9520)', () => {
  // A suspend is simulated by WALL-clock running far ahead of the monotonic gap —
  // which is what an OS freeze actually looks like, since the monotonic clock does
  // not advance while the machine is asleep. Duration alone says nothing.
  const suspend = (wallMs: number): void => _simulateHeartbeatGapForTesting(200, wallMs);

  it('a real suspend (clocks diverge) fires onServerWake and resets the backpressure lag reading', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    suspend(3_600_000); // an hour of sleep; the loop itself only "missed" 200ms
    expect(seen).toEqual([3_600_000]);
    expect(getRecentEventLoopLagMs()).toBe(0); // the sleep gap must NOT poison backpressure
    unsub();
  });

  it('a normal block does NOT fire wake and DOES record the lag', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    _simulateHeartbeatGapForTesting(500); // clocks agree — a real 500ms block
    expect(seen).toEqual([]);
    expect(getRecentEventLoopLagMs()).toBe(500);
    unsub();
  });

  // HS-9520 — the regression that mattered. A 23s on-loop block used to be declared
  // a suspend purely because it was long, which both hid the worst blocks from the
  // log and ZEROED the lag the scheduler's backpressure reads — so it admitted more
  // work into an already-pinned loop. Measured in the wild on 2026-07-31.
  it('a LONG on-loop block is a block, not a suspend, and keeps the lag reading', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    _simulateHeartbeatGapForTesting(23_000); // clocks agree ⇒ genuine block
    expect(seen).toEqual([]);
    expect(getRecentEventLoopLagMs()).toBe(23_000); // backpressure MUST stay engaged
    unsub();
  });

  it('classifies by clock divergence, not by length, in both directions', () => {
    // Short + divergent is still a suspend candidate only above the floor…
    expect(isSuspendGap(50, 60)).toBe(false);
    // …a long gap with agreeing clocks is a block…
    expect(isSuspendGap(30_000, 30_010)).toBe(false);
    // …and a long gap where wall ran far ahead is a suspend.
    expect(isSuspendGap(200, 600_000)).toBe(true);
  });

  it('treats an ambiguous long gap as a BLOCK — the recoverable direction', () => {
    // If a platform's monotonic clock DID include suspend time, divergence is ~0.
    // Calling that a block only over-reports blocks and keeps backpressure on;
    // calling it a suspend is what wedged the server.
    expect(isSuspendGap(60_000, 60_000)).toBe(false);
  });

  it('unsubscribe stops further wake notifications', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    unsub();
    suspend(WAKE_GAP_THRESHOLD_MS + 1);
    expect(seen).toEqual([]);
  });

  it('logs a `server-wake` entry (not a misleading event-loop-blocked) for a real suspend', async () => {
    startServerEventLoopHeartbeat(tmpDir); // attaches heartbeatDataDir = tmpDir
    suspend(60_000);
    stopServerEventLoopHeartbeat();
    await new Promise(r => setTimeout(r, 20)); // let the async append flush
    const lines = await readFreezeLog();
    expect(lines.some(l => l.includes('"source":"server-wake"'))).toBe(true);
    expect(lines.some(l => l.includes('"source":"server-heartbeat"'))).toBe(false);
  });

  it('logs a LONG block as event-loop-blocked so it appears in the aggregates', async () => {
    // The two worst blocks of 2026-07-31 were absent from every "blocked" total
    // because they were filed as suspends. This is the assertion that stops that.
    startServerEventLoopHeartbeat(tmpDir);
    _simulateHeartbeatGapForTesting(23_000);
    stopServerEventLoopHeartbeat();
    await new Promise(r => setTimeout(r, 20));
    const lines = await readFreezeLog();
    expect(lines.some(l => l.includes('"source":"server-heartbeat"'))).toBe(true);
    expect(lines.some(l => l.includes('"source":"server-wake"'))).toBe(false);
  });
});

describe('appendFreezeLog (HS-8054 v3)', () => {
  it('appends a JSONL line under <dataDir>/freeze.log', async () => {
    await appendFreezeLog(tmpDir, {
      ts: '2026-05-04T08:00:00.000Z',
      source: 'client-observer',
      durationMs: 723,
      context: 'project-switch:Hot Sheet',
    });
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { ts: string; source: string; durationMs: number; context: string };
    expect(parsed.ts).toBe('2026-05-04T08:00:00.000Z');
    expect(parsed.source).toBe('client-observer');
    expect(parsed.durationMs).toBe(723);
    expect(parsed.context).toBe('project-switch:Hot Sheet');
  });

  it('serialises concurrent appends without interleaving partial JSON', async () => {
    // Fire 50 appends concurrently and assert every line parses cleanly.
    const writes = Array.from({ length: 50 }, (_, i) => appendFreezeLog(tmpDir, {
      ts: `2026-05-04T08:00:${String(i).padStart(2, '0')}.000Z`,
      source: 'server-heartbeat',
      durationMs: i * 10,
      context: `block-${i}`,
    }));
    await Promise.all(writes);
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(50);
    // Every line must round-trip — no half-flushed JSON.
    for (const line of lines) {
      const parsed = JSON.parse(line) as { context: string };
      expect(parsed.context).toMatch(/^block-\d+$/);
    }
  });

  it('does NOT rotate when the file size + new line fits under the cap (HS-8163)', async () => {
    // Pre-fill the file with content well under the cap. The append
    // should just add a line on top.
    const pre = 'a'.repeat(1000) + '\n';
    await fsp.writeFile(freezeLogPath(), pre, 'utf8');
    await appendFreezeLog(tmpDir, {
      ts: '2026-05-15T08:00:00.000Z',
      source: 'server-heartbeat',
      durationMs: 200,
      context: 'block-A',
    });
    const after = await fsp.readFile(freezeLogPath(), 'utf8');
    // Pre-content preserved; new line appended at end. No truncation
    // marker inserted (file didn't exceed the cap).
    expect(after.startsWith(pre)).toBe(true);
    expect(after).not.toContain('"freeze.log-truncated"');
    expect(after).toContain('"context":"block-A"');
  });

  it('rotates by dropping the head when the file would exceed FREEZE_LOG_MAX_BYTES (HS-8163)', async () => {
    // Pre-fill with content larger than the cap so the next append
    // triggers rotation. Use a single big string padded out with
    // newlines so the rotation's "advance to next \n" path has
    // boundaries to land on. The lines themselves are not valid
    // JSON — that's fine; rotation logic doesn't parse them.
    const line = 'x'.repeat(1023) + '\n'; // 1024 B per line
    const lines = Math.ceil(FREEZE_LOG_MAX_BYTES / 1024) + 100; // ~1.1 MB → safely over the cap
    const pre = line.repeat(lines);
    await fsp.writeFile(freezeLogPath(), pre, 'utf8');
    const preBytes = Buffer.byteLength(pre, 'utf8');
    expect(preBytes).toBeGreaterThan(FREEZE_LOG_MAX_BYTES);

    await appendFreezeLog(tmpDir, {
      ts: '2026-05-15T08:00:01.000Z',
      source: 'server-heartbeat',
      durationMs: 250,
      context: 'after-rotate',
    });

    const after = await fsp.readFile(freezeLogPath(), 'utf8');
    const afterBytes = Buffer.byteLength(after, 'utf8');
    // Post-rotation the file is well under the cap (head dropped,
    // tail kept, marker prepended, new line appended).
    expect(afterBytes).toBeLessThan(FREEZE_LOG_MAX_BYTES);
    // The first line is the truncation marker — JSON-parseable + has
    // the new source string.
    const firstNewline = after.indexOf('\n');
    expect(firstNewline).toBeGreaterThan(0);
    const markerLine = after.slice(0, firstNewline);
    const marker = JSON.parse(markerLine) as { source: string; context: string };
    expect(marker.source).toBe('freeze.log-truncated');
    expect(marker.context).toMatch(/head dropped/);
    // The new append landed at the bottom. Matched on the parsed last line rather
    // than a byte-suffix: HS-9531 appends a `project` field after `context`, and a
    // suffix assertion silently breaks every time the entry shape grows.
    const lastLine = after.trimEnd().split('\n').at(-1) ?? '';
    expect((JSON.parse(lastLine) as { context: string }).context).toBe('after-rotate');
    // Tail bytes preserved approximately at the target (within one
    // line of slack — the "advance to next \n" rule means we keep
    // whatever's after the first newline at-or-past the target offset).
    const slack = 2 * 1024;
    expect(afterBytes).toBeLessThanOrEqual(FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE + slack);
  });

  it('writes only the new line when the file is missing — no rotation, no error (HS-8163)', async () => {
    // First-ever append: stat throws ENOENT, rotate path bails early,
    // appendFile creates the file with just the new line.
    await appendFreezeLog(tmpDir, {
      ts: '2026-05-15T08:00:00.000Z',
      source: 'client-heartbeat',
      durationMs: 200,
      context: 'first-write',
    });
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { context: string; source: string };
    expect(parsed.context).toBe('first-write');
    expect(parsed.source).toBe('client-heartbeat');
  });

  it('survives an unwritable diagnostics directory without throwing', async () => {
    // HS-9531 — the target moved. `dataDir` is now provenance only, so an
    // unreachable dataDir is no longer a write failure at all; what has to stay
    // non-fatal is an unwritable GLOBAL diagnostics dir. Pointing HOTSHEET_HOME at
    // a path under a regular FILE makes every mkdir/append under it fail.
    const blocker = join(tmpDir, 'not-a-directory');
    await fsp.writeFile(blocker, 'x', 'utf8');
    process.env.HOTSHEET_HOME = join(blocker, 'nested');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* */ });
    try {
      await appendFreezeLog(join(tmpDir, 'some-project', '.hotsheet'), {
        ts: '2026-05-04T08:00:00.000Z',
        source: 'client-heartbeat',
        durationMs: 200,
        context: 'oops',
      });
      // No throw — failure is logged as a warn.
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('instrumentSync (HS-8054 v3)', () => {
  it('returns the wrapped function value verbatim', () => {
    const result = instrumentSync<number>(tmpDir, 'fast-block', () => 42);
    expect(result).toBe(42);
  });

  it('does NOT log fast blocks under the threshold', async () => {
    instrumentSync<undefined>(tmpDir, 'fast-block', () => undefined);
    // Give the queued append (if any) a tick to flush.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(0);
  });

  it('logs blocks ≥ 100 ms with the caller-supplied label', async () => {
    instrumentSync(tmpDir, 'slow-block:foo', () => {
      // Spin for ~120 ms.
      const start = Date.now();
      while (Date.now() - start < 120) { /* spin */ }
    });
    // Wait for queue to flush.
    await new Promise(r => setTimeout(r, 50));
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { source: string; context: string; durationMs: number };
    expect(parsed.source).toBe('server-instrument-sync');
    expect(parsed.context).toBe('slow-block:foo');
    expect(parsed.durationMs).toBeGreaterThanOrEqual(100);
  });

  it('logs duration even when the wrapped function throws', async () => {
    expect(() => instrumentSync(tmpDir, 'throwing-block', () => {
      const start = Date.now();
      while (Date.now() - start < 110) { /* spin */ }
      throw new Error('boom');
    })).toThrow('boom');
    await new Promise(r => setTimeout(r, 50));
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(1);
  });
});

describe('instrumentAsync (HS-8054 v3)', () => {
  it('awaits the wrapped function and returns its resolved value', async () => {
    const result = await instrumentAsync(tmpDir, 'fast-async', () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('logs async blocks that exceed the threshold', async () => {
    await instrumentAsync(tmpDir, 'slow-async:foo', async () => {
      await new Promise(r => setTimeout(r, 130));
    });
    await new Promise(r => setTimeout(r, 50));
    const lines = await readFreezeLog();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { source: string; context: string };
    expect(parsed.source).toBe('server-instrument-async');
    expect(parsed.context).toBe('slow-async:foo');
  });
});

describe('startServerEventLoopHeartbeat (HS-8054 v3)', () => {
  it('is idempotent — second start is a no-op', () => {
    startServerEventLoopHeartbeat(tmpDir);
    startServerEventLoopHeartbeat(tmpDir); // second call must not start a second timer
    stopServerEventLoopHeartbeat();
    // No assertion needed beyond "didn't throw + no timer leaks".
  });

  it('detects a synthetic event-loop block and writes to freeze.log', async () => {
    startServerEventLoopHeartbeat(tmpDir);
    // Block the event loop for ~250 ms — guaranteed to exceed the
    // 100 ms threshold AND straddle multiple heartbeat ticks.
    const start = Date.now();
    while (Date.now() - start < 250) { /* spin */ }
    // Allow the heartbeat after the block to fire + the append to flush.
    await new Promise(r => setTimeout(r, 100));
    stopServerEventLoopHeartbeat();
    const lines = await readFreezeLog();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // HS-9421 — select by SOURCE, not by position: the heartbeat now also starts
    // the memory sampler, which writes a `server-memory` baseline entry first.
    // Position was always incidental to what this test is checking.
    const entries = lines.map(l => JSON.parse(l) as { source: string; durationMs: number; extra?: Record<string, unknown> });
    const block = entries.find(e => e.source === 'server-heartbeat');
    expect(block, 'no server-heartbeat entry was written for the synthetic block').toBeDefined();
    expect(block!.durationMs).toBeGreaterThanOrEqual(100);
    // HS-9421 — a block entry now carries the memory picture, so a GC-thrash
    // wedge is distinguishable from a slow query without an inspector attach.
    expect(block!.extra?.externalMb, 'block entry is missing the memory snapshot').toBeTypeOf('number');
    expect(block!.extra?.heapLimitMb).toBeTypeOf('number');
    expect(block!.extra?.openPGLiteClusters).toBeTypeOf('number');
  });

  // HS-9421 — the trend INTO a wedge. During the HS-9420 crash loop freeze.log
  // recorded nothing at all (the loop never recovers, so the heartbeat never got
  // to log) and the file just stopped, which reads like a clean exit.
  it('writes a baseline memory sample as soon as the heartbeat starts', async () => {
    startServerEventLoopHeartbeat(tmpDir);
    await new Promise(r => setTimeout(r, 50));
    stopServerEventLoopHeartbeat();
    const entries = (await readFreezeLog()).map(l => JSON.parse(l) as { source: string; extra?: Record<string, unknown> });
    const mem = entries.find(e => e.source === 'server-memory');
    expect(mem, 'no baseline server-memory entry').toBeDefined();
    expect(mem!.extra?.rssMb).toBeTypeOf('number');
    expect(mem!.extra?.externalMb).toBeTypeOf('number');
    // HS-9470 — the eviction counters ride the same snapshot. Absent until the
    // boot wiring injects the reader, which is the state under test here.
    expect(mem!.extra?.evictChurn).toBeUndefined();
    expect(mem!.extra?.memoryPressure).toBeTypeOf('boolean');
  });

  it('reports the open-PGLite-cluster count when a counter is registered', async () => {
    setFreezeLogClusterCounter(() => 18); // the HS-9420 number
    startServerEventLoopHeartbeat(tmpDir);
    await new Promise(r => setTimeout(r, 50));
    stopServerEventLoopHeartbeat();
    const entries = (await readFreezeLog()).map(l => JSON.parse(l) as { source: string; extra?: Record<string, unknown> });
    const mem = entries.find(e => e.source === 'server-memory');
    expect(mem!.extra?.openPGLiteClusters).toBe(18);
  });

  it('reports -1 for the cluster count when no counter is registered', () => {
    // Distinguishes "nobody wired the counter" from a genuine zero.
    expect(memorySnapshot().openPGLiteClusters).toBe(-1);
  });

  it('flags memory pressure only above the warn ratio', () => {
    const snap = memorySnapshot();
    // A test process is nowhere near the limit, so this must be false — the flag
    // has to be quiet in the normal case or it's noise.
    expect(snap.memoryPressure).toBe(false);
    expect(snap.usedPctOfCeiling).toBeLessThan(75);
  });

  // HS-9559 — the denominator. HS-9555 moved the EVICTION guards onto the
  // docs/128 ceiling but left these diagnostics dividing by V8's heap_size_limit,
  // so the two halves of docs/128 disagreed: a post-fix freeze log reported
  // `externalMb: 2199` as 56% when against the real ceiling it is 28%.
  it('measures against the cluster budget ceiling, not V8’s heap limit', () => {
    const snap = memorySnapshot();
    expect(snap.ceilingMb).toBe(Math.round(externalCeilingBytes() / (1024 * 1024)));

    const used = (snap.heapUsedMb as number) + (snap.externalMb as number);
    const expected = Math.round((used / (snap.ceilingMb as number)) * 100);
    // Within 1 point — the snapshot rounds to whole MB before we do.
    expect(Math.abs((snap.usedPctOfCeiling as number) - expected)).toBeLessThanOrEqual(1);
  });

  it('still reports V8’s heap limit separately, since it bounds heapUsed', () => {
    // Keeping BOTH is the point: the old field name meant a reader could not tell
    // which denominator a line used. They must not be conflated again.
    const snap = memorySnapshot();
    expect(snap.heapLimitMb).toBe(Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)));
    expect(snap.usedPctOfLimit).toBeUndefined(); // renamed, so old logs stay distinguishable
  });

  it('never divides by a zero ceiling', () => {
    // A NaN percentage in a freeze log is worse than none — it reads as a bug in
    // the reader, not in the process.
    expect(Number.isFinite(memorySnapshot().usedPctOfCeiling)).toBe(true);
  });
});

describe('eviction counters in the memory snapshot (HS-9470)', () => {
  afterEach(() => { setFreezeLogEvictionStats(null as unknown as () => never); });

  it('includes the counters once the reader is injected', () => {
    setFreezeLogEvictionStats(() => ({
      byMode: { cap: 3, idle: 7, headroom: 1 }, project: 4, telemetry: 7, churn: 2,
    }));
    const snap = memorySnapshot();
    expect(snap.evictCap).toBe(3);
    expect(snap.evictIdle).toBe(7);
    expect(snap.evictHeadroom).toBe(1);
    expect(snap.evictProject).toBe(4);
    expect(snap.evictTelemetry).toBe(7);
    // The field to read first: reopens we paid for by evicting too eagerly.
    expect(snap.evictChurn).toBe(2);
  });

  it('omits them entirely before the reader is wired, rather than reporting zeros', () => {
    // Zeros would be a lie — indistinguishable from "no evictions happened".
    setFreezeLogEvictionStats(null as unknown as () => never);
    const snap = memorySnapshot();
    expect(snap.evictChurn).toBeUndefined();
    expect(snap.externalMb).toBeTypeOf('number'); // the rest still there
  });
});
