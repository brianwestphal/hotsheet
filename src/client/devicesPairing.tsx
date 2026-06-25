/**
 * HS-9026 — desktop QR-pairing display for mTLS device enrollment (docs/94
 * §94.4.2 Phase 2). The server pairing core shipped in HS-8996: `startPairing()`
 * (loopback-only) issues a short-lived single-use token; the scanning device
 * POSTs its CSR with that token to `completePairing()`. This renders the QR the
 * phone scans.
 *
 * The QR encodes `{ token, url }` where `url` is the address the *remote* device
 * reaches this server at. The server behind NAT can't reliably know its own
 * externally-reachable URL (relates to `tlsServerHosts` / HS-7942), and in the
 * Tauri desktop build `window.location` is localhost — useless to a phone — so
 * the operator confirms/edits it in a field (remembered in localStorage). A
 * countdown tracks the token's `expiresAt`; on expiry we transparently re-issue.
 *
 * The phone half (scan → in-browser CSR → install the signed cert) is
 * platform-specific and verified manually (docs/manual-test-plan.md); this file
 * is the desktop end of the exchange.
 */
import QRCode from 'qrcode';

import { startPairing } from '../api/index.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { pairingPayload } from './pairingPayload.js';
import { showToast } from './toast.js';

const REACHABLE_URL_KEY = 'hotsheet:pairing-reachable-url';

/** Best guess for the reachable URL: a remembered value, else the current
 *  origin (correct in a browser opened at the LAN address; the operator edits
 *  it in Tauri, where the origin is localhost). */
function defaultReachableUrl(): string {
  try {
    const saved = localStorage.getItem(REACHABLE_URL_KEY);
    if (saved !== null && saved.trim() !== '') return saved;
  } catch { /* localStorage may be unavailable */ }
  return window.location.origin;
}

let active = false;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

/** Read the module-level `active` flag through a call so control-flow narrowing
 *  doesn't treat a re-check after an `await` (where `clearPairing` may have run)
 *  as a constant. */
function isActive(): boolean { return active; }

function stopCountdown(): void {
  if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
}

/** Tear down any live pairing UI (timer + DOM). */
function clearPairing(): void {
  active = false;
  stopCountdown();
  const area = byIdOrNull('settings-devices-pairing');
  if (area !== null) area.replaceChildren();
}

/** Step 1: ask the operator to confirm the address the device will reach. */
function renderAddressForm(): void {
  const area = byIdOrNull('settings-devices-pairing');
  if (area === null) return;
  active = true;
  stopCountdown();
  const form = toElement(
    <div className="settings-pairing-form">
      <label className="settings-hint" style="display:block; margin-bottom:4px">Address this device will reach the server at (the phone must be able to open it):</label>
      <div style="display:flex; gap:8px; align-items:center">
        <input type="text" className="settings-pairing-url" value={defaultReachableUrl()} placeholder="https://192.168.1.50:4174" style="flex:1 1 auto" autoComplete="off" />
        <button type="button" className="btn btn-sm settings-pairing-generate">Generate Code</button>
        <button type="button" className="btn btn-sm settings-pairing-cancel">Cancel</button>
      </div>
    </div>,
  );
  area.replaceChildren(form);
  const input = requireChild<HTMLInputElement>(form, '.settings-pairing-url');
  requireChild<HTMLButtonElement>(form, '.settings-pairing-generate').addEventListener('click', () => {
    const url = input.value.trim();
    if (url === '') { showToast('Enter the address the device will reach.', { variant: 'warning' }); input.focus(); return; }
    try { localStorage.setItem(REACHABLE_URL_KEY, url); } catch { /* ignore */ }
    void issueAndRenderQr(url);
  });
  requireChild<HTMLButtonElement>(form, '.settings-pairing-cancel').addEventListener('click', clearPairing);
  input.focus();
}

/** Step 2: mint a pairing token and render the QR + countdown. */
async function issueAndRenderQr(url: string): Promise<void> {
  let token: string;
  let expiresAt: number;
  try {
    const res = await startPairing();
    token = res.token;
    expiresAt = res.expiresAt;
  } catch {
    showToast('Could not start pairing. It is only available from the local machine.', { variant: 'warning' });
    return;
  }
  if (!isActive()) return; // operator canceled while the request was in flight

  let dataUrl: string;
  try {
    dataUrl = await QRCode.toDataURL(pairingPayload(token, url), { width: 220, margin: 1 });
  } catch {
    showToast('Could not render the pairing QR code.', { variant: 'warning' });
    return;
  }
  if (!isActive()) return;

  const area = byIdOrNull('settings-devices-pairing');
  if (area === null) return;
  const block = toElement(
    <div className="settings-pairing-active">
      <div className="settings-pairing-qr"><img src={dataUrl} alt="Device pairing QR code" /></div>
      <div className="settings-pairing-countdown" aria-live="polite"></div>
      <div className="settings-hint">Scan with the device's camera. It generates its own key, gets a certificate signed, and appears above. The code is single-use and expires.</div>
      <div style="display:flex; gap:8px">
        <button type="button" className="btn btn-sm settings-pairing-new">New Code</button>
        <button type="button" className="btn btn-sm settings-pairing-done">Done</button>
      </div>
    </div>,
  );
  area.replaceChildren(block);
  const countdownEl = requireChild(block, '.settings-pairing-countdown');
  requireChild<HTMLButtonElement>(block, '.settings-pairing-new').addEventListener('click', () => { void issueAndRenderQr(url); });
  requireChild<HTMLButtonElement>(block, '.settings-pairing-done').addEventListener('click', clearPairing);

  // Countdown to expiry; transparently re-issue when it elapses (so a QR left on
  // screen stays scannable). Guard on `active` + DOM connection so a closed panel
  // stops the churn.
  stopCountdown();
  const tick = (): void => {
    if (!active || !countdownEl.isConnected) { stopCountdown(); return; }
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) { stopCountdown(); void issueAndRenderQr(url); return; }
    const totalSec = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = String(totalSec % 60).padStart(2, '0');
    countdownEl.textContent = `Expires in ${String(m)}:${s}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

/** Bind the "Pair a Device…" button in the Remote Access panel. */
export function bindDevicesPairing(): void {
  const pairBtn = byIdOrNull<HTMLButtonElement>('settings-device-pair-btn');
  if (pairBtn === null) return;
  pairBtn.addEventListener('click', renderAddressForm);
  // Clear any stale QR when the settings dialog re-opens.
  byIdOrNull('settings-btn')?.addEventListener('click', clearPairing);
}
