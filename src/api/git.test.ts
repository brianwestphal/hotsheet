/**
 * HS-8522 — git typed-API module. The schemas are the single source of
 * truth shared by the server (`src/git/status.ts`, `src/routes/git.ts`) and
 * the client (`gitStatusChip.tsx`, `gitStatusPopover.tsx`); the callers must
 * hit the right path + method through the injected transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from './_runner.js';
import {
  FetchResultSchema,
  getGitStatus,
  getGitStatusWithFiles,
  gitFetch,
  gitReveal,
  GitRevealReqSchema,
  GitStatusSchema,
  GitStatusWithFilesSchema,
} from './git.js';

const validStatus = {
  branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0,
  staged: 1, unstaged: 2, untracked: 0, conflicted: 0, lastFetchedAt: null,
};

afterEach(() => setApiTransport(null as unknown as ApiTransport));

describe('git schemas (HS-8522)', () => {
  it('GitStatusSchema accepts a valid status and rejects a wrong-typed field', () => {
    expect(GitStatusSchema.safeParse(validStatus).success).toBe(true);
    expect(GitStatusSchema.safeParse({ ...validStatus, staged: 'x' }).success).toBe(false);
  });

  it('GitStatusWithFilesSchema makes files optional', () => {
    expect(GitStatusWithFilesSchema.safeParse(validStatus).success).toBe(true);
    const withFiles = {
      ...validStatus,
      files: { staged: ['a'], unstaged: [], untracked: [], conflicted: [], truncated: { staged: false, unstaged: false, untracked: false, conflicted: false } },
    };
    expect(GitStatusWithFilesSchema.safeParse(withFiles).success).toBe(true);
  });

  it('FetchResultSchema validates the fetch shape', () => {
    expect(FetchResultSchema.safeParse({ ok: true, lastFetchedAt: 123, error: '' }).success).toBe(true);
    expect(FetchResultSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it('GitRevealReqSchema allows a missing path and tolerates extra keys', () => {
    expect(GitRevealReqSchema.safeParse({}).success).toBe(true);
    expect(GitRevealReqSchema.safeParse({ path: 'a/b', extra: 1 }).success).toBe(true);
  });
});

describe('git callers (HS-8522)', () => {
  it('getGitStatus → GET /git/status', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue(validStatus);
    setApiTransport(t);
    await getGitStatus();
    expect(t).toHaveBeenCalledWith('/git/status', {});
  });

  it('getGitStatusWithFiles → GET /git/status?files=true', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue(validStatus);
    setApiTransport(t);
    await getGitStatusWithFiles();
    expect(t).toHaveBeenCalledWith('/git/status?files=true', {});
  });

  it('gitFetch → POST /git/fetch', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue({ ok: true, lastFetchedAt: null, error: '' });
    setApiTransport(t);
    await gitFetch();
    expect(t).toHaveBeenCalledWith('/git/fetch', { method: 'POST' });
  });

  it('gitReveal → POST /git/reveal with the path body', async () => {
    const t = vi.fn<ApiTransport>().mockResolvedValue({ ok: true });
    setApiTransport(t);
    await gitReveal({ path: 'src/x.ts' });
    expect(t).toHaveBeenCalledWith('/git/reveal', { method: 'POST', body: { path: 'src/x.ts' } });
  });

  it('getGitStatus passes through a null body (not-a-repo)', async () => {
    setApiTransport(vi.fn<ApiTransport>().mockResolvedValue(null));
    await expect(getGitStatus()).resolves.toBeNull();
  });
});
