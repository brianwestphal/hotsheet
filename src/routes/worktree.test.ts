/**
 * HS-9697 (docs/89 §89.7) — `src/routes/worktree.ts`: adopt a git worktree as a
 * follower of the current project. `listWorktreePaths` (which shells git) is mocked so
 * the enumeration is controllable; `makeFollower` + `readFileSettings` run for real
 * against temp dirs, so the adoptable filtering + the actual wiring are genuinely
 * exercised.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSettings, writeFileSettings } from '../file-settings.js';
import type { AppEnv } from '../types.js';

const mockListWorktreePaths = vi.fn<() => Promise<{ path: string }[]>>();
vi.mock('../git/runner.js', () => ({
  listWorktreePaths: () => mockListWorktreePaths(),
}));

const { worktreeRoutes } = await import('./worktree.js');

let base: string;
let ownerRoot: string;
let ownerHotsheet: string;
let wtA: string; // adoptable
let wtB: string; // already a follower of this owner

function buildApp(dataDir: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', (c, next) => { c.set('dataDir', dataDir); return next(); });
  app.route('/api', worktreeRoutes);
  return app;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hs-wtroute-'));
  ownerRoot = join(base, 'owner');
  ownerHotsheet = join(ownerRoot, '.hotsheet');
  wtA = join(base, 'wt-a');
  wtB = join(base, 'wt-b');
  mkdirSync(ownerHotsheet, { recursive: true });
  mkdirSync(wtA, { recursive: true });
  mkdirSync(join(wtB, '.hotsheet'), { recursive: true });
  writeFileSettings(ownerHotsheet, { appName: 'Owner', port: 4174 }); // a valid non-follower owner
  writeFileSettings(join(wtB, '.hotsheet'), { authoritativeDataDir: resolve(ownerHotsheet) }); // already a follower
  mockListWorktreePaths.mockReset().mockResolvedValue([{ path: ownerRoot }, { path: wtA }, { path: wtB }]);
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe('GET /worktree/adoptable', () => {
  it('lists worktrees excluding the owner itself and ones already following this owner', async () => {
    const res = await buildApp(ownerHotsheet).request('/api/worktree/adoptable');
    expect(res.status).toBe(200);
    const body = await res.json() as { worktrees: { path: string }[] };
    expect(body.worktrees.map(w => w.path)).toEqual([resolve(wtA)]);
  });

  it('returns [] when not a git repo (listWorktreePaths throws)', async () => {
    mockListWorktreePaths.mockRejectedValue(new Error('not a git repository'));
    const res = await buildApp(ownerHotsheet).request('/api/worktree/adoptable');
    expect(await res.json()).toEqual({ worktrees: [] });
  });
});

describe('POST /worktree/adopt', () => {
  const post = async (app: Hono<AppEnv>, body: unknown): Promise<Response> =>
    app.request('/api/worktree/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('adopts a real worktree and wires the follower pointer', async () => {
    const res = await post(buildApp(ownerHotsheet), { worktree: wtA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The pointer was written against this owner.
    expect(resolve(readFileSettings(join(wtA, '.hotsheet')).authoritativeDataDir ?? '')).toBe(resolve(ownerHotsheet));
  });

  it('rejects a path that is not a worktree of this repo (no arbitrary cwd)', async () => {
    const res = await post(buildApp(ownerHotsheet), { worktree: join(base, 'not-a-worktree') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it('rejects adopting the owner project itself', async () => {
    const res = await post(buildApp(ownerHotsheet), { worktree: ownerRoot });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it('400s on a missing worktree path', async () => {
    const res = await post(buildApp(ownerHotsheet), {});
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error ?? '').toContain('Missing');
  });
});
