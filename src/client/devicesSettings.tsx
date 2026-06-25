/**
 * HS-9024 — the "Remote Access" settings tab: enrolled mTLS client devices
 * (docs/94 §94.4.2, docs/97). mTLS only engages when the server is exposed over
 * `--bind`, but credentials are minted **locally** (loopback-only on the server),
 * so this section lives in the normal local app. Each device is a CA-signed
 * client cert; minting hands back a password-protected `.p12` to install on the
 * remote machine. Revoking a device blocks it at connect time (HS-8995) and
 * closes any live socket on the next sweep (HS-9025).
 *
 * Mirrors `keysSettings.tsx` (list rows + an in-app form dialog + a confirm on
 * destructive actions). The `.p12` download goes through `saveBytes`, which is
 * Tauri-safe (native save dialog in the desktop build, Blob download in a
 * browser) — never a raw `<a download>`, which WKWebView silently no-ops.
 *
 * HS-9026 adds the "Pair a device" QR flow to this same panel (see
 * `devicesPairing.tsx`, wired from `bindDevicesSettings`).
 */
import { type EnrolledDevice, listEnrolledDevices, mintDeviceP12, revokeEnrolledDevice } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { confirmDialog } from './confirm.js';
import { bindDevicesPairing } from './devicesPairing.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { saveBytes } from './tauriIntegration.js';
import { showToast } from './toast.js';

const LUCIDE = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '15', height: '15', viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor',
  'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
} as const;
const REVOKE_ICON = <svg {...LUCIDE}><circle cx="12" cy="12" r="10"/><line x1="4.93" x2="19.07" y1="4.93" y2="19.07"/></svg>;

/** Decode a base64 string (the minted `.p12`) into raw bytes for `saveBytes`. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A short, human-friendly form of the opaque client id (for the row + tooltips). */
function shortId(clientId: string): string {
  return clientId.length > 8 ? clientId.slice(0, 8) : clientId;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface DeviceFormField { label: string; type: 'text' | 'password'; placeholder?: string }

/** A minimal in-app form dialog (Tauri-safe; never `window.prompt`). Returns the
 *  trimmed field values on submit, or null on cancel. Modeled on the keys tab. */
function openDeviceFormDialog(opts: { title: string; confirmLabel: string; fields: DeviceFormField[] }): Promise<string[] | null> {
  return new Promise((resolve) => {
    const fieldRows: SafeHtml[] = opts.fields.map(f => (
      <div className="settings-key-dialog-field">
        <label>{f.label}</label>
        <input type={f.type} className="settings-key-dialog-input" placeholder={f.placeholder ?? ''} autoComplete="off" />
      </div>
    ));
    const overlay = toElement(
      <div className="confirm-dialog-overlay" role="dialog" aria-modal="true" aria-label={opts.title}>
        <div className="confirm-dialog settings-key-dialog">
          <div className="confirm-dialog-header">{opts.title}</div>
          <div className="confirm-dialog-body">{fieldRows}</div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm settings-key-dialog-cancel">Cancel</button>
            <button type="button" className="btn btn-sm settings-key-dialog-ok">{opts.confirmLabel}</button>
          </div>
        </div>
      </div>,
    );
    const inputs = [...overlay.querySelectorAll('.settings-key-dialog-input')]
      .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);

    let settled = false;
    const finish = (result: string[] | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const submit = (): void => {
      const values = inputs.map(i => i.value.trim());
      for (let i = 0; i < opts.fields.length; i++) {
        if (values[i] === '') { showToast(`${opts.fields[i].label} is required.`, { variant: 'warning' }); inputs[i].focus(); return; }
      }
      finish(values);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };
    requireChild<HTMLButtonElement>(overlay, '.settings-key-dialog-cancel').addEventListener('click', () => finish(null));
    requireChild<HTMLButtonElement>(overlay, '.settings-key-dialog-ok').addEventListener('click', submit);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    inputs[0]?.focus();
  });
}

function renderDeviceRow(device: EnrolledDevice, onChanged: () => void): HTMLElement {
  const row = toElement(
    <div className="settings-key-row" data-client-id={device.clientId}>
      <div className="settings-key-row-main">
        <span className="settings-device-label">{device.label}</span>
        <span className="settings-key-type-label" title={`Device id ${device.clientId}`}>{shortId(device.clientId)}</span>
        {device.revoked
          ? <span className="settings-device-revoked-chip">Revoked</span>
          : <button type="button" className="icon-btn settings-device-revoke" title="Revoke this device" aria-label="Revoke device">{REVOKE_ICON}</button>}
      </div>
      <div className="settings-key-meta">{device.revoked ? `Revoked ${device.revokedAt !== undefined ? formatDate(device.revokedAt) : ''}` : `Enrolled ${formatDate(device.enrolledAt)} · expires ${formatDate(device.expiresAt)}`}</div>
    </div>,
  );

  const revokeBtn = row.querySelector('.settings-device-revoke');
  revokeBtn?.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog({
        message: `Revoke "${device.label}"? It will be blocked from connecting immediately, and any live connection is closed within ~30s.`,
        title: 'Revoke Device',
        confirmLabel: 'Revoke',
        danger: true,
      });
      if (!ok) return;
      try {
        await revokeEnrolledDevice(device.clientId);
        showToast('Device revoked.', { variant: 'success' });
        onChanged();
      } catch {
        showToast('Could not revoke the device.', { variant: 'warning' });
      }
    })();
  });
  return row;
}

/** Fetch + render the device list into the panel. */
async function refreshDeviceList(): Promise<void> {
  const list = byIdOrNull('settings-devices-list');
  if (list === null) return;
  let devices: EnrolledDevice[];
  try {
    devices = await listEnrolledDevices();
  } catch {
    list.replaceChildren(toElement(<div className="settings-hint">Could not load devices.</div>));
    return;
  }
  if (devices.length === 0) {
    list.replaceChildren(toElement(<div className="settings-hint" style="padding:8px 0">No devices enrolled yet. Add one below to connect over the network.</div>));
    return;
  }
  list.replaceChildren(...devices.map(d => renderDeviceRow(d, () => { void refreshDeviceList(); })));
}

/** The "Add device" flow: mint a `.p12` and save it (Tauri-safe download). */
async function openAddDeviceDialog(): Promise<void> {
  const result = await openDeviceFormDialog({
    title: 'Add Device',
    confirmLabel: 'Create & Download .p12',
    fields: [
      { label: 'Device name', type: 'text', placeholder: 'e.g. Brian’s iPhone' },
      { label: 'Export password', type: 'password', placeholder: 'protects the .p12 file' },
    ],
  });
  if (result === null) return;
  const [label, password] = result;
  try {
    const res = await mintDeviceP12({ label, password });
    const saved = await saveBytes(res.filename, base64ToBytes(res.p12Base64), 'application/x-pkcs12');
    if (saved) {
      showToast(`Created "${label}". Install the .p12 on that device (it needs the export password).`, { variant: 'success' });
    }
    await refreshDeviceList();
  } catch {
    showToast('Could not create the device. Minting is only allowed from the local machine.', { variant: 'warning' });
  }
}

/** Bind the Remote Access tab: the Add-device button + the (lazy) list load. */
export function bindDevicesSettings(): void {
  const addBtn = byIdOrNull<HTMLButtonElement>('settings-device-add-btn');
  if (addBtn === null) return;
  addBtn.addEventListener('click', () => { void openAddDeviceDialog(); });
  byIdOrNull('settings-btn')?.addEventListener('click', () => { void refreshDeviceList(); });
  bindDevicesPairing(); // HS-9026 — "Pair a Device…" QR flow in the same panel.
  void refreshDeviceList();
}

/** Exposed for the QR-pairing flow (HS-9026) to refresh after a remote enroll. */
export { refreshDeviceList };
