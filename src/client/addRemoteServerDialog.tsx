// HS-9303 / HS-9304 (docs/112 §112.6/§112.7) — the "Add remote server" modal.
// Web-first: enter/normalize a server URL, ENUMERATE the server's projects
// (`GET <origin>/api/projects`, the browser presenting the client cert on the mTLS
// handshake), MULTI-SELECT which to mount, and persist them to the remotes store
// (`~/.hotsheet/remotes.json`) as tabs. If enumeration fails (cert not installed,
// server unreachable), the user can still add the server with no projects and
// enumerate later. The client cert is the browser's native store (§97.3) for web;
// the Tauri path is HS-9307; QR-scan + in-app enrollment is HS-9308.

import type { RemoteProject } from '../api/index.js';
import { toElement } from './dom.js';
import { refreshProjectTabs } from './projectTabs.js';
import { addRemoteServer, fetchRemoteProjects, mountRemoteProjects } from './remoteServers.js';
import { isLoopbackOrigin, normalizeServerUrl } from './remoteUrl.js';
import { canScanQr, type ScanHandle, startPairingQrScan } from './scanQr.js';
import { showToast } from './toast.js';

let activeOverlay: HTMLElement | null = null;
let activeScan: ScanHandle | null = null;

/** Close the dialog if open (stopping any running QR scan / camera). */
export function closeAddRemoteServerDialog(): void {
  if (activeScan !== null) { activeScan.stop(); activeScan = null; }
  if (activeOverlay !== null) { activeOverlay.remove(); activeOverlay = null; }
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
          <div className="add-remote-url-row">
            <input type="text" id="add-remote-url" className="add-remote-url" placeholder="https://host:4174" autocomplete="off" spellcheck={false} />
            {canScanQr() ? <button type="button" className="btn btn-sm add-remote-scan" title="Scan a pairing QR code">Scan QR</button> : ''}
          </div>
          <div className="add-remote-scan-area" style="display:none"></div>
          <div className="add-remote-hint" aria-live="polite"></div>
          <div className="add-remote-projects"></div>
          <div className="add-remote-cert-note settings-hint">
            The client certificate installed in your browser is presented on the secure connection.
            {' '}Don’t have one yet? Enroll a device on the server under Settings → Remote Access.
          </div>
        </div>
        <div className="worker-pool-controls">
          <button type="button" className="btn btn-sm add-remote-cancel">Cancel</button>
          <button type="button" className="btn btn-sm add-remote-primary" disabled>Connect</button>
        </div>
      </div>
    </div>,
  );

  const input = overlay.querySelector('.add-remote-url');
  const hint = overlay.querySelector('.add-remote-hint');
  const projectsEl = overlay.querySelector('.add-remote-projects');
  const primaryBtn = overlay.querySelector('.add-remote-primary');
  if (!(input instanceof HTMLInputElement) || !(hint instanceof HTMLElement) || !(projectsEl instanceof HTMLElement) || !(primaryBtn instanceof HTMLButtonElement)) return;

  // 'url' = entering/validating a URL (primary = Connect); 'projects' = a project
  // list is shown (primary = Mount selected).
  let phase: 'url' | 'projects' = 'url';
  let currentOrigin = '';

  const setHint = (text: string, warn = false): void => {
    hint.textContent = text;
    hint.classList.toggle('add-remote-hint-warn', warn);
  };

  /** Validate the URL input (phase 'url'); returns the normalized origin or null. */
  const validate = (): string | null => {
    const result = normalizeServerUrl(input.value);
    if (!result.ok) {
      setHint(input.value.trim() === '' ? '' : result.error);
      primaryBtn.disabled = true;
      return null;
    }
    if (result.origin.startsWith('http://') && !isLoopbackOrigin(result.origin)) {
      setHint(`A remote server should be https. Using ${result.origin}?`, true);
    } else {
      setHint(result.origin);
    }
    primaryBtn.disabled = false;
    return result.origin;
  };

  const backToUrlPhase = (): void => {
    phase = 'url';
    projectsEl.replaceChildren();
    primaryBtn.textContent = 'Connect';
    input.disabled = false;
    validate();
  };

  /** Enumerate the server's projects and switch to the multi-select phase. */
  const connect = async (): Promise<void> => {
    const origin = validate();
    if (origin === null) return;
    currentOrigin = origin;
    primaryBtn.disabled = true;
    setHint(`Connecting to ${origin}…`);
    let projects: RemoteProject[];
    try {
      projects = await fetchRemoteProjects(origin);
    } catch (e) {
      // Enumeration failed — let the user add the server anyway (enumerate later).
      setHint(`Couldn’t list projects: ${e instanceof Error ? e.message : String(e)}`, true);
      projectsEl.replaceChildren(toElement(
        <div className="add-remote-enum-fail settings-hint">
          Make sure the server is reachable and your client certificate is installed. You can add the server now and mount its projects later.
        </div>,
      ));
      primaryBtn.textContent = 'Add server anyway';
      primaryBtn.disabled = false;
      phase = 'url'; // primary now just persists the server (no projects)
      return;
    }
    if (projects.length === 0) {
      setHint('The server has no projects to mount.', true);
      primaryBtn.textContent = 'Add server anyway';
      primaryBtn.disabled = false;
      phase = 'url';
      return;
    }
    // Render the multi-select list (all checked by default).
    setHint(`${String(projects.length)} project${projects.length === 1 ? '' : 's'} available:`);
    projectsEl.replaceChildren(toElement(
      <div className="add-remote-project-list">
        {projects.map(p => (
          <label className="add-remote-project-row">
            <input type="checkbox" className="add-remote-project-cb" data-secret={p.secret} data-name={p.name} checked />
            <span className="add-remote-project-name">{p.name}</span>
          </label>
        ))}
      </div>,
    ));
    phase = 'projects';
    input.disabled = true;
    primaryBtn.textContent = 'Mount selected';
    primaryBtn.disabled = false;
  };

  const selectedProjects = (): RemoteProject[] => {
    const out: RemoteProject[] = [];
    for (const cb of projectsEl.querySelectorAll('.add-remote-project-cb')) {
      if (cb instanceof HTMLInputElement && cb.checked) {
        out.push({ secret: cb.dataset.secret ?? '', name: cb.dataset.name ?? '' });
      }
    }
    return out;
  };

  const finish = async (msg: string): Promise<void> => {
    await refreshProjectTabs();
    closeAddRemoteServerDialog();
    showToast(msg, { variant: 'success' });
  };

  /** Primary-button action, dispatched by phase. */
  const onPrimary = async (): Promise<void> => {
    if (phase === 'url') {
      // Either "Connect" (enumerate) or, after an enum failure, "Add server anyway".
      if (primaryBtn.textContent === 'Connect') { await connect(); return; }
      const origin = validate();
      if (origin === null) return;
      primaryBtn.disabled = true;
      try {
        await addRemoteServer(origin, labelForOrigin(origin));
        await finish(`Added ${labelForOrigin(origin)}. Mount its projects from the tab menu.`);
      } catch (e) {
        setHint(`Couldn’t save: ${e instanceof Error ? e.message : String(e)}`, true);
        primaryBtn.disabled = false;
      }
      return;
    }
    // phase === 'projects' — mount the selected projects.
    const selected = selectedProjects();
    if (selected.length === 0) { setHint('Select at least one project to mount.', true); return; }
    primaryBtn.disabled = true;
    try {
      await mountRemoteProjects(currentOrigin, labelForOrigin(currentOrigin), selected);
      await finish(`Mounted ${String(selected.length)} project${selected.length === 1 ? '' : 's'} from ${labelForOrigin(currentOrigin)}.`);
    } catch (e) {
      setHint(`Couldn’t mount: ${e instanceof Error ? e.message : String(e)}`, true);
      primaryBtn.disabled = false;
    }
  };

  input.addEventListener('input', () => { if (phase === 'projects') backToUrlPhase(); else validate(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void onPrimary(); });
  primaryBtn.addEventListener('click', () => void onPrimary());

  // HS-9308 — "Scan QR": decode a Hot Sheet pairing QR (`{token, url}`) via the
  // shared camera scanner, fill the URL, and stash the pairing token (consumed by
  // the in-app enrollment flow — HS-9309 for the Tauri cert path). The scanned URL
  // is validated the same as a typed one.
  const scanArea = overlay.querySelector('.add-remote-scan-area');
  overlay.querySelector('.add-remote-scan')?.addEventListener('click', () => {
    if (!(scanArea instanceof HTMLElement)) return;
    if (activeScan !== null) { activeScan.stop(); activeScan = null; scanArea.style.display = 'none'; scanArea.replaceChildren(); return; }
    scanArea.style.display = '';
    setHint('Point the camera at the pairing QR code…');
    if (phase === 'projects') backToUrlPhase();
    activeScan = startPairingQrScan(
      scanArea,
      (payload) => {
        if (activeScan !== null) { activeScan.stop(); activeScan = null; }
        scanArea.style.display = 'none';
        scanArea.replaceChildren();
        // The QR fills the server URL. Its pairing `token` drives in-app cert
        // enrollment (HS-9309, Tauri) — for the web path the cert is installed in
        // the browser store out-of-band, so the token isn't consumed here yet.
        input.value = payload.url;
        validate();
      },
      (message) => {
        if (activeScan !== null) { activeScan.stop(); activeScan = null; }
        scanArea.style.display = 'none';
        scanArea.replaceChildren();
        setHint(`${message} Enter the URL manually.`, true);
      },
    );
  });
  overlay.querySelector('.add-remote-cancel')?.addEventListener('click', closeAddRemoteServerDialog);
  overlay.querySelector('.worker-pool-close')?.addEventListener('click', closeAddRemoteServerDialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAddRemoteServerDialog(); });

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  input.focus();
}
