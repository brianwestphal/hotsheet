/**
 * HS-9558 — tell the user when the server process has died.
 *
 * On 2026-08-03 the dev server exited and the window kept showing a fully
 * rendered, completely dead page against `localhost:4174` for 49 minutes. The
 * maintainer reported it as "Hot Sheet hung" (HS-9561) — from the outside a
 * dead server and a wedged one are indistinguishable, and nothing in the app
 * said which it was.
 *
 * The Tauri shell REAPED the child, so it knows the server is gone as a fact.
 * That is much stronger evidence than the client's own failed fetches, which
 * cannot tell "server died" apart from "laptop's wifi blinked" — which is
 * exactly why the existing "Connection Error" popup is the wrong surface here
 * and gets suppressed in favor of this one.
 *
 * Desktop-only by construction: in a browser there is no Tauri event bridge, so
 * `initServerExitedNotice` no-ops. A browser tab pointed at a dead server still
 * gets the ordinary connection-error handling.
 */
import { toElement } from './dom.js';
import { markShuttingDown } from './shutdownState.js';
import { getTauriEventListener } from './tauriIntegration.js';

let overlayEl: HTMLElement | null = null;

/**
 * Put up the (permanent) "Server Stopped" overlay. Idempotent.
 *
 * `detail` is the Rust side's `describe_child_exit` string — the exit code, or
 * a note that it died to a signal, which usually means the watchdog's SIGKILL
 * or the OS OOM killer. Showing it saves the user a trip to the log to learn
 * the single most diagnostic fact about the death.
 *
 * There is no dismiss button on purpose: nothing in this window works any more,
 * so dismissing it would only restore the illusion the overlay exists to break.
 *
 * Reuses the `.shutdown-overlay` styles (HS-8911) — same job, a full-window
 * modal box — minus the progress bar, since nothing here is in progress.
 */
export function showServerExitedOverlay(detail: string): void {
  // The server is gone for a KNOWN reason, so the generic "Unable to reach the
  // server" popup would be strictly less informative noise stacked behind this.
  markShuttingDown();
  document.getElementById('network-error-popup')?.remove();
  if (overlayEl !== null) return;

  overlayEl = toElement(
    <div className="shutdown-overlay" role="alertdialog" aria-label="Server stopped">
      <div className="shutdown-overlay-box">
        <div className="shutdown-overlay-title">Server Stopped</div>
        <div className="shutdown-overlay-step">
          The Hot Sheet server exited, so this window is no longer connected to anything.
          Quit and relaunch Hot Sheet to carry on.
        </div>
        <div className="shutdown-overlay-step">{detail}</div>
        <div className="shutdown-overlay-step">
          Diagnostics: ~/.hotsheet/startup.log (a [fatal] report, if it was a JS fault)
          and ~/.hotsheet/server-stderr.log.
        </div>
      </div>
    </div>,
  );
  document.body.appendChild(overlayEl);
}

/**
 * Subscribe to the shell's `server-exited` event. Call once at boot; no-ops
 * outside Tauri.
 */
export function initServerExitedNotice(): void {
  const listen = getTauriEventListener();
  if (listen === null) return;
  void listen('server-exited', (e: { payload: unknown }) => {
    showServerExitedOverlay(
      typeof e.payload === 'string' && e.payload !== '' ? e.payload : 'The server exited unexpectedly.',
    );
  });
}

/** **TEST ONLY** — remove the overlay + reset module state between tests. */
export function _resetServerExitedForTesting(): void {
  overlayEl?.remove();
  overlayEl = null;
}
