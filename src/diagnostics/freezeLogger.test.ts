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
  appendFreezeLog,
  FREEZE_LOG_FILENAME,
  FREEZE_LOG_MAX_BYTES,
  FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE,
  instrumentAsync,
  instrumentSync,
  startServerEventLoopHeartbeat,
  stopServerEventLoopHeartbeat,
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
    const parsed = JSON.parse(lines[0]) as { source: string; durationMs: number };
    expect(parsed.source).toBe('server-heartbeat');
    expect(parsed.durationMs).toBeGreaterThanOrEqual(100);
  });
});
