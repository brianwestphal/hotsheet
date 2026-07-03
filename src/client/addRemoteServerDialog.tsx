// HS-9303 (docs/112 §112.6) — the "Add remote server" connection-entry modal.
// Web-first cut: enter/normalize a server URL and save it to the remotes store
// (`~/.hotsheet/remotes.json`); enumerating + mounting its projects is HS-9304.
// The client cert is presented by the BROWSER's native store on the mTLS
// handshake (§97.3) — no cert handling in the app for the web path; the Tauri
// path is HS-9307. The QR-scan + in-app cert enrollment richness is a follow-up.

import { toElement } from './dom.js';
import { refreshProjectTabs } from './projectTabs.js';
import { addRemoteServer } from './remoteServers.js';
import { isLoopbackOrigin, normalizeServerUrl } from './remoteUrl.js';
import { showToast } from './toast.js';

let activeOverlay: HTMLElement | null = null;

/** Close the dialog if open. */
export function closeAddRemoteServerDialog(): void {
  if (activeOverlay !== null) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}

/** A friendly default label for a server origin (its host). */
function labelForOrigin(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

/** Open the "Add remote server" modal. */
export function openAddRemoteServerDialog(): void {
  closeAddRemoteServerDialog();

  const overlay = toElement(
    <div className="worker-pool-overlay">
      <div className="worker-pool-dialog add-remote-dialog" role="dialog" aria-label="Add remote server">
        <div className="worker-pool-header">
          <span className="worker-pool-title">Add remote server</span>
          <button type="button" className="worker-pool-close" title="Close">{'×'}</button>
        </div>
        <div className="worker-pool-body add-remote-body">
          <label className="add-remote-label" htmlFor="add-remote-url">Server URL</label>
          <input type="text" id="add-remote-url" className="add-remote-url" placeholder="https://host:4174" autocomplete="off" spellcheck={false} />
          <div className="add-remote-hint" aria-live="polite"></div>
          <div className="add-remote-cert-note settings-hint">
            The client certificate installed in your browser is presented on the secure connection.
            {' '}Don’t have one yet? Enroll a device on the server under Settings → Remote Access.
          </div>
        </div>
        <div className="worker-pool-controls">
          <button type="button" className="btn btn-sm add-remote-cancel">Cancel</button>
          <button type="button" className="btn btn-sm add-remote-connect" disabled>Add server</button>
        </div>
      </div>
    </div>,
  );

  const input = overlay.querySelector('.add-remote-url');
  const hint = overlay.querySelector('.add-remote-hint');
  const connectBtn = overlay.querySelector('.add-remote-connect');
  if (!(input instanceof HTMLInputElement) || !(hint instanceof HTMLElement) || !(connectBtn instanceof HTMLButtonElement)) return;

  /** Validate the current input; returns the normalized origin when valid. */
  const validate = (): string | null => {
    const result = normalizeServerUrl(input.value);
    if (!result.ok) {
      hint.textContent = input.value.trim() === '' ? '' : result.error;
      hint.classList.remove('add-remote-hint-warn');
      connectBtn.disabled = true;
      return null;
    }
    // A non-loopback http:// origin is a likely mistake (a remote server is mTLS).
    if (result.origin.startsWith('http://') && !isLoopbackOrigin(result.origin)) {
      hint.textContent = `A remote server should be https. Using ${result.origin}?`;
      hint.classList.add('add-remote-hint-warn');
    } else {
      hint.textContent = result.origin;
      hint.classList.remove('add-remote-hint-warn');
    }
    connectBtn.disabled = false;
    return result.origin;
  };

  const submit = async (): Promise<void> => {
    const origin = validate();
    if (origin === null) return;
    connectBtn.disabled = true;
    try {
      await addRemoteServer(origin, labelForOrigin(origin));
      await refreshProjectTabs();
      closeAddRemoteServerDialog();
      showToast(`Added remote server ${labelForOrigin(origin)}. Select its projects to mount.`, { variant: 'success' });
    } catch (e) {
      hint.textContent = `Couldn’t save: ${e instanceof Error ? e.message : String(e)}`;
      hint.classList.add('add-remote-hint-warn');
      connectBtn.disabled = false;
    }
  };

  input.addEventListener('input', () => validate());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
  connectBtn.addEventListener('click', () => void submit());
  overlay.querySelector('.add-remote-cancel')?.addEventListener('click', closeAddRemoteServerDialog);
  overlay.querySelector('.worker-pool-close')?.addEventListener('click', closeAddRemoteServerDialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAddRemoteServerDialog(); });

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  input.focus();
}
