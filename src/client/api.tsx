import { toElement } from './dom.js';

function showErrorPopup(message: string) {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    const res = await fetch('/api' + path, {
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return res.json() as Promise<T>;
  } catch (err) {
    showErrorPopup('Unable to reach the server. It may have been stopped.');
    throw err;
  }
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api' + path, { method: 'POST', body: form });
    return res.json() as Promise<T>;
  } catch (err) {
    showErrorPopup('Unable to reach the server. It may have been stopped.');
    throw err;
  }
}
