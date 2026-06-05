/**
 * HS-8751 — typed callers + wire schemas for the global API-key registry.
 * Stubs the JSON transport and asserts each caller's path / method / body,
 * plus the request schemas' validation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  createKey, CreateKeyReqSchema, deleteKey, listKeys, updateKey, UpdateKeyReqSchema,
} from './keys.js';

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

const meta = { id: 'abc', type: 'anthropic_api_key' as const, name: 'Personal' };

describe('keys request schemas (HS-8751)', () => {
  it('CreateKeyReqSchema requires type + non-empty name + non-empty value', () => {
    expect(CreateKeyReqSchema.safeParse({ type: 'anthropic_api_key', name: 'n', value: 'v' }).success).toBe(true);
    expect(CreateKeyReqSchema.safeParse({ type: 'anthropic_api_key', name: '', value: 'v' }).success).toBe(false);
    expect(CreateKeyReqSchema.safeParse({ type: 'anthropic_api_key', name: 'n', value: '' }).success).toBe(false);
    expect(CreateKeyReqSchema.safeParse({ type: 'bogus', name: 'n', value: 'v' }).success).toBe(false);
  });
  it('UpdateKeyReqSchema is all-optional; value may be blank (keep existing)', () => {
    expect(UpdateKeyReqSchema.safeParse({}).success).toBe(true);
    expect(UpdateKeyReqSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(UpdateKeyReqSchema.safeParse({ value: '' }).success).toBe(true);
    expect(UpdateKeyReqSchema.safeParse({ name: '' }).success).toBe(false); // explicit name must be non-empty
  });
});

describe('keys callers (HS-8751)', () => {
  it('listKeys → GET /keys, unwraps keys', async () => {
    stub({ keys: [meta] });
    expect(await listKeys()).toEqual([meta]);
    expect(lastCall).toEqual({ path: '/keys', opts: {} });
  });

  it('createKey → POST /keys with body, unwraps key', async () => {
    stub({ key: meta });
    const res = await createKey({ type: 'anthropic_api_key', name: 'Personal', value: 'sk' });
    expect(res).toEqual(meta);
    expect(lastCall).toEqual({ path: '/keys', opts: { method: 'POST', body: { type: 'anthropic_api_key', name: 'Personal', value: 'sk' } } });
  });

  it('updateKey → PUT /keys/:id with body', async () => {
    stub({ key: meta });
    await updateKey('abc', { name: 'New' });
    expect(lastCall).toEqual({ path: '/keys/abc', opts: { method: 'PUT', body: { name: 'New' } } });
  });

  it('deleteKey → DELETE /keys/:id', async () => {
    stub({ ok: true });
    await deleteKey('abc');
    expect(lastCall).toEqual({ path: '/keys/abc', opts: { method: 'DELETE' } });
  });
});
