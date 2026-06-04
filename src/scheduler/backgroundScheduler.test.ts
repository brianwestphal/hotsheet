/**
 * HS-8724 — unit coverage for the central background-work scheduler. Exercises
 * the five guarantees (concurrency cap, coalescing, priority, fairness,
 * lag-backpressure) plus error isolation, onIdle, and clear(). Jobs are driven
 * by manual gates so we can observe queue state at each step; the only timing
 * dependence is the lag re-drain test, which uses a short real-timer delay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BackgroundJob,
  type BackgroundScheduler,
  createBackgroundScheduler,
  PRIORITY,
} from './backgroundScheduler.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Let queued microtasks (the `finally → drain` chain after a job resolves)
 *  settle without leaning on real time. */
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** A gated job: `run` records its start in `order` then blocks until `resolve`
 *  is called. */
function gatedJob(
  key: string,
  order: string[],
  opts: Partial<BackgroundJob> = {},
): { job: BackgroundJob; resolve: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    job: {
      key,
      priority: opts.priority ?? PRIORITY.MARKDOWN_SYNC,
      projectKey: opts.projectKey,
      deferUnderLag: opts.deferUnderLag,
      exclusiveGroup: opts.exclusiveGroup,
      run: vi.fn(async () => { order.push(key); await gate; }),
    },
    resolve: () => release(),
  };
}

/** An auto-completing job: records its start, resolves immediately. */
function autoJob(key: string, order: string[], opts: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    key,
    priority: opts.priority ?? PRIORITY.MARKDOWN_SYNC,
    projectKey: opts.projectKey,
    deferUnderLag: opts.deferUnderLag,
    exclusiveGroup: opts.exclusiveGroup,
    run: vi.fn(() => { order.push(key); return Promise.resolve(); }),
  };
}

let scheduler: BackgroundScheduler | null = null;
afterEach(() => { scheduler?.clear(); scheduler = null; });

describe('bounded concurrency', () => {
  it('runs at most `concurrency` jobs at once; the rest wait', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 2 });
    const a = gatedJob('a', order);
    const b = gatedJob('b', order);
    const c = gatedJob('c', order);
    void scheduler.submit(a.job);
    void scheduler.submit(b.job);
    void scheduler.submit(c.job);

    expect(scheduler.runningCount()).toBe(2);
    expect(scheduler.pendingCount()).toBe(1);
    expect(order).toEqual(['a', 'b']);

    a.resolve();
    await flush();
    expect(scheduler.runningCount()).toBe(2); // c took a's slot
    expect(order).toEqual(['a', 'b', 'c']);

    b.resolve();
    c.resolve();
    await scheduler.onIdle();
  });
});

describe('coalescing', () => {
  it('a repeated key while one slot is busy collapses to a single pending job', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const blocker = gatedJob('blocker', order);
    void scheduler.submit(blocker.job);
    expect(scheduler.runningCount()).toBe(1);

    // Five submits of the same key while the slot is busy → one pending entry.
    const x = autoJob('x', order);
    for (let i = 0; i < 5; i++) void scheduler.submit({ ...x, run: x.run });
    expect(scheduler.pendingCount()).toBe(1);

    blocker.resolve();
    await scheduler.onIdle();
    expect(x.run).toHaveBeenCalledTimes(1); // ran exactly once despite 5 submits
    expect(order).toEqual(['blocker', 'x']);
  });

  it('a re-submit of a currently-running key re-runs once after it finishes', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const x = gatedJob('x', order);
    void scheduler.submit(x.job);
    expect(scheduler.runningCount()).toBe(1);

    // Re-submit the running key — must be held, not started in parallel.
    const x2 = gatedJob('x', order);
    void scheduler.submit(x2.job);
    expect(scheduler.runningCount()).toBe(1);
    expect(scheduler.pendingCount()).toBe(1);

    x.resolve();
    await flush();
    expect(scheduler.runningCount()).toBe(1); // the re-submitted x now runs
    x2.resolve();
    await scheduler.onIdle();
    expect(order).toEqual(['x', 'x']);
  });
});

describe('priority', () => {
  it('higher priority (lower number) runs before lower priority', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const blocker = gatedJob('blocker', order, { priority: PRIORITY.GIT_STATUS });
    void scheduler.submit(blocker.job);

    void scheduler.submit(autoJob('lo', order, { priority: PRIORITY.BACKUP }));
    void scheduler.submit(autoJob('hi', order, { priority: PRIORITY.GIT_STATUS }));

    blocker.resolve();
    await scheduler.onIdle();
    expect(order).toEqual(['blocker', 'hi', 'lo']);
  });
});

describe('fairness', () => {
  it('round-robins across projects within a priority tier (least-recently-served first)', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const blocker = gatedJob('blocker', order, { projectKey: 'Z' });
    void scheduler.submit(blocker.job);

    // Two jobs for project A, one for B — all same tier. Expect A, B, A:
    // the first A and B are both unserved (insertion order breaks the tie → A
    // first), then B is least-recently-served, then the second A.
    void scheduler.submit(autoJob('a1', order, { projectKey: 'A' }));
    void scheduler.submit(autoJob('a2', order, { projectKey: 'A' }));
    void scheduler.submit(autoJob('b1', order, { projectKey: 'B' }));

    blocker.resolve();
    await scheduler.onIdle();
    expect(order).toEqual(['blocker', 'a1', 'b1', 'a2']);
  });
});

describe('backpressure (deferUnderLag)', () => {
  it('holds a deferrable job while lag is high, then runs it once lag drops', async () => {
    const order: string[] = [];
    let lag = 1000; // start above threshold
    scheduler = createBackgroundScheduler({
      concurrency: 2,
      lagProvider: () => lag,
      lagThresholdMs: 200,
      reDrainDelayMs: 10,
    });

    void scheduler.submit(autoJob('backup', order, { deferUnderLag: true, priority: PRIORITY.BACKUP }));
    expect(scheduler.runningCount()).toBe(0); // deferred
    expect(scheduler.pendingCount()).toBe(1);

    lag = 0; // loop calms
    await wait(30); // re-drain timer fires
    await scheduler.onIdle();
    expect(order).toEqual(['backup']);
  });

  it('a non-deferrable (durability-critical) job runs even under high lag', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({
      concurrency: 2,
      lagProvider: () => 5000, // permanently high
      lagThresholdMs: 200,
    });
    void scheduler.submit(autoJob('snapshot', order, { deferUnderLag: false, priority: PRIORITY.SNAPSHOT }));
    await scheduler.onIdle();
    expect(order).toEqual(['snapshot']);
  });

  it('does not let a deferred low-priority job block a runnable high-priority one', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({
      concurrency: 1,
      lagProvider: () => 5000,
      lagThresholdMs: 200,
      reDrainDelayMs: 10,
    });
    void scheduler.submit(autoJob('backup', order, { deferUnderLag: true, priority: PRIORITY.BACKUP }));
    void scheduler.submit(autoJob('git', order, { deferUnderLag: false, priority: PRIORITY.GIT_STATUS }));
    // Can't await onIdle here — the deferred backup never drains under sustained
    // lag (that's the point). Give git time to run + re-drain timer to re-check.
    await wait(30);
    expect(order).toEqual(['git']); // git ran; backup still deferred under sustained lag
    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe('error isolation', () => {
  it('a rejecting job is reported and does not stall the queue', async () => {
    const order: string[] = [];
    const onError = vi.fn();
    scheduler = createBackgroundScheduler({ concurrency: 1, onError });
    void scheduler.submit({ key: 'boom', priority: PRIORITY.MARKDOWN_SYNC, run: () => Promise.reject(new Error('nope')) });
    void scheduler.submit(autoJob('after', order));
    await scheduler.onIdle();
    expect(onError).toHaveBeenCalledWith('boom', expect.any(Error));
    expect(order).toEqual(['after']);
  });
});

describe('noteWake — post-wake drain stagger (HS-8726)', () => {
  it('caps effective concurrency to 1 during the post-wake window even though concurrency is higher', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 3, wakeStaggerWindowMs: 300, wakeStaggerStepMs: 30 });
    scheduler.noteWake();
    void scheduler.submit(autoJob('a', order));
    void scheduler.submit(autoJob('b', order));
    void scheduler.submit(autoJob('c', order));

    // Without the wake window, concurrency 3 would start all three at once;
    // during the window only ONE runs at a time.
    expect(scheduler.runningCount()).toBe(1);
    expect(scheduler.pendingCount()).toBe(2);

    // The staggered drain still completes every job (spaced ~30ms apart).
    await scheduler.onIdle();
    expect([...order].sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not stagger when no wake has been signalled (normal concurrency)', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 3, wakeStaggerWindowMs: 300, wakeStaggerStepMs: 30 });
    void scheduler.submit(autoJob('a', order));
    void scheduler.submit(autoJob('b', order));
    void scheduler.submit(autoJob('c', order));
    expect(scheduler.runningCount()).toBe(3); // full concurrency, no wake window open
    await scheduler.onIdle();
  });
});

describe('exclusiveGroup', () => {
  it('runs at most one job per group even when the concurrency cap allows more', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 2 });
    const a = gatedJob('a', order, { exclusiveGroup: 'backup' });
    const b = gatedJob('b', order, { exclusiveGroup: 'backup' });
    void scheduler.submit(a.job);
    void scheduler.submit(b.job);

    // Both could fit under concurrency 2, but the shared group serializes them.
    expect(scheduler.runningCount()).toBe(1);
    expect(order).toEqual(['a']);

    a.resolve();
    await flush();
    expect(order).toEqual(['a', 'b']);
    b.resolve();
    await scheduler.onIdle();
  });

  it('a different-group (or groupless) job still runs concurrently', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 2 });
    const backup = gatedJob('backup', order, { exclusiveGroup: 'backup' });
    const snapshot = gatedJob('snapshot', order); // no group
    void scheduler.submit(backup.job);
    void scheduler.submit(snapshot.job);

    expect(scheduler.runningCount()).toBe(2); // backup + snapshot overlap
    backup.resolve();
    snapshot.resolve();
    await scheduler.onIdle();
  });
});

describe('awaitable submit', () => {
  it('the returned promise resolves after the job completes', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const x = gatedJob('x', order);
    const done = scheduler.submit(x.job);
    let resolved = false;
    void done.then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false); // still running (gated)
    x.resolve();
    await done;
    expect(resolved).toBe(true);
  });

  it('a re-submit during a run resolves only after the NEXT run, not the current one', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const x1 = gatedJob('x', order);
    void scheduler.submit(x1.job); // running

    const x2 = gatedJob('x', order);
    const done2 = scheduler.submit(x2.job); // queued behind the running x
    let done2Resolved = false;
    void done2.then(() => { done2Resolved = true; });

    x1.resolve();
    await flush();
    expect(done2Resolved).toBe(false); // x2 is now running, not yet done
    x2.resolve();
    await done2;
    expect(done2Resolved).toBe(true);
    expect(order).toEqual(['x', 'x']);
  });

  it('clear() resolves awaiters of dropped pending jobs (callers do not hang)', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const blocker = gatedJob('blocker', order);
    void scheduler.submit(blocker.job);
    const droppedDone = scheduler.submit(autoJob('dropped', order));

    scheduler.clear();
    await expect(droppedDone).resolves.toBeUndefined();
    blocker.resolve();
  });
});

describe('onIdle + clear', () => {
  it('onIdle resolves immediately when nothing is queued', async () => {
    scheduler = createBackgroundScheduler();
    await expect(scheduler.onIdle()).resolves.toBeUndefined();
  });

  it('clear() drops pending jobs (in-flight runs are left to finish)', async () => {
    const order: string[] = [];
    scheduler = createBackgroundScheduler({ concurrency: 1 });
    const blocker = gatedJob('blocker', order);
    void scheduler.submit(blocker.job);
    void scheduler.submit(autoJob('dropped', order));
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.clear();
    expect(scheduler.pendingCount()).toBe(0);

    blocker.resolve();
    await flush();
    expect(order).toEqual(['blocker']); // 'dropped' never ran
  });
});
