/**
 * HS-9110 — periodic server-side worker-pool reconcile loop tests.
 *
 * Two layers:
 *   1. The timer: each tick submits ONE coalesced reconcile pass (off-loop, GC,
 *      deferred); start is idempotent + unref'd; stop disarms it. `setInterval`,
 *      the scheduler, and the pass are injected so nothing real fires.
 *   2. `reconcileEnabledHeadlessPools`: the per-project gating — only enabled +
 *      `targetN > 0` + git + a live channel projects are reconciled; a per-project
 *      failure doesn't abort the pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackgroundJob, BackgroundScheduler } from '../scheduler/backgroundScheduler.js';
import {
  isPoolReconcileTimerRunning,
  type ReconcileEnabledDeps,
  reconcileEnabledHeadlessPools,
  startPoolReconcileTimer,
  stopPoolReconcileTimer,
} from './poolReconcileTimer.js';

afterEach(() => { stopPoolReconcileTimer(); });

function capturingScheduler(): { scheduler: BackgroundScheduler; jobs: BackgroundJob[] } {
  const jobs: BackgroundJob[] = [];
  const scheduler = {
    submit: (job: BackgroundJob) => { jobs.push(job); return job.run(); },
  } as unknown as BackgroundScheduler;
  return { scheduler, jobs };
}

/** All gates pass by default; tests flip individual deps to assert the gating. */
function allPassDeps(overrides: Partial<ReconcileEnabledDeps> = {}): ReconcileEnabledDeps {
  return {
    listProjects: () => [],
    isEnabled: () => true,
    poolTarget: () => 2,
    channelAlive: () => Promise.resolve(true),
    gitRepo: () => true,
    secretFor: () => 'sek',
    repoRootFor: (dir) => `${dir}/root`,
    reconcile: vi.fn(() => Promise.resolve({})),
    ...overrides,
  };
}

describe('startPoolReconcileTimer (HS-9110)', () => {
  it('arms an unref-d interval and reports running', () => {
    const unref = vi.fn();
    startPoolReconcileTimer('/proj', {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
      pass: () => Promise.resolve(),
    });
    expect(isPoolReconcileTimerRunning()).toBe(true);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('each tick submits one coalesced GC reconcile pass that runs', async () => {
    const { scheduler, jobs } = capturingScheduler();
    const pass = vi.fn<(dir: string) => Promise<void>>(() => Promise.resolve());
    const captured: Array<() => void> = [];
    startPoolReconcileTimer('/proj/launched', {
      intervalMs: 1000,
      setIntervalFn: (cb) => { captured.push(cb); return { unref() { /* noop */ } } as unknown as NodeJS.Timeout; },
      scheduler,
      pass,
    });

    captured[0]?.();
    await Promise.resolve();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe('worker-pool-reconcile');
    expect(jobs[0].priority).toBe(50); // PRIORITY.GC
    expect(jobs[0].deferUnderLag).toBe(true);
    expect(pass).toHaveBeenCalledWith('/proj/launched');
  });

  it('is idempotent — a second start replaces the first', () => {
    const opts = {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref() { /* noop */ } } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
      pass: () => Promise.resolve(),
    };
    startPoolReconcileTimer('/proj', opts);
    startPoolReconcileTimer('/proj', opts);
    expect(isPoolReconcileTimerRunning()).toBe(true);
  });
});

describe('stopPoolReconcileTimer (HS-9110)', () => {
  it('disarms the timer (idempotent)', () => {
    startPoolReconcileTimer('/proj', {
      intervalMs: 1000,
      setIntervalFn: () => ({ unref() { /* noop */ } } as unknown as NodeJS.Timeout),
      scheduler: capturingScheduler().scheduler,
      pass: () => Promise.resolve(),
    });
    expect(isPoolReconcileTimerRunning()).toBe(true);
    stopPoolReconcileTimer();
    expect(isPoolReconcileTimerRunning()).toBe(false);
    stopPoolReconcileTimer();
    expect(isPoolReconcileTimerRunning()).toBe(false);
  });
});

describe('reconcileEnabledHeadlessPools gating (HS-9110)', () => {
  it('reconciles an enabled, targeted, live, git project', async () => {
    const reconcile = vi.fn(() => Promise.resolve({}));
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({ reconcile }));
    expect(n).toBe(1);
    expect(reconcile).toHaveBeenCalledWith('sek', '/launched', '/launched/root');
  });

  it('skips a project where headless is disabled', async () => {
    const reconcile = vi.fn(() => Promise.resolve({}));
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({ isEnabled: () => false, reconcile }));
    expect(n).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('skips when targetN <= 0 (empty-pool back-off, §91.7)', async () => {
    const reconcile = vi.fn(() => Promise.resolve({}));
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({ poolTarget: () => 0, reconcile }));
    expect(n).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('skips when the channel is not alive', async () => {
    const reconcile = vi.fn(() => Promise.resolve({}));
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({ channelAlive: () => Promise.resolve(false), reconcile }));
    expect(n).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('skips a non-git project (no channelAlive probe needed)', async () => {
    const reconcile = vi.fn(() => Promise.resolve({}));
    const channelAlive = vi.fn(() => Promise.resolve(true));
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({ gitRepo: () => false, channelAlive, reconcile }));
    expect(n).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
    expect(channelAlive).not.toHaveBeenCalled(); // git gate is cheaper, checked first
  });

  it('walks the launched dir plus the registered project list (deduped)', async () => {
    const reconcile = vi.fn(() => Promise.resolve({}));
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({
      listProjects: () => ['/other', '/launched'], // dup of launched is deduped
      reconcile,
    }));
    expect(n).toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('a per-project failure is swallowed and the pass continues', async () => {
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    const n = await reconcileEnabledHeadlessPools('/launched', allPassDeps({
      listProjects: () => ['/other'],
      reconcile,
    }));
    expect(n).toBe(1); // only the second succeeded
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
