/**
 * HS-8751 — `/api/keys` CRUD routes. The registry module is mocked (its own
 * storage/keychain behavior is covered by `src/secret-keys.test.ts`); this
 * exercises request validation, status codes, and the metadata-only responses.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

const metas = [{ id: 'k1', type: 'anthropic_api_key' as const, name: 'Personal' }];

vi.mock('../secret-keys.js', () => ({
  listKeyMetas: vi.fn(() => metas),
  createKey: vi.fn((type: string, name: string) => Promise.resolve({ id: 'new-id', type, name })),
  updateKey: vi.fn((id: string, updates: { name?: string }) =>
    Promise.resolve(id === 'k1' ? { id, type: 'anthropic_api_key', name: updates.name ?? 'Personal' } : null)),
  deleteKey: vi.fn((id: string) => Promise.resolve(id === 'k1')),
}));

const { keysRoutes } = await import('./keys.js');

let app: Hono<AppEnv>;
beforeEach(() => {
  app = new Hono<AppEnv>();
  app.route('/api', keysRoutes);
});
afterEach(() => vi.clearAllMocks());

const json = (method: string, body?: unknown) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('keys routes (HS-8751)', () => {
  it('GET /api/keys returns metadata only', async () => {
    const res = await app.request('/api/keys');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: metas });
  });

  it('POST /api/keys creates and returns the new metadata', async () => {
    const res = await app.request('/api/keys', json('POST', { type: 'anthropic_api_key', name: 'Work', value: 'sk-x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: { id: 'new-id', type: 'anthropic_api_key', name: 'Work' } });
  });

  it('POST /api/keys 400s on an invalid body', async () => {
    const res = await app.request('/api/keys', json('POST', { type: 'bogus', name: '', value: '' }));
    expect(res.status).toBe(400);
  });

  it('PUT /api/keys/:id updates a known key', async () => {
    const res = await app.request('/api/keys/k1', json('PUT', { name: 'Renamed' }));
    expect(res.status).toBe(200);
    expect((await res.json() as { key: { name: string } }).key.name).toBe('Renamed');
  });

  it('PUT /api/keys/:id 404s on an unknown key', async () => {
    const res = await app.request('/api/keys/nope', json('PUT', { name: 'X' }));
    expect(res.status).toBe(404);
  });

  it('DELETE /api/keys/:id removes a known key, 404 otherwise', async () => {
    expect((await app.request('/api/keys/k1', json('DELETE'))).status).toBe(200);
    expect((await app.request('/api/keys/nope', json('DELETE'))).status).toBe(404);
  });
});
