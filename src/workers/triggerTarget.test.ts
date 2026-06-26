// HS-9084 (docs/103 §103.2 / §103.4) — the busy-worker warn gate. Commanding a
// worker that is mid claim/lease loop (`working`) interleaves with its work, so
// the picker confirms first unless the command is worker-safe.
import { describe, expect, it } from 'vitest';

import type { ChannelTriggerTarget } from '../api/channel.js';
import { type WorkerTargetSlot, workerTargetWarning } from './triggerTarget.js';

const idle: WorkerTargetSlot = { worktreePath: '/wt/a', state: 'idle', label: 'worker-1' };
const working: WorkerTargetSlot = { worktreePath: '/wt/b', state: 'working', label: 'worker-2' };
const draining: WorkerTargetSlot = { worktreePath: '/wt/c', state: 'draining', label: 'worker-3' };

const MAIN: ChannelTriggerTarget = { kind: 'main' };
const ALL: ChannelTriggerTarget = { kind: 'all-workers' };
const worker = (worktree: string): ChannelTriggerTarget => ({ kind: 'worker', worktree });

describe('workerTargetWarning (HS-9084)', () => {
  it('never warns for the main target', () => {
    expect(workerTargetWarning(MAIN, [working]).warn).toBe(false);
  });

  it('warns when the targeted worker is mid-task (working)', () => {
    const w = workerTargetWarning(worker('/wt/b'), [idle, working]);
    expect(w.warn).toBe(true);
    expect(w.reason).toContain('worker-2');
  });

  it('does not warn when the targeted worker is idle / draining', () => {
    expect(workerTargetWarning(worker('/wt/a'), [idle, working]).warn).toBe(false);
    expect(workerTargetWarning(worker('/wt/c'), [draining]).warn).toBe(false);
  });

  it('does not warn when the targeted worker is not in the live pool', () => {
    expect(workerTargetWarning(worker('/wt/gone'), [idle, working]).warn).toBe(false);
  });

  it('all-workers warns when ANY worker is mid-task, naming them', () => {
    const w = workerTargetWarning(ALL, [idle, working]);
    expect(w.warn).toBe(true);
    expect(w.reason).toContain('worker-2');
    expect(w.reason).toContain('1 worker');
  });

  it('all-workers does not warn when every worker is idle / draining', () => {
    expect(workerTargetWarning(ALL, [idle, draining]).warn).toBe(false);
  });

  it('a worker-safe command suppresses the warning entirely', () => {
    expect(workerTargetWarning(worker('/wt/b'), [working], { workerSafe: true }).warn).toBe(false);
    expect(workerTargetWarning(ALL, [working], { workerSafe: true }).warn).toBe(false);
  });
});
