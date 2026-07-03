// HS-9302 — GET/PUT /api/remotes route.
import { rmSync } from 'fs';
import { Hono } from 'hono';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

const { tmpdir } = os;
const tempHome = join(tmpdir(), `hs-remotes-route-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const { remotesRoutes } = await import('./remotes.js');

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.route('/api', remotesRoutes);
  return a;
}
function put(body: unknown) {
  return { method: 'PUT' as const, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(() => {
  try { rmSync(join(tempHome, '.hotsheet'), { recursive: true, force: true }); } catch { /* ignore */ }
});
afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /api/remotes', () => {
  it('returns an empty store initially', async () => {
    const res = await app().request('/api/remotes');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: [] });
  });
});

describe('PUT /api/remotes', () => {
  it('writes the store and a subsequent GET reads it back', async () => {
    const store = { servers: [{ origin: 'https://h:4174', label: 'H', projects: [{ secret: 's1', name: 'P1' }] }] };
    const putRes = await app().request('/api/remotes', put(store));
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toMatchObject(store);

    const getRes = await app().request('/api/remotes');
    expect(await getRes.json()).toMatchObject(store);
  });

  it('rejects a malformed store (400)', async () => {
    const res = await app().request('/api/remotes', put({ servers: [{ origin: 123 }] }));
    expect(res.status).toBe(400);
  });
});
