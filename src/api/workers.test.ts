/**
 * HS-8863 — worker launch typed-API module. Schemas are the SSOT shared by the
 * server route (`src/routes/workers.ts`) + the client caller; the caller must hit
 * the right path + method + body through the injected transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from './_runner.js';
import { launchWorker, LaunchWorkerReqSchema, WorkerLaunchSpecSchema } from './workers.js';

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
