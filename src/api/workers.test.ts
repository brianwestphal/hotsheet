/**
 * HS-8863 — worker launch typed-API module. Schemas are the SSOT shared by the
 * server route (`src/routes/workers.ts`) + the client caller; the caller must hit
 * the right path + method + body through the injected transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from './_runner.js';
import {
  drainAllPoolWorkers, drainPoolWorker, getWorkerPool, launchWorker,
  LaunchWorkerReqSchema, PoolStateSchema, registerPoolWorker,
  removePoolWorker, setPoolTarget, WorkerLaunchSpecSchema, WorkerSlotViewSchema,
} from './workers.js';

const validSpec = { worker: 'feature-x', label: 'feature-x', cwd: '/repo-worktrees/feature-x', command: 'claude "/hotsheet-worker"', worktreeCreated: true };

afterEach(() => setApiTransport(null as unknown as ApiTransport));

describe('worker launch schemas (HS-8863)', () => {
  it('LaunchWorkerReqSchema accepts a branch, a worktreePath, or overrides', () => {
    expect(LaunchWorkerReqSchema.safeParse({ branch: 'feat' }).success).toBe(true);
    expect(LaunchWorkerReqSchema.safeParse({ worktreePath: '/x' }).success).toBe(true);
    expect(LaunchWorkerReqSchema.safeParse({ worktreePath: '/x', label: 'W2', worker: 'w2' }).success).toBe(true);
    expect(LaunchWorkerReqSchema.safeParse({}).success).toBe(true); // server rejects empty; schema is permissive
    expect(LaunchWorkerReqSchema.safeParse({ branch: 5 }).success).toBe(false);
  });

  it('WorkerLaunchSpecSchema validates the launch spec shape', () => {
    expect(WorkerLaunchSpecSchema.safeParse(validSpec).success).toBe(true);
    expect(WorkerLaunchSpecSchema.safeParse({ ...validSpec, worktreeCreated: 'yes' }).success).toBe(false);
    expect(WorkerLaunchSpecSchema.safeParse({ ...validSpec, cwd: undefined }).success).toBe(false);
  });
});

describe('worker launch caller (HS-8863)', () => {
  it('launchWorker → POST /workers/launch with the request body', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue(validSpec);
    setApiTransport(t);
    await launchWorker({ branch: 'feat' });
    expect(t).toHaveBeenCalledWith('/workers/launch', { method: 'POST', body: { branch: 'feat' } });
  });
});

const validSlot = { label: 'worker-1', worker: 'worker-1', worktreePath: '/wt/worker-1', branch: 'hotsheet/worker-1', terminalId: 't1', state: 'working', currentTicket: { id: 5, ticketNumber: 'HS-5', title: 'x' } };

describe('worker-pool schemas + callers (HS-8962)', () => {
  it('WorkerSlotViewSchema accepts a valid slot incl. null ticket + each state', () => {
    expect(WorkerSlotViewSchema.safeParse(validSlot).success).toBe(true);
    expect(WorkerSlotViewSchema.safeParse({ ...validSlot, state: 'idle', currentTicket: null }).success).toBe(true);
    expect(WorkerSlotViewSchema.safeParse({ ...validSlot, state: 'bogus' }).success).toBe(false);
  });

  it('PoolStateSchema validates the pool snapshot', () => {
    expect(PoolStateSchema.safeParse({ targetN: 2, workers: [validSlot] }).success).toBe(true);
    expect(PoolStateSchema.safeParse({ targetN: 'two', workers: [] }).success).toBe(false);
  });

  it('getWorkerPool → GET /workers/pool', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue({ targetN: 0, workers: [] });
    setApiTransport(t);
    await getWorkerPool();
    expect(t).toHaveBeenCalledWith('/workers/pool', {});
  });

  it('registerPoolWorker / drain / drain-all / remove / target hit the right routes', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue(validSlot);
    setApiTransport(t);
    await registerPoolWorker({ label: 'worker-1', worker: 'worker-1', worktreePath: '/wt/worker-1' });
    expect(t).toHaveBeenLastCalledWith('/workers/pool/register', { method: 'POST', body: { label: 'worker-1', worker: 'worker-1', worktreePath: '/wt/worker-1' } });

    t.mockResolvedValue({ ok: true });
    await drainPoolWorker({ worker: 'worker-1' });
    expect(t).toHaveBeenLastCalledWith('/workers/pool/drain', { method: 'POST', body: { worker: 'worker-1' } });
    await drainAllPoolWorkers();
    expect(t).toHaveBeenLastCalledWith('/workers/pool/drain-all', { method: 'POST', body: {} });
    await removePoolWorker({ worker: 'worker-1' });
    expect(t).toHaveBeenLastCalledWith('/workers/pool/remove', { method: 'POST', body: { worker: 'worker-1' } });
    await setPoolTarget({ targetN: 3 });
    expect(t).toHaveBeenLastCalledWith('/workers/pool/target', { method: 'POST', body: { targetN: 3 } });
  });
});
