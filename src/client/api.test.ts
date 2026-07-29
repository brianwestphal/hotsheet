// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiUpload, apiWithSecret, showErrorPopup } from './api.js';
import { _resetShutdownStateForTesting, markShuttingDown } from './shutdownState.js';

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
    // The exact bug repro: hex secret passed where path was expected. HS-9475 —
    // deliberately a SYNTHETIC 32-hex value; this used to be a copy of the real
    // project secret, which has no business being in source at all.
    await expect(api('0123456789abcdef0123456789abcdef')).rejects.toThrow(/swapped-args bug \(HS-8141\)/);
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
      apiWithSecret('0123456789abcdef0123456789abcdef', '/terminal/list'),
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
      apiWithSecret('/terminal/list', '0123456789abcdef0123456789abcdef'),
    ).resolves.not.toThrow();
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // URL is exactly `/api/terminal/list` — no secret in path; secret goes in
    // the X-Hotsheet-Secret header.
    expect(calledUrl).toBe('/api/terminal/list');
  });
});

/**
 * HS-8563 — `skipProjectScope` option on `api()` opts a request out of
 * the auto-appended `?project=<active-secret>` query param. The
 * cross-project stats endpoint needs this because the otel receiver
 * writes ALL telemetry rows into the launched-with default `dataDir`
 * (the server middleware uses that default whenever no
 * X-Hotsheet-Secret header and no project= query are present — and Claude
 * Code's exporter sends neither). If the read carries `?project=`, the
 * middleware re-scopes to that project's DB which contains no otel
 * rows → empty cross-project page. The pre-fix bug was the user
 * landing on cross-project stats from a non-launched-with project and
 * seeing "no data" despite having lots; switching projects (which
 * happened to be the launched-with one) made the data appear.
 */
describe('api() — skipProjectScope option (HS-8563)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('omits `?project=` from the URL when `skipProjectScope: true` is set', async () => {
    // Simulate an active project so the default path WOULD have appended
    // the project param.
    const { setActiveProject } = await import('./state.js');
    setActiveProject({ name: 'TestProject', secret: 'deadbeefcafebabedeadbeefcafebabe', dataDir: '/tmp/test' });

    await api('/telemetry/dashboard?window=month&tz=UTC', { skipProjectScope: true });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe('/api/telemetry/dashboard?window=month&tz=UTC');
    expect(calledUrl).not.toContain('project=');
  });

  it('appends `?project=` by default (regression guard for the auto-append behavior)', async () => {
    const { setActiveProject } = await import('./state.js');
    setActiveProject({ name: 'TestProject', secret: 'deadbeefcafebabedeadbeefcafebabe', dataDir: '/tmp/test' });

    await api('/telemetry/dashboard?window=month&tz=UTC');

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // The default path appends `&project=` because the URL already has a `?`.
    expect(calledUrl).toContain('project=deadbeefcafebabedeadbeefcafebabe');
  });
});

/**
 * HS-9029 — the "Connection Error" popup must NOT fire once the app is shutting
 * down. During quit the server intentionally closes, so every in-flight request
 * fails; pre-fix the popup flashed (blurred) behind the "Shutting Down" overlay
 * on every quit.
 */
describe('showErrorPopup — what it actually tells you (HS-9453)', () => {
  afterEach(() => { document.getElementById('network-error-popup')?.remove(); });

  it('defaults to "Connection Error" — the transport-failure case', () => {
    showErrorPopup('Unable to reach the server.');
    expect(document.querySelector('#network-error-popup strong')!.textContent).toBe('Connection Error');
  });

  // A 500 means the connection WORKED and the server failed. Calling that a
  // connection error sent people looking at their network instead of the log.
  it('a server fault is titled "Server Error" and names the failing request + ref', () => {
    showErrorPopup('Maximum call stack size exceeded', {
      title: 'Server Error',
      context: '/tickets/42',
      ref: 'a1b2c3',
    });
    const popup = document.getElementById('network-error-popup')!;
    expect(popup.querySelector('strong')!.textContent).toBe('Server Error');
    expect(popup.textContent).toContain('Maximum call stack size exceeded');
    const detail = popup.querySelector('.error-popup-detail')!.textContent;
    expect(detail).toContain('/tickets/42');
    expect(detail).toContain('ref a1b2c3');
  });

  it('omits the detail line entirely when there is no context or ref', () => {
    showErrorPopup('Something broke');
    expect(document.querySelector('#network-error-popup .error-popup-detail')).toBeNull();
  });

  it('replaces a previous popup rather than stacking', () => {
    showErrorPopup('first');
    showErrorPopup('second');
    expect(document.querySelectorAll('#network-error-popup')).toHaveLength(1);
    expect(document.getElementById('network-error-popup')!.textContent).toContain('second');
  });
});

describe('showErrorPopup — shutdown suppression (HS-9029)', () => {
  afterEach(() => {
    _resetShutdownStateForTesting();
    document.getElementById('network-error-popup')?.remove();
  });

  it('shows the popup normally when not shutting down', () => {
    showErrorPopup('Unable to reach the server.');
    expect(document.getElementById('network-error-popup')).not.toBeNull();
  });

  it('suppresses the popup once shutdown has begun', () => {
    markShuttingDown();
    showErrorPopup('Unable to reach the server.');
    expect(document.getElementById('network-error-popup')).toBeNull();
  });

  it('api() failing with a TypeError pops the dialog — but not while shutting down', async () => {
    // A bare network failure surfaces as a TypeError from fetch.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    await expect(api('/tickets')).rejects.toThrow();
    expect(document.getElementById('network-error-popup')).not.toBeNull();
    document.getElementById('network-error-popup')!.remove();

    markShuttingDown();
    await expect(api('/tickets')).rejects.toThrow();
    expect(document.getElementById('network-error-popup')).toBeNull();

    vi.unstubAllGlobals();
  });
});
