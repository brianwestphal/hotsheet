/**
 * HS-8175 — Global "server is slow to respond" chip.
 *
 * Sits next to the per-terminal stall indicator: when a non-long-poll HTTP
 * request takes longer than the threshold, mount a small fixed-position
 * chip in the top-right of the viewport so the user knows the click /
 * action they fired is still in flight (vs the alternative — staring at
 * an unresponsive UI wondering whether the click registered).
 *
 * The user reported a 25 s freeze in `freeze.log` (2026-05-06) where a
 * `fsyncDbDir:backup:5min` blocked the event loop for 25.2 s during which
 * any concurrent button click would have been silently held in flight.
 * The chip surfaces that residual risk now that HS-8160's instrumentation
 * + HS-8178's async backup writers cover the dominant prevention surface.
 *
 * ### Excluded endpoints
 * Long-poll endpoints intentionally hold the connection for up to 3 s.
 * `LONG_POLL_PATTERNS` matches any URL we skip — those would false-fire
 * the chip on every poll cycle. Currently:
 * - `/poll?version=` (the dashboard change-version long-poll)
 * - `/projects/permissions` (channel permission long-poll)
 * - `/projects/bell-state` (bell long-poll)
 *
 * If a future endpoint joins the long-poll family, add it here.
 *
 * ### Threshold
 * 3 s for HTTP — higher than the 1.5 s terminal threshold because HTTP
 * requests can normally take longer (DB queries, attachment serving,
 * markdown sync). Tunable later.
 */
import { toElement } from './dom.js';

export const SERVER_BUSY_THRESHOLD_MS = 3000;

const LONG_POLL_PATTERNS: readonly string[] = [
  '/poll?',
  '/projects/permissions',
  '/projects/bell-state',
];

/** Test whether a URL matches a long-poll pattern. Exported so the
 *  `api.tsx` wrapper can skip the chip for those endpoints AND so unit
 *  tests can assert the pattern set. */
export function isLongPollUrl(url: string): boolean {
  for (const pat of LONG_POLL_PATTERNS) if (url.includes(pat)) return true;
  return false;
}

interface InFlightRequest {
  startTs: number;
}

const inFlight = new Set<InFlightRequest>();
let evaluateTimer: number | null = null;
let chipEl: HTMLElement | null = null;

/** Test the in-flight set for a request that's been open longer than the
 *  threshold. Pure helper — no DOM. Exported for unit-test isolation. */
export function shouldShowServerBusyChip(
  inFlightStartTimestamps: readonly number[],
  now: number,
  thresholdMs: number = SERVER_BUSY_THRESHOLD_MS,
): boolean {
  for (const startTs of inFlightStartTimestamps) {
    if (now - startTs > thresholdMs) return true;
  }
  return false;
}

function ensureChip(): HTMLElement {
  if (chipEl !== null) return chipEl;
  chipEl = toElement(
    <div className="server-busy-chip" style="display:none" title="Server is slow — your request is still in flight">
      <span className="server-busy-dot"></span>
      <span className="server-busy-label">Server slow</span>
    </div>,
  );
  document.body.appendChild(chipEl);
  return chipEl;
}

function evaluate(): void {
  const chip = ensureChip();
  const starts: number[] = [];
  for (const r of inFlight) starts.push(r.startTs);
  const show = shouldShowServerBusyChip(starts, Date.now());
  chip.style.display = show ? '' : 'none';
}

function startEvaluateTimer(): void {
  if (evaluateTimer !== null) return;
  evaluateTimer = window.setInterval(evaluate, 250);
}

function stopEvaluateTimerIfIdle(): void {
  if (inFlight.size > 0) return;
  if (evaluateTimer !== null) {
    window.clearInterval(evaluateTimer);
    evaluateTimer = null;
  }
  if (chipEl !== null) chipEl.style.display = 'none';
}

/**
 * Track a server request from start to end. Call before the `fetch`,
 * await the returned `done()` after the fetch (success or error). The
 * chip shows automatically when the request crosses the threshold and
 * hides when the last in-flight request completes.
 *
 * Skips the chip entirely when `url` matches a long-poll pattern.
 */
export function trackServerRequest(url: string): () => void {
  if (isLongPollUrl(url)) return () => { /* skipped */ };
  const req: InFlightRequest = { startTs: Date.now() };
  inFlight.add(req);
  startEvaluateTimer();
  return () => {
    inFlight.delete(req);
    if (inFlight.size === 0) stopEvaluateTimerIfIdle();
    else evaluate();
  };
}

/** **TEST ONLY** — reset module-level state. Mirrors the convention in
 *  the other client modules (`_resetForTesting`). */
export function _resetServerBusyChipForTesting(): void {
  inFlight.clear();
  if (evaluateTimer !== null) {
    window.clearInterval(evaluateTimer);
    evaluateTimer = null;
  }
  if (chipEl !== null) {
    chipEl.remove();
    chipEl = null;
  }
}

/** **TEST ONLY** — peek at the current in-flight count. */
export function _inspectServerBusyForTesting(): { inFlightCount: number; chipVisible: boolean } {
  return {
    inFlightCount: inFlight.size,
    chipVisible: chipEl !== null && chipEl.style.display !== 'none',
  };
}
