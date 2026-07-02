import type { z } from 'zod';

import { type ClaimConflictInfo, showClaimConflictToast } from './claimConflictToast.js';
import { byIdOrNull, toElement } from './dom.js';
import { trackServerRequest } from './serverBusyChip.js';
import { isShuttingDown } from './shutdownState.js';
import { getActiveProject } from './state.js';

//
// HS-8522 / HS-8638 — these `api` / `apiWithSecret` / `apiUpload` helpers are
// the low-level fetch runtime. The HS-8522 migration moved every typed call
// site onto the typed API layer (`src/api/*`, each endpoint's request +
// response shape defined once as zod schemas). These raw helpers are now wired
// in as the `_runner` TRANSPORT TARGET (`setApiTransport` / `setApiUploadTransport`
// in `app.tsx`) and are not called directly anywhere else.
//
// New code should add a schema + typed caller in `src/api/<resource>.ts` and
// call THAT — do not reintroduce inline `api<{ … }>(path)` type literals here.
//

interface ParsedErrorBody extends ClaimConflictInfo { message: string; code?: string }

/**
 * HS-8567 / HS-9287 — parse a non-OK response body once (JSON can only be read
 * once) into the error message + the optional `code` / claim-conflict fields.
 * Tolerates malformed JSON / missing keys by falling back to a status-coded
 * message. Centralized so the three api / apiWithSecret / apiUpload helpers share
 * one parse path.
 */
function parseErrorBody(raw: unknown, status: number): ParsedErrorBody {
  const out: ParsedErrorBody = { message: `Server returned ${String(status)}` };
  if (raw === null || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  if (typeof o.error === 'string' && o.error !== '') out.message = o.error;
  if (typeof o.code === 'string') out.code = o.code;
  if (typeof o.claimed_by === 'string') out.claimedBy = o.claimed_by;
  out.workerLabel = typeof o.worker_label === 'string' ? o.worker_label : null;
  if (Array.isArray(o.conflicts)) {
    out.conflicts = o.conflicts.flatMap((c): { id: number; claimed_by: string; worker_label: string | null }[] => {
      if (c === null || typeof c !== 'object') return [];
      const cr = c as Record<string, unknown>;
      if (typeof cr.id !== 'number' || typeof cr.claimed_by !== 'string') return [];
      return [{ id: cr.id, claimed_by: cr.claimed_by, worker_label: typeof cr.worker_label === 'string' ? cr.worker_label : null }];
    });
  }
  return out;
}

/** HS-9287 — the ticket id from a `/tickets/<id>[/...]` path (for the toast's
 *  force-release affordance); null for non-ticket or `/tickets/batch` paths. */
export function ticketIdFromPath(path: string): number | null {
  const m = /^\/tickets\/(\d+)(?:\/|$)/.exec(path);
  return m === null ? null : Number(m[1]);
}

/**
 * Handle a non-OK response: HS-9287 — a **409 `claimed_by_other`** shows the
 * clean claim-conflict toast (not the generic Connection-Error overlay), a 5xx
 * shows the Connection-Error popup, and everything else is silent. Always returns
 * the `Error` for the caller to throw (so an optimistic UI update reverts).
 */
async function handleNotOk(res: Response, path: string): Promise<Error> {
  let raw: unknown;
  try { raw = await res.json(); } catch { raw = null; }
  const body = parseErrorBody(raw, res.status);
  if (res.status === 409 && body.code === 'claimed_by_other') {
    showClaimConflictToast(body, ticketIdFromPath(path));
  } else if (res.status >= 500) {
    showErrorPopup(body.message);
  }
  return new Error(body.message);
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
  // HS-9029 — once the app is shutting down the server is intentionally closing,
  // so the in-flight requests that fail are expected. Suppress the "Connection
  // Error" popup that would otherwise flash behind the "Shutting Down" overlay.
  if (isShuttingDown()) return;
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

/** Build the full URL for an API call, adding project query param for GET requests.
 *  HS-8563 — `skipProjectScope` opts a request out of the auto-appended
 *  `?project=<active-secret>` query param so the server middleware falls
 *  back to the launched-with default `dataDir` (the single DB that holds
 *  cross-project data — the otel receiver routes all POSTs through it
 *  regardless of which project the data is for, because Claude Code's
 *  exporter doesn't pass our secret header). Used by the cross-project
 *  stats page so the read query lands in the same DB the writes did. */
function buildUrl(path: string, method?: string, skipProjectScope?: boolean): string {
  assertApiPathShape(path);
  let url = '/api' + path;
  if (skipProjectScope === true) return url;
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
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; schema?: z.ZodType<T>; skipProjectScope?: boolean } = {}): Promise<T> {
  // HS-8175 — track every non-long-poll fetch so the global server-busy
  // chip can light up if a request crosses the threshold (3 s).
  const url = buildUrl(path, opts.method, opts.skipProjectScope);
  const done = trackServerRequest(url);
  try {
    const res = await fetch(url, {
      headers: buildHeaders(opts),
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw await handleNotOk(res, path);
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
    if (!res.ok) throw await handleNotOk(res, path);
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
    if (!res.ok) throw await handleNotOk(res, path);
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
