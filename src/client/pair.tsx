/**
 * HS-9033 — the device (phone) side of mTLS QR pairing (docs/94 §94.4.2 Phase 2),
 * the client entry for the standalone `/pair` page (`src/components/pairPage.tsx`).
 *
 * Flow: read the desktop's pairing payload (in-page camera scan via the native
 * `BarcodeDetector`, or paste/hash fallback) → collect a device label + a `.p12`
 * password → generate an RSA keypair + CSR IN THE BROWSER (the private key never
 * leaves the device) → POST it with the single-use token to
 * `/api/auth/pair/complete` → assemble a password-protected `.p12` from the
 * device key + the returned cert + CA → offer it for download with per-platform
 * install instructions.
 *
 * The crypto is in the DOM-free, unit-tested `pairing/devicePairing.ts`; this
 * file is the page wiring (steps, camera, errors, install help). It is a separate
 * bundle from `app.tsx` so the heavy `node-forge` dependency only loads here.
 *
 * Installing the `.p12` as a usable client cert is platform-specific and verified
 * manually (docs/manual-test-plan.md §7) — this surface gets the bytes onto the
 * device and explains the per-OS steps; the OS keychain import is the user's.
 */
import type { z } from 'zod';

import { PairCompleteResSchema } from '../api/enrollment.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { buildClientP12, generateDeviceCsr } from './pairing/devicePairing.js';
import { type PairingPayload, parsePairingPayload } from './pairingPayload.js';

/** The mount the server page renders (`#pair-root`). */
function root(): HTMLElement | null {
  return byIdOrNull('pair-root');
}

function show(el: HTMLElement): void {
  const r = root();
  if (r !== null) r.replaceChildren(el);
}

/** A `BarcodeDetector`-like constructor, when the platform exposes one. Narrowed
 *  off `window` without `any` — absent on iOS before 17 and on Firefox, hence the
 *  camera step is offered only when this is present (paste always works). */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}
function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof ctor === 'function' ? (ctor as BarcodeDetectorCtor) : null;
}

// --- Step 1: obtain the pairing payload ------------------------------------

function renderStart(message?: { text: string; kind: 'error' | 'info' }): void {
  const canScan = barcodeDetectorCtor() !== null;
  const el = toElement(
    <div className="pair-step pair-step-start">
      {message !== undefined
        ? <p className={message.kind === 'error' ? 'pair-error' : 'pair-info'}>{message.text}</p>
        : null}
      <p className="pair-info">Open Hot Sheet on your computer, go to <strong>Settings → Remote Access → Pair a Device</strong>, and show the QR code.</p>
      {canScan
        ? <button type="button" className="btn pair-scan-btn" id="pair-scan-btn">Scan QR code</button>
        : <p className="pair-hint">This browser can't scan in-page. Enter the code from under the QR instead.</p>}
      <div className="pair-scan-area" id="pair-scan-area" style="display:none"></div>
      <details className="pair-paste" id="pair-paste-details">
        <summary>Enter the code manually</summary>
        <p className="pair-hint">Paste the pairing code text shown beneath the QR on your computer.</p>
        <textarea id="pair-paste-input" className="pair-paste-input" rows={4} placeholder='{"v":1,"kind":"hotsheet-pair", ...}'></textarea>
        <button type="button" className="btn btn-sm pair-paste-btn" id="pair-paste-btn">Use this code</button>
      </details>
    </div>,
  );
  show(el);
  // Open the manual-entry section by default when the camera path is unavailable.
  if (!canScan) requireChild<HTMLDetailsElement>(el, '#pair-paste-details').open = true;

  if (canScan) {
    requireChild<HTMLButtonElement>(el, '#pair-scan-btn').addEventListener('click', () => { void startCameraScan(); });
  }
  requireChild<HTMLButtonElement>(el, '#pair-paste-btn').addEventListener('click', () => {
    const text = requireChild<HTMLTextAreaElement>(el, '#pair-paste-input').value;
    const payload = parsePairingPayload(text);
    if (payload === null) { renderStart({ text: "That doesn't look like a Hot Sheet pairing code. Copy the whole code from your computer.", kind: 'error' }); return; }
    renderEnroll(payload);
  });
}

/** Open the camera and poll frames for a QR via `BarcodeDetector`. Best-effort:
 *  any failure (permission denied, no camera) falls back to the paste flow. */
async function startCameraScan(): Promise<void> {
  const ctor = barcodeDetectorCtor();
  const area = byIdOrNull('pair-scan-area');
  if (ctor === null || area === null) return;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    renderStart({ text: 'Camera unavailable or permission denied. Enter the code manually below.', kind: 'error' });
    return;
  }

  const video = toElement(<video className="pair-video"></video>) as unknown as HTMLVideoElement;
  video.playsInline = true; // inline playback on iOS (attribute casing varies; set the prop)
  video.muted = true;
  const canvas = toElement(<canvas></canvas>) as unknown as HTMLCanvasElement; // offscreen frame buffer (never mounted)
  area.replaceChildren(video);
  area.style.display = '';
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const detector = new ctor({ formats: ['qr_code'] });
  // A holder object (not a bare `let`) so TS doesn't narrow `stopped` to a
  // literal and flag the post-`stop()` re-check as always-truthy — the flag is
  // mutated across async ticks.
  const scan = { stopped: false };
  const stop = (): void => { scan.stopped = true; for (const t of stream.getTracks()) t.stop(); };

  const tick = async (): Promise<void> => {
    if (scan.stopped) return;
    if (video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        ctx.drawImage(video, 0, 0);
        try {
          const codes = await detector.detect(canvas);
          for (const code of codes) {
            const payload = parsePairingPayload(code.rawValue);
            if (payload !== null) { stop(); renderEnroll(payload); return; }
          }
        } catch { /* transient detect error — keep polling */ }
      }
    }
    // Always reschedule; the top-of-tick guard stops the loop after `stop()`
    // (one extra tick may fire and immediately return — harmless).
    window.setTimeout(() => { void tick(); }, 250);
  };
  void tick();
}

// --- Step 2: collect label + password, then enroll -------------------------

function renderEnroll(payload: PairingPayload): void {
  const defaultLabel = 'My phone';
  const el = toElement(
    <div className="pair-step pair-step-enroll">
      <p className="pair-info">Pairing with <strong className="pair-url">{payload.url}</strong></p>
      <label className="pair-label">Device name
        <input type="text" id="pair-label-input" className="pair-input" value={defaultLabel} autoComplete="off" />
      </label>
      <label className="pair-label">Certificate password
        <input type="password" id="pair-pw-input" className="pair-input" placeholder="Protects the downloaded certificate" autoComplete="new-password" />
      </label>
      <p className="pair-hint">You'll enter this password when installing the certificate on this device. Choose something you'll remember.</p>
      <div className="pair-actions">
        <button type="button" className="btn pair-enroll-btn" id="pair-enroll-btn">Generate &amp; enroll</button>
        <button type="button" className="btn btn-sm pair-back-btn" id="pair-back-btn">Back</button>
      </div>
      <p className="pair-error" id="pair-enroll-error" style="display:none"></p>
    </div>,
  );
  show(el);
  requireChild<HTMLButtonElement>(el, '#pair-back-btn').addEventListener('click', () => renderStart());
  requireChild<HTMLButtonElement>(el, '#pair-enroll-btn').addEventListener('click', () => {
    const label = requireChild<HTMLInputElement>(el, '#pair-label-input').value.trim() || defaultLabel;
    const password = requireChild<HTMLInputElement>(el, '#pair-pw-input').value;
    const errEl = requireChild<HTMLParagraphElement>(el, '#pair-enroll-error');
    if (password.length < 4) {
      errEl.textContent = 'Enter a certificate password (at least 4 characters).';
      errEl.style.display = '';
      return;
    }
    void enroll(payload, label, password);
  });
}

/** The response shape we actually consume (validated with zod — this page does a
 *  raw fetch, not the app transport, so we parse the body ourselves). */
const PairCompleteBody = PairCompleteResSchema;

async function enroll(payload: PairingPayload, label: string, password: string): Promise<void> {
  renderBusy('Generating a secure key on this device…');
  let csrPem: string;
  let privateKeyPem: string;
  try {
    ({ csrPem, privateKeyPem } = await generateDeviceCsr(label));
  } catch {
    renderEnrollError(payload, 'Could not generate a key on this device.');
    return;
  }

  renderBusy('Enrolling with Hot Sheet…');
  let body: z.infer<typeof PairCompleteBody>;
  try {
    // Same-origin: the device loaded this page from the server, so a relative
    // POST reaches the same instance with no CORS preflight. The token (not the
    // origin) is what authorizes the signing server-side.
    const res = await fetch('/api/auth/pair/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: payload.token, csrPem, label }),
    });
    if (!res.ok) {
      renderEnrollError(payload, res.status === 401
        ? 'This pairing code expired or was already used. Generate a fresh QR on your computer and try again.'
        : `Enrollment failed (${String(res.status)}).`);
      return;
    }
    const raw: unknown = await res.json();
    const parsed = PairCompleteBody.safeParse(raw);
    if (!parsed.success) { renderEnrollError(payload, 'The server returned an unexpected response.'); return; }
    body = parsed.data;
  } catch {
    renderEnrollError(payload, 'Could not reach Hot Sheet. Check that this device can still open the server address.');
    return;
  }

  let p12Base64: string;
  try {
    p12Base64 = buildClientP12({ privateKeyPem, certPem: body.certPem, caCertPem: body.caCertPem, password, friendlyName: label });
  } catch {
    renderEnrollError(payload, 'Enrolled, but could not package the certificate on this device.');
    return;
  }
  renderSuccess(label, p12Base64);
}

function renderBusy(text: string): void {
  show(toElement(
    <div className="pair-step pair-step-busy">
      <div className="pair-spinner" aria-hidden="true"></div>
      <p className="pair-info" aria-live="polite">{text}</p>
    </div>,
  ));
}

function renderEnrollError(payload: PairingPayload, message: string): void {
  renderEnroll(payload);
  const errEl = byIdOrNull('pair-enroll-error');
  if (errEl !== null) { errEl.textContent = message; errEl.style.display = ''; }
}

// --- Step 3: deliver the .p12 + install instructions -----------------------

/** A base64 `.p12` as a downloadable object URL. */
function p12ObjectUrl(p12Base64: string): string {
  const bytes = Uint8Array.from(atob(p12Base64), (ch) => ch.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: 'application/x-pkcs12' }));
}

function slugify(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'device' : slug;
}

function renderSuccess(label: string, p12Base64: string): void {
  const href = p12ObjectUrl(p12Base64);
  const filename = `hotsheet-${slugify(label)}.p12`;
  show(toElement(
    <div className="pair-step pair-step-done">
      <p className="pair-success">✓ This device is enrolled as <strong>{label}</strong>.</p>
      <p className="pair-info">Download the certificate, then install it to finish. You'll be asked for the password you just chose.</p>
      <a className="btn pair-download-btn" id="pair-download" href={href} download={filename}>Download certificate (.p12)</a>
      <div className="pair-install-help">
        <h2>Install on this device</h2>
        <details>
          <summary>iPhone / iPad</summary>
          <ol>
            <li>Open the downloaded <code>.p12</code> — iOS saves it as a <em>profile</em>.</li>
            <li>Go to <strong>Settings → General → VPN &amp; Device Management</strong> and install the downloaded profile.</li>
            <li>Enter the certificate password when prompted.</li>
            <li>Safari will offer this certificate when you next open the server address.</li>
          </ol>
        </details>
        <details>
          <summary>Android</summary>
          <ol>
            <li>Open <strong>Settings → Security → Encryption &amp; credentials → Install a certificate → VPN &amp; app user certificate</strong>.</li>
            <li>Pick the downloaded <code>.p12</code> and enter the password.</li>
            <li>Chrome will offer it when you open the server address.</li>
          </ol>
        </details>
        <details>
          <summary>Desktop (Chrome / Edge / Safari)</summary>
          <ol>
            <li>Import the <code>.p12</code> into the OS keychain/certificate store (macOS Keychain Access, Windows <code>certmgr</code>).</li>
            <li>Enter the password. The browser presents it automatically on connect.</li>
          </ol>
        </details>
        <details>
          <summary>Firefox</summary>
          <ol>
            <li>Firefox uses its own store: <strong>Settings → Privacy &amp; Security → Certificates → View Certificates → Your Certificates → Import</strong>.</li>
            <li>Select the <code>.p12</code> and enter the password.</li>
          </ol>
        </details>
      </div>
      <button type="button" className="btn btn-sm pair-again-btn" id="pair-again-btn">Pair another device</button>
    </div>,
  ));
  const again = byIdOrNull('pair-again-btn');
  if (again !== null) again.addEventListener('click', () => renderStart());
}

// --- Boot ------------------------------------------------------------------

function boot(): void {
  if (root() === null) return;
  // A deep-linked payload in the URL hash (`/pair#<json>`) auto-advances; else
  // start at the scan/paste step.
  const hash = window.location.hash.replace(/^#/, '');
  if (hash !== '') {
    let decoded = hash;
    try { decoded = decodeURIComponent(hash); } catch { /* use raw */ }
    const payload = parsePairingPayload(decoded);
    if (payload !== null) { renderEnroll(payload); return; }
  }
  renderStart();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
