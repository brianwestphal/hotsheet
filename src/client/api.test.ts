// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiUpload, apiWithSecret } from './api.js';

/**
 * HS-8141 — defensive guard tests. Pre-fix a swapped-args call to
 * `apiWithSecret(secret, '/path')` (instead of `(path, secret)`)
 * silently produced a URL of `/api${secret}` (no slash, no path)
 * and 404'd on every poll tick — the user only spotted it because of
 * repeated browser-console errors. The guard now throws at the call
 * site so the whole bug class fails loudly instead of shipping.
 */
describe('api / apiWithSecret / apiUpload — path-shape guard (HS-8141)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('fetch should NOT be called when the guard fires'))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('api() throws when the path arg is a secret-shaped hex string with no leading slash', async () => {
    // The exact bug repro: hex secret passed where path was expected.
    await expect(api('adae66c52c4e0335cfba23921464688a')).rejects.toThrow(/swapped-args bug \(HS-8141\)/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('api() throws on empty path', async () => {
    await expect(api('')).rejects.toThrow(/swapped-args bug \(HS-8141\)/);
  });

  it('api() throws when the path is missing the leading slash even if otherwise valid', async () => {
    await expect(api('tickets')).rejects.toThrow(/swapped-args bug \(HS-8141\)/);
  });

  it('apiWithSecret() throws when the path arg is a secret-shaped hex string', async () => {
    // The CHANNEL-UI bug shape — args swapped: `apiWithSecret(secret, path)`.
    await expect(
      apiWithSecret('adae66c52c4e0335cfba23921464688a', '/terminal/list'),
    ).rejects.toThrow(/swapped-args bug \(HS-8141\)/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('apiUpload() throws when the path arg is missing the leading slash', async () => {
    const file = new File(['x'], 'x.txt');
    await expect(apiUpload('tickets/1/attachments', file)).rejects.toThrow(/swapped-args bug \(HS-8141\)/);
  });

  it('api() does NOT throw for a well-formed path starting with "/"', async () => {
    // Stub fetch to a valid 200 JSON response so the call resolves cleanly.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))));
    await expect(api('/tickets')).resolves.not.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/^\/api\/tickets/);
  });

  it('apiWithSecret() does NOT throw for a well-formed (path, secret) call', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))));
    await expect(
      apiWithSecret('/terminal/list', 'adae66c52c4e0335cfba23921464688a'),
    ).resolves.not.toThrow();
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // URL is exactly `/api/terminal/list` — no secret in path; secret goes in
    // the X-Hotsheet-Secret header.
    expect(calledUrl).toBe('/api/terminal/list');
  });
});
