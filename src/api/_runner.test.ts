/**
 * HS-8522 — typed API runtime. `apiCall` must route through the injected
 * transport, validate the decoded body against the response schema, and
 * throw a path-qualified error on mismatch (never silently return the wrong
 * shape). `qs` builds query strings, skipping null/undefined.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { apiCall, type ApiTransport, qs, setApiTransport } from './_runner.js';

afterEach(() => {
  // Reset the module-global transport between tests.
  setApiTransport(null as unknown as ApiTransport);
});

const Schema = z.object({ value: z.number() });

describe('apiCall (HS-8522)', () => {
  it('routes through the injected transport and returns the validated body', async () => {
    const transport = vi.fn<ApiTransport>().mockResolvedValue({ value: 42 });
    setApiTransport(transport);
    const result = await apiCall(Schema, '/thing', { method: 'POST', body: { a: 1 } });
    expect(result).toEqual({ value: 42 });
    expect(transport).toHaveBeenCalledWith('/thing', { method: 'POST', body: { a: 1 } });
  });

  it('throws a path-qualified error when the response fails validation', async () => {
    setApiTransport(vi.fn<ApiTransport>().mockResolvedValue({ value: 'not-a-number' }));
    await expect(apiCall(Schema, '/thing')).rejects.toThrow(/apiCall\(\/thing\): response shape mismatch.*value/);
  });

  it('throws when no transport has been configured (server / pre-boot)', async () => {
    setApiTransport(null as unknown as ApiTransport);
    await expect(apiCall(Schema, '/thing')).rejects.toThrow(/no transport configured/);
  });
});

describe('qs (HS-8522)', () => {
  it('builds a leading-? query string and coerces values', () => {
    expect(qs({ files: true, start: 3 })).toBe('?files=true&start=3');
  });

  it('skips undefined and null values', () => {
    expect(qs({ a: 1, b: undefined, c: null })).toBe('?a=1');
  });

  it('returns an empty string when there are no usable params', () => {
    expect(qs({ a: undefined, b: null })).toBe('');
    expect(qs({})).toBe('');
  });

  it('url-encodes keys and values', () => {
    expect(qs({ q: 'a b&c' })).toBe('?q=a+b%26c');
  });
});
