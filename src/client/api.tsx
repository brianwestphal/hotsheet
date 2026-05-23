import type { z } from 'zod';

import { ErrorBodySchema } from '../schemas.js';
import { byIdOrNull, toElement } from './dom.js';
import { trackServerRequest } from './serverBusyChip.js';
import { getActiveProject } from './state.js';

/**
 * HS-8567 — extract the error message from a non-OK response body without
 * an `as` cast. Tolerates malformed JSON / missing `error` key by falling
 * back to a generic status-coded message. Centralized so the three
 * api / apiWithSecret / apiUpload helpers share one parse path.
 */
async function extractErrorMessage(res: Response): Promise<string> {
  let parsed: unknown;
  try { parsed = await res.json(); } catch { parsed = null; }
  const result = ErrorBodySchema.safeParse(parsed);
  const msg = result.success ? result.data.error : undefined;
  return msg !== undefined && msg !== '' ? msg : `Server returned ${res.status}`;
}

/**
 * HS-8567 — parse a response body. If a schema is provided, validate
 * through it at runtime (throws with a descriptive error on shape
 * mismatch). If no schema is provided, return the raw decoded JSON as
 * `T` — that is the LEGACY UNVALIDATED PATH retained for callers that
 * have not yet been migrated; new code SHOULD pass a schema.
 */
async function parseResponseBody<T>(res: Response, schema: z.ZodType<T> | undefined, path: string): Promise<T> {
  const raw: unknown = await res.json();
  if (schema === undefined) {
    // Legacy unvalidated path. HS-8567 follow-ups should migrate every
    // caller to pass a schema; once all callsites are converted the
    // schema param becomes required and this branch can be removed.
    return raw as T;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`api(${path}): response shape mismatch — ${issues}`);
  }
  return result.data;
}

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
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; schema?: z.ZodType<T> } = {}): Promise<T> {
  // HS-8175 — track every non-long-poll fetch so the global server-busy
  // chip can light up if a request crosses the threshold (3 s).
  const url = buildUrl(path, opts.method);
  const done = trackServerRequest(url);
  try {
    const res = await fetch(url, {
      headers: buildHeaders(opts),
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const message = await extractErrorMessage(res);
      if (res.status >= 500) showErrorPopup(message);
      throw new Error(message);
    }
    return await parseResponseBody<T>(res, opts.schema, path);
  } catch (err) {
    if (err instanceof TypeError) {
      showErrorPopup('Unable to reach the server. It may have been stopped.');
    }
    throw err;
  } finally {
    done();
  }
}

/** Like `api()`, but uses a specific project secret instead of the active project. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiWithSecret<T = any>(path: string, secret: string, opts: { method?: string; body?: unknown; schema?: z.ZodType<T> } = {}): Promise<T> {
  const url = '/api' + path;
  const done = trackServerRequest(url);
  try {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    headers['X-Hotsheet-Secret'] = secret;
    assertApiPathShape(path);
    const res = await fetch(url, {
      headers,
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const message = await extractErrorMessage(res);
      if (res.status >= 500) showErrorPopup(message);
      throw new Error(message);
    }
    return await parseResponseBody<T>(res, opts.schema, path);
  } catch (err) {
    if (err instanceof TypeError) {
      showErrorPopup('Unable to reach the server. It may have been stopped.');
    }
    throw err;
  } finally {
    done();
  }
}

export async function apiUpload<T>(path: string, file: File, opts: { schema?: z.ZodType<T> } = {}): Promise<T> {
  const url = buildUrl(path, 'POST');
  const done = trackServerRequest(url);
  try {
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const proj = getActiveProject();
    if (proj !== null) {
      headers['X-Hotsheet-Secret'] = proj.secret;
    }
    const res = await fetch(url, { method: 'POST', body: form, headers });
    if (!res.ok) {
      const message = await extractErrorMessage(res);
      if (res.status >= 500) showErrorPopup(message);
      throw new Error(message);
    }
    return await parseResponseBody<T>(res, opts.schema, path);
  } catch (err) {
    if (err instanceof TypeError) {
      showErrorPopup('Unable to reach the server. It may have been stopped.');
    }
    throw err;
  } finally {
    done();
  }
}
