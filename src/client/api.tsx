import { byIdOrNull, toElement } from './dom.js';
import { getActiveProject } from './state.js';

export function showErrorPopup(message: string) {
  byIdOrNull('network-error-popup')?.remove();
  const popup = toElement(
    <div id="network-error-popup" className="error-popup">
      <div className="error-popup-content">
        <strong>Connection Error</strong>
        <p>{message}</p>
        <button>Dismiss</button>
      </div>
    </div>
  );
  popup.querySelector('button')!.addEventListener('click', () => popup.remove());
  document.body.appendChild(popup);
}

/** Build the full URL for an API call, adding project query param for GET requests. */
function buildUrl(path: string, method?: string): string {
  assertApiPathShape(path);
  let url = '/api' + path;
  const ap = getActiveProject();
  if (ap !== null && (method === undefined || method === 'GET')) {
    const sep = url.includes('?') ? '&' : '?';
    url += sep + 'project=' + encodeURIComponent(ap.secret);
  }
  return url;
}

/**
 * HS-8141 — defensive guard. Every `api(...)` / `apiWithSecret(...)` /
 * `apiUpload(...)` call is expected to pass a path that starts with `/`.
 * Without this, a swapped-args bug like the channel-UI one (path arg got
 * `project.secret`, no leading slash) silently produced a URL of
 * `/api<hex-secret>` and 404'd on every poll tick — visible only as
 * console noise the user spotted manually. Throwing here surfaces the
 * bug at the point of call instead of letting it ship.
 *
 * The check is intentionally loose: any non-empty path that starts with
 * `/` (or `?`, for query-string-only paths used by no current caller
 * but worth allowing defensively) passes. Empty paths are also rejected
 * — `/api` with no further path is never a meaningful request.
 */
function assertApiPathShape(path: string): void {
  if (typeof path !== 'string' || path === '' || !(path.startsWith('/') || path.startsWith('?'))) {
    throw new Error(`api(): expected path starting with "/", got ${JSON.stringify(path)} — likely a swapped-args bug (HS-8141).`);
  }
}

/** Build headers, adding X-Hotsheet-Secret for mutation requests. */
function buildHeaders(opts: { body?: unknown; method?: string }): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const isMutation = opts.method === 'POST' || opts.method === 'PATCH' || opts.method === 'PUT' || opts.method === 'DELETE';
  const activeProj = getActiveProject();
  if (activeProj !== null && isMutation) {
    headers['X-Hotsheet-Secret'] = activeProj.secret;
  }
  // Mark all UI mutations so the server knows to keep tickets read
  if (isMutation) headers['X-Hotsheet-User-Action'] = 'true';
  return headers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    const res = await fetch(buildUrl(path, opts.method), {
      headers: buildHeaders(opts),
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      const message = body?.error ?? `Server returned ${res.status}`;
      if (res.status >= 500) showErrorPopup(message);
      throw new Error(message);
    }
    return await (res.json() as Promise<T>);
  } catch (err) {
    if (err instanceof TypeError) {
      showErrorPopup('Unable to reach the server. It may have been stopped.');
    }
    throw err;
  }
}

/** Like `api()`, but uses a specific project secret instead of the active project. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiWithSecret<T = any>(path: string, secret: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    headers['X-Hotsheet-Secret'] = secret;
    assertApiPathShape(path);
    const res = await fetch('/api' + path, {
      headers,
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      const message = body?.error ?? `Server returned ${res.status}`;
      if (res.status >= 500) showErrorPopup(message);
      throw new Error(message);
    }
    return await (res.json() as Promise<T>);
  } catch (err) {
    if (err instanceof TypeError) {
      showErrorPopup('Unable to reach the server. It may have been stopped.');
    }
    throw err;
  }
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  try {
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const proj = getActiveProject();
    if (proj !== null) {
      headers['X-Hotsheet-Secret'] = proj.secret;
    }
    const res = await fetch(buildUrl(path, 'POST'), { method: 'POST', body: form, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      const message = body?.error ?? `Server returned ${res.status}`;
      if (res.status >= 500) showErrorPopup(message);
      throw new Error(message);
    }
    return await (res.json() as Promise<T>);
  } catch (err) {
    if (err instanceof TypeError) {
      showErrorPopup('Unable to reach the server. It may have been stopped.');
    }
    throw err;
  }
}
