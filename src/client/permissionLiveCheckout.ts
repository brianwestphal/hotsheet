/**
 * Live-terminal §54-checkout choreography for the permission popup
 * (HS-8171 v2 / HS-8182 / HS-8206 / HS-8217 / HS-8218 / HS-8301), extracted
 * out of `permissionOverlay.tsx` per HS-8394.
 *
 * The permission popup can borrow the project's live `claude` terminal via
 * §54 `terminalCheckout` so the body renders an interactive (read-only)
 * view of the running TUI instead of a flat `<pre>` / DOM diff. This
 * module owns the three slots that lifecycle requires:
 * - `activeCheckoutHandle` — the borrowed handle; null when the popup
 *   isn't holding one.
 * - `activeLiveTermResizeObserver` — observes the popup's
 *   `liveTermContainer` to retry fit on layout changes (HS-8206 v1).
 * - `liveTermFitRetryTimer` — the HS-8206 v2 retry-loop handle that polls
 *   `proposeDimensions()` until xterm's renderer measures cell dims.
 *
 * `permissionOverlay.tsx` still owns the bigger popup state machine; this
 * module is the bounded §54 wrapper. Direct mutation via the exported
 * setters mirrors the pattern the dashboard's state-holder module uses
 * for `dashboardState`.
 */

import { type CheckoutHandle } from './terminalCheckout.js';

interface LiveCheckoutState {
  activeCheckoutHandle: CheckoutHandle | null;
  activeLiveTermResizeObserver: ResizeObserver | null;
  liveTermFitRetryTimer: ReturnType<typeof setTimeout> | null;
}

function freshLiveCheckoutState(): LiveCheckoutState {
  return {
    activeCheckoutHandle: null,
    activeLiveTermResizeObserver: null,
    liveTermFitRetryTimer: null,
  };
}

let liveCheckoutState: LiveCheckoutState = freshLiveCheckoutState();

/** HS-8206 v2 — total retry budget for the live-term fit. xterm's
 *  renderer typically measures cell dims within a couple of frames after
 *  reparenting; the budget is generous enough to cover slow first paints
 *  on cold startup (heavy theme load, lots of scrollback to replay) but
 *  not so long that a genuinely-broken environment hangs the fit forever. */
const LIVE_TERM_FIT_RETRY_INTERVAL_MS = 16;
const LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS = 30;

/** Read the active checkout handle (null when the popup is not borrowing
 *  the live terminal). */
export function getActiveCheckout(): CheckoutHandle | null {
  return liveCheckoutState.activeCheckoutHandle;
}

/** Set the active checkout handle. Called by `showPermissionPopupBody`
 *  after `checkout(...)` returns the live xterm. */
export function setActiveCheckout(handle: CheckoutHandle): void {
  liveCheckoutState.activeCheckoutHandle = handle;
}

/** Set the ResizeObserver instance watching the live-term container.
 *  Called by `showPermissionPopupBody` after constructing the observer. */
export function setActiveLiveTermResizeObserver(observer: ResizeObserver): void {
  liveCheckoutState.activeLiveTermResizeObserver = observer;
}

/** Combined release: disconnect the ResizeObserver, clear the fit-retry
 *  timer, release the §54 checkout handle, and clear the state slot.
 *  Idempotent — safe to call when no handle is active. */
export function releaseActiveCheckoutIfAny(): void {
  disconnectActiveLiveTermResizeObserver();
  clearLiveTermFitRetryTimer();
  if (liveCheckoutState.activeCheckoutHandle === null) return;
  try { liveCheckoutState.activeCheckoutHandle.release(); } catch { /* swallow — entry may already be torn down */ }
  liveCheckoutState.activeCheckoutHandle = null;
}

export function disconnectActiveLiveTermResizeObserver(): void {
  if (liveCheckoutState.activeLiveTermResizeObserver === null) return;
  try { liveCheckoutState.activeLiveTermResizeObserver.disconnect(); } catch { /* swallow */ }
  liveCheckoutState.activeLiveTermResizeObserver = null;
}

export function clearLiveTermFitRetryTimer(): void {
  if (liveCheckoutState.liveTermFitRetryTimer === null) return;
  clearTimeout(liveCheckoutState.liveTermFitRetryTimer);
  liveCheckoutState.liveTermFitRetryTimer = null;
}

/** HS-8206 v2 — drive `fit.proposeDimensions()` to a successful resize,
 *  retrying up to `LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS` times with
 *  `LIVE_TERM_FIT_RETRY_INTERVAL_MS` between attempts. Bails if the
 *  active checkout handle changes (popup closed / replaced) or the popup
 *  is dismissed mid-retry. Idempotent: a re-entry while a retry chain is
 *  in flight cancels the pending timer and starts fresh, so the
 *  ResizeObserver firing during a retry doesn't produce overlapping
 *  chains. */
export function runLiveTermFitWithRetry(forHandle: CheckoutHandle): void {
  clearLiveTermFitRetryTimer();
  let attempts = 0;
  function attempt(): void {
    liveCheckoutState.liveTermFitRetryTimer = null;
    if (liveCheckoutState.activeCheckoutHandle !== forHandle) return; // popup closed or re-checked-out.
    attempts++;
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = forHandle.fit.proposeDimensions();
    } catch { /* term disposed mid-flight */ return; }
    if (proposed === undefined) {
      if (attempts >= LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS) return;
      liveCheckoutState.liveTermFitRetryTimer = setTimeout(attempt, LIVE_TERM_FIT_RETRY_INTERVAL_MS);
      return;
    }
    if (proposed.cols === forHandle.term.cols && proposed.rows === forHandle.term.rows) {
      return; // already at the right dims — break the fit/observe loop.
    }
    try { forHandle.resize(proposed.cols, proposed.rows); } catch { /* term disposed */ }
  }
  // First attempt on the next animation frame so the popup overlay's
  // initial layout has settled before we read CSS dims.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(attempt);
  } else {
    liveCheckoutState.liveTermFitRetryTimer = setTimeout(attempt, 0);
  }
}

/** **TEST ONLY** — boolean snapshot of the live-checkout state slots,
 *  consumed by `permissionOverlay.tsx::_inspectStateForTesting`. */
export function _inspectLiveCheckoutForTesting(): {
  activeCheckoutHandle: boolean;
  activeLiveTermResizeObserver: boolean;
  liveTermFitRetryTimer: boolean;
} {
  return {
    activeCheckoutHandle: liveCheckoutState.activeCheckoutHandle !== null,
    activeLiveTermResizeObserver: liveCheckoutState.activeLiveTermResizeObserver !== null,
    liveTermFitRetryTimer: liveCheckoutState.liveTermFitRetryTimer !== null,
  };
}

/** **TEST ONLY** — clear the live-checkout state slot, running disposers
 *  BEFORE the swap. Called by `permissionOverlay.tsx::_resetStateForTesting`. */
export function _resetLiveCheckoutStateForTesting(): void {
  releaseActiveCheckoutIfAny();
  liveCheckoutState = freshLiveCheckoutState();
}
