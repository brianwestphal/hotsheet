import { toElement } from './dom.js';
import { getActiveProject } from './state.js';

export function showErrorPopup(message: string) {
  document.getElementById('network-error-popup')?.remove();
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
  let url = '/api' + path;
  const ap = getActiveProject();
  if (ap !== null && (method === undefined || method === 'GET')) {
    const sep = url.includes('?') ? '&' : '?';
    url += sep + 'project=' + encodeURIComponent(ap.secret);
  }
  return url;
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
      let message = `Server returned ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') message = body.error;
      } catch { /* body not JSON, use default message */ }
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
      let message = `Server returned ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') message = body.error;
      } catch { /* body not JSON, use default message */ }
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
