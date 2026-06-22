/**
 * HS-8935 — worktree typed-API module. Schemas are the SSOT shared by the
 * server routes (`src/routes/worktrees.ts`) + the client callers; the callers
 * must hit the right path + method + body through the injected transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from './_runner.js';
import {
  createWorktree, CreateWorktreeReqSchema, listWorktrees,
  removeWorktree, RemoveWorktreeReqSchema, WorktreeInfoSchema,
} from './worktrees.js';

const validInfo = { path: '/repo-worktrees/x', branch: 'x', head: 'abc', isMain: false, authoritativeDataDir: '/repo/.hotsheet' };

afterEach(() => setApiTransport(null as unknown as ApiTransport));

describe('worktree schemas (HS-8935)', () => {
  it('WorktreeInfoSchema accepts a valid entry incl. detached/non-follower nulls', () => {
    expect(WorktreeInfoSchema.safeParse(validInfo).success).toBe(true);
    expect(WorktreeInfoSchema.safeParse({ ...validInfo, branch: null, authoritativeDataDir: null }).success).toBe(true);
    expect(WorktreeInfoSchema.safeParse({ ...validInfo, isMain: 'yes' }).success).toBe(false);
  });

  it('CreateWorktreeReqSchema requires a non-empty branch', () => {
    expect(CreateWorktreeReqSchema.safeParse({ branch: 'feat' }).success).toBe(true);
    expect(CreateWorktreeReqSchema.safeParse({ branch: 'feat', newBranch: true, baseRef: 'main', path: '/x' }).success).toBe(true);
    expect(CreateWorktreeReqSchema.safeParse({ branch: '' }).success).toBe(false);
  });

  it('RemoveWorktreeReqSchema requires a path', () => {
    expect(RemoveWorktreeReqSchema.safeParse({ path: '/x' }).success).toBe(true);
    expect(RemoveWorktreeReqSchema.safeParse({ path: '/x', force: true, deleteBranch: true }).success).toBe(true);
    expect(RemoveWorktreeReqSchema.safeParse({}).success).toBe(false);
  });
});

describe('worktree callers (HS-8935)', () => {
  it('listWorktrees → GET /worktrees', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue([validInfo]);
    setApiTransport(t);
    await listWorktrees();
    expect(t).toHaveBeenCalledWith('/worktrees', {});
  });

  it('createWorktree → POST /worktrees with the request body', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue(validInfo);
    setApiTransport(t);
    await createWorktree({ branch: 'feat', newBranch: true });
    expect(t).toHaveBeenCalledWith('/worktrees', { method: 'POST', body: { branch: 'feat', newBranch: true } });
  });

  it('removeWorktree → POST /worktrees/remove with the request body', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue({ ok: true });
    setApiTransport(t);
    await removeWorktree({ path: '/repo-worktrees/x', force: true });
    expect(t).toHaveBeenCalledWith('/worktrees/remove', { method: 'POST', body: { path: '/repo-worktrees/x', force: true } });
  });
});
