/**
 * HS-9453 — an unhandled server error must reach the client as a READABLE body.
 *
 * Before this, `apiRoutes.onError` rethrew anything that wasn't a JSON parse error
 * into Hono's default handler, which answers 500 with no JSON body. The client's
 * `parseErrorBody` then found no `error` field and fell back to the literal string
 * "Server returned 500" — a popup naming neither what broke nor what the user was
 * doing. These pin the contract the client depends on.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';
import { apiErrorHandler } from './api.js';

/** Mount the REAL handler exported by `routes/api.ts` on a throwaway app, so this
 *  exercises the shipped code rather than a copy that can drift away from it. */
function appWithApiErrorHandler(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(apiErrorHandler);
  app.get('/boom', () => { throw new Error('kaboom from a route'); });
  app.get('/overflow', () => {
    // The HS-9451 shape: a RangeError used to arrive as a bodyless 500.
    const recurse = (): number => recurse();
    return recurse() as never;
  });
  app.get('/badjson', () => { throw new SyntaxError('Unexpected token in JSON at position 4'); });
  return app;
}

describe('HS-9453 — unhandled API errors carry a usable body', () => {
  it('a thrown Error answers 500 with the real message, a code, and a ref', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
    const res = await appWithApiErrorHandler().request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; code: string; ref: string };
    expect(body.error).toBe('kaboom from a route');
    expect(body.code).toBe('internal_error');
    expect(body.ref).toMatch(/^[a-z0-9]{1,6}$/);
    // The ref is only useful if it's also in the log the maintainer will read.
    expect(spy.mock.calls.some(c => String(c[0]).includes(body.ref))).toBe(true);
    spy.mockRestore();
  });

  it('a stack overflow reaches the client as its actual message, not "Server returned 500"', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
    const res = await appWithApiErrorHandler().request('/overflow');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/call stack/i);
    spy.mockRestore();
  });

  it('the HS-6700 JSON branch is unchanged — still a clean 400, no ref', async () => {
    const res = await appWithApiErrorHandler().request('/badjson');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; ref?: string };
    expect(body.error).toMatch(/^Invalid JSON body:/);
    expect(body.ref).toBeUndefined();
  });

  it('the response never carries a stack trace', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
    const res = await appWithApiErrorHandler().request('/boom');
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/\bat \S+ \(/); // no "at fn (file:line)" frames
    expect(text).not.toContain('apiErrorBody.test');
    spy.mockRestore();
  });
});
