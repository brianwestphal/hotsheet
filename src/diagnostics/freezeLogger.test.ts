/**
 * HS-8054 v3 — freezeLogger tests. Exercises the file-append helper, the
 * sync / async instrumentation wrappers, and the heartbeat detector
 * (with a synthetic event-loop block to fire it).
 */
import { mkdtempSync, promises as fsp, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  memorySnapshot,
  onServerWake,
  setFreezeLogClusterCounter,
  setFreezeLogEvictionStats,
  startServerEventLoopHeartbeat,
  stopServerEventLoopHeartbeat,
  WAKE_GAP_THRESHOLD_MS,
} from './freezeLogger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hotsheet-freeze-test-'));
});

afterEach(() => {
  _resetForTesting();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

async function readFreezeLog(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(join(tmpDir, FREEZE_LOG_FILENAME), 'utf8');
    return raw.split('\n').filter(line => line !== '');
  } catch {
    return [];
  }
}

describe('wake detection (HS-8726)', () => {
  it('a suspend-sized gap fires onServerWake and resets the backpressure lag reading', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    _simulateHeartbeatGapForTesting(WAKE_GAP_THRESHOLD_MS + 5_000);
    expect(seen).toEqual([WAKE_GAP_THRESHOLD_MS + 5_000]);
    expect(getRecentEventLoopLagMs()).toBe(0); // the sleep gap must NOT poison backpressure
    unsub();
  });

  it('a normal block does NOT fire wake and DOES record the lag', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    _simulateHeartbeatGapForTesting(500); // a real 500ms block — below the suspend threshold
    expect(seen).toEqual([]);
    expect(getRecentEventLoopLagMs()).toBe(500);
    unsub();
  });

  it('unsubscribe stops further wake notifications', () => {
    const seen: number[] = [];
    const unsub = onServerWake((gap) => { seen.push(gap); });
    unsub();
    _simulateHeartbeatGapForTesting(WAKE_GAP_THRESHOLD_MS + 1);
    expect(seen).toEqual([]);
  });

  it('logs a `server-wake` entry (not a misleading event-loop-blocked) when a dataDir is attached', async () => {
    startServerEventLoopHeartbeat(tmpDir); // attaches heartbeatDataDir = tmpDir
    _simulateHeartbeatGapForTesting(WAKE_GAP_THRESHOLD_MS + 60_000);
    stopServerEventLoopHeartbeat();
    await new Promise(r => setTimeout(r, 20)); // let the async append flush
    const lines = await readFreezeLog();
    expect(lines.some(l => l.includes('"source":"server-wake"'))).toBe(true);
    expect(lines.some(l => l.includes('"source":"server-heartbeat"'))).toBe(false);
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
    await fsp.writeFile(join(tmpDir, FREEZE_LOG_FILENAME), pre, 'utf8');
    await appendFreezeLog(tmpDir, {
      ts: '2026-05-15T08:00:00.000Z',
      source: 'server-heartbeat',
      durationMs: 200,
      context: 'block-A',
    });
    const after = await fsp.readFile(join(tmpDir, FREEZE_LOG_FILENAME), 'utf8');
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
    await fsp.writeFile(join(tmpDir, FREEZE_LOG_FILENAME), pre, 'utf8');
    const preBytes = Buffer.byteLength(pre, 'utf8');
    expect(preBytes).toBeGreaterThan(FREEZE_LOG_MAX_BYTES);

    await appendFreezeLog(tmpDir, {
      ts: '2026-05-15T08:00:01.000Z',
      source: 'server-heartbeat',
      durationMs: 250,
      context: 'after-rotate',
    });

    const after = await fsp.readFile(join(tmpDir, FREEZE_LOG_FILENAME), 'utf8');
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
    // The new append landed at the bottom.
    expect(after.endsWith('"context":"after-rotate"}\n')).toBe(true);
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

  it('survives an unwritable dataDir without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* */ });
    try {
      // Path that doesn't exist — appendFile throws ENOENT under it.
      await appendFreezeLog(join(tmpDir, 'does-not-exist'), {
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
    expect(snap.usedPctOfLimit).toBeLessThan(75);
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
