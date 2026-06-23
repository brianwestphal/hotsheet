/**
 * HS-8862 — periodic claim-lease sweep timer tests. Each tick submits ONE
 * coalesced sweep job (off-loop, GC, deferred); start is idempotent + unref'd;
 * stop disarms it. `setInterval`, the scheduler, and the sweep worker are all
 * injected so nothing real fires.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackgroundJob, BackgroundScheduler } from '../scheduler/backgroundScheduler.js';
import { isLeaseSweepTimerRunning, startLeaseSweepTimer, stopLeaseSweepTimer } from './leaseSweepTimer.js';

afterEach(() => { stopLeaseSweepTimer(); });

function capturingScheduler(): { scheduler: BackgroundScheduler; jobs: BackgroundJob[] } {
  const jobs: BackgroundJob[] = [];
  const scheduler = {
    submit: (job: BackgroundJob) => { jobs.push(job); return job.run(); },
  } as unknown as BackgroundScheduler;
  return { scheduler, jobs };
}

describe('startLeaseSweepTimer (HS-8862)', () => {
  it('arms an unref-d interval and reports running', () => {
    const unref = vi.fn();
    startLeaseSweepTimer('/proj', {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
    });
    expect(isLeaseSweepTimerRunning()).toBe(true);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('each tick submits one coalesced GC sweep job that runs the sweep', async () => {
    const { scheduler, jobs } = capturingScheduler();
    const sweep = vi.fn<() => Promise<number>>(() => Promise.resolve(2));
    const captured: Array<() => void> = [];
    startLeaseSweepTimer('/proj/launched', {
      intervalMs: 1000,
      setIntervalFn: (cb) => { captured.push(cb); return { unref() { /* noop */ } } as unknown as NodeJS.Timeout; },
      scheduler,
      sweep,
    });

    captured[0]?.();
    await Promise.resolve();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe('claim-lease-sweep');
    expect(jobs[0].priority).toBe(50); // PRIORITY.GC
    expect(jobs[0].deferUnderLag).toBe(true);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it('is idempotent — a second start replaces the first', () => {
    const opts = {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref() { /* noop */ } } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
    };
    startLeaseSweepTimer('/proj', opts);
    startLeaseSweepTimer('/proj', opts);
    expect(isLeaseSweepTimerRunning()).toBe(true);
  });
});

describe('stopLeaseSweepTimer (HS-8862)', () => {
  it('disarms the timer (idempotent)', () => {
    startLeaseSweepTimer('/proj', {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref() { /* noop */ } } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
    });
    expect(isLeaseSweepTimerRunning()).toBe(true);
    stopLeaseSweepTimer();
    expect(isLeaseSweepTimerRunning()).toBe(false);
    stopLeaseSweepTimer();
    expect(isLeaseSweepTimerRunning()).toBe(false);
  });
});
