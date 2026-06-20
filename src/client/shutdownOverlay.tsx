/**
 * HS-8911 — the desktop "Shutting Down" overlay. Shown (Tauri only) the moment
 * the user commits to quitting, it stays up while the sidecar's bounded
 * `gracefulShutdown` drains and names the current step (fed by the Tauri
 * `shutdown-progress` events `quitConfirm.tsx` wires up). The window closes when
 * the Rust side calls `app.exit(0)` once the sidecar has exited — so the overlay
 * is never torn down here; it simply vanishes with the window. This replaces the
 * beachball the OS used to show on the exiting-but-waiting app (see §37.11).
 */
import { toElement } from './dom.js';
import { SHUTDOWN_DEFAULT_PHRASE } from './shutdownProgress.js';

let overlayEl: HTMLElement | null = null;
let stepEl: Element | null = null;

/**
 * Show the full-screen overlay and return a function that updates the
 * current-step line. Idempotent — a second call reuses the existing overlay and
 * returns a fresh setter. The step text starts at the generic phrase until the
 * first `shutdown-progress` event lands.
 */
export function showShutdownOverlay(): (displayText: string) => void {
  if (overlayEl === null) {
    overlayEl = toElement(
      <div className="shutdown-overlay" role="alertdialog" aria-busy="true" aria-label="Shutting down">
        <div className="shutdown-overlay-box">
          <div className="shutdown-overlay-title">Shutting Down</div>
          <div className="shutdown-overlay-step">{SHUTDOWN_DEFAULT_PHRASE}</div>
          <div className="shutdown-overlay-bar" aria-hidden="true">
            <div className="shutdown-overlay-bar-fill"></div>
          </div>
        </div>
      </div>,
    );
    document.body.appendChild(overlayEl);
    stepEl = overlayEl.querySelector('.shutdown-overlay-step');
  }
  return (displayText: string) => {
    if (stepEl !== null) stepEl.textContent = displayText;
  };
}

/** **TEST ONLY** — remove the overlay + reset module state between tests. */
export function _resetShutdownOverlayForTesting(): void {
  overlayEl?.remove();
  overlayEl = null;
  stepEl = null;
}
