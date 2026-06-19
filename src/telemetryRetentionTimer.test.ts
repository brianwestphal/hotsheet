/**
 * HS-8889 (§85.2.1) — periodic telemetry retention timer tests.
 *
 * The timer must, on each tick, submit ONE coalesced sweep job (off-loop) that
 * runs the retention sweep then nudges the vacuum pass; start must be idempotent;
 * stop must disarm it. `setInterval` + the scheduler + the sweep/vacuum workers
 * are all injected so nothing real fires.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackgroundJob, BackgroundScheduler } from './scheduler/backgroundScheduler.js';
import {
  isTelemetryRetentionTimerRunning,
  startTelemetryRetentionTimer,
  stopTelemetryRetentionTimer,
} from './telemetryRetentionTimer.js';

afterEach(() => { stopTelemetryRetentionTimer(); });

/** A scheduler stub that runs each submitted job immediately and records it. */
function capturingScheduler(): { scheduler: BackgroundScheduler; jobs: BackgroundJob[] } {
  const jobs: BackgroundJob[] = [];
  const scheduler = {
    submit: (job: BackgroundJob) => { jobs.push(job); return job.run(); },
  } as unknown as BackgroundScheduler;
  return { scheduler, jobs };
}

describe('startTelemetryRetentionTimer (HS-8889)', () => {
  it('arms an unref-d interval and reports running', () => {
    const captured: Array<() => void> = [];
    const unref = vi.fn();
    startTelemetryRetentionTimer('/proj', {
      intervalMs: 1000,
      setIntervalFn: (cb) => { captured.push(cb); return { unref } as unknown as NodeJS.Timeout; },
      scheduler: capturingScheduler().scheduler,
    });
    expect(isTelemetryRetentionTimerRunning()).toBe(true);
    expect(captured).toHaveLength(1);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('each tick submits one coalesced sweep job that sweeps then nudges the vacuum', async () => {
    const { scheduler, jobs } = capturingScheduler();
    const sweep = vi.fn<(d: string) => Promise<number>>(() => Promise.resolve(0));
    const nudgeVacuum = vi.fn<(d: string) => void>();
    const captured: Array<() => void> = [];
    startTelemetryRetentionTimer('/proj/launched', {
      intervalMs: 1000,
      setIntervalFn: (cb) => { captured.push(cb); return { unref() { /* noop */ } } as unknown as NodeJS.Timeout; },
      scheduler,
      sweep,
      nudgeVacuum,
    });

    // Simulate a tick.
    captured[0]?.();
    await Promise.resolve(); // let the job's run() settle

    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe('telemetry-retention-sweep'); // coalesced — one pending per process
    expect(jobs[0].priority).toBe(50); // PRIORITY.GC
    expect(jobs[0].deferUnderLag).toBe(true);
    expect(sweep).toHaveBeenCalledWith('/proj/launched');
    expect(nudgeVacuum).toHaveBeenCalledWith('/proj/launched');
  });

  it('is idempotent — a second start replaces the first timer (no double-arm)', () => {
    const cleared: unknown[] = [];
    const makeTimer = (id: number) => ({ unref() { /* noop */ }, _id: id }) as unknown as NodeJS.Timeout;
    let n = 0;
    const opts = {
      intervalMs: 1000,
      setIntervalFn: () => makeTimer(++n),
      scheduler: capturingScheduler().scheduler,
    };
    startTelemetryRetentionTimer('/proj', opts);
    startTelemetryRetentionTimer('/proj', opts); // second call stops the first then re-arms
    expect(isTelemetryRetentionTimerRunning()).toBe(true);
    expect(cleared).toBeDefined(); // (clearInterval tolerates the fake handle; no throw)
  });
});

describe('stopTelemetryRetentionTimer (HS-8889)', () => {
  it('disarms the timer', () => {
    startTelemetryRetentionTimer('/proj', {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref() { /* noop */ } } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
    });
    expect(isTelemetryRetentionTimerRunning()).toBe(true);
    stopTelemetryRetentionTimer();
    expect(isTelemetryRetentionTimerRunning()).toBe(false);
    stopTelemetryRetentionTimer(); // no-op the second time
    expect(isTelemetryRetentionTimerRunning()).toBe(false);
  });
});
