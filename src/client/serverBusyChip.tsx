/**
 * HS-8175 — Global "server is slow to respond" indicator.
 *
 * When a non-long-poll HTTP request takes longer than the threshold, light
 * up a banner so the user knows the click / action they fired is still in
 * flight (vs the alternative — staring at an unresponsive UI wondering
 * whether the click registered).
 *
 * The user reported a 25 s freeze in `freeze.log` (2026-05-06) where a
 * `fsyncDbDir:backup:5min` blocked the event loop for 25.2 s during which
 * any concurrent button click would have been silently held in flight.
 * The banner surfaces that residual risk now that HS-8160's instrumentation
 * + HS-8178's async backup writers cover the dominant prevention surface.
 *
 * **HS-8226 (2026-05-06)** — replaced the original top-right corner chip
 * with a layout-flow banner styled like `.update-banner`. The chip was
 * "too transparent and too in the corner" per the user's report; the
 * banner sits at the top of the page in the same flex-stack as the
 * update / share / skills banners, in amber palette, non-dismissable
 * (auto-hides when the in-flight set drains). The element is rendered
 * server-side in `pages.tsx` (id `server-slow-banner`) so it lives in
 * the layout flow without us having to push it via `document.body`.
 *
 * ### Excluded endpoints
 * Long-poll endpoints intentionally hold the connection for up to 3 s.
 * `LONG_POLL_PATTERNS` matches any URL we skip — those would false-fire
 * the banner on every poll cycle. Currently:
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
import { byIdOrNull } from './dom.js';

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
let bannerEl: HTMLElement | null = null;

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

/** Look up the server-side-rendered banner element. The banner lives in
 *  the layout flow next to `.update-banner` (HS-8226), so when shown it
 *  pushes content down the same way the update banner does. Returns null
 *  when the layout hasn't rendered yet (e.g. unit tests in happy-dom that
 *  bypass the page render) — callers treat that as "no banner to toggle"
 *  and the chip stays a no-op. */
function lookupBanner(): HTMLElement | null {
  if (bannerEl !== null && bannerEl.isConnected) return bannerEl;
  bannerEl = byIdOrNull('server-slow-banner');
  return bannerEl;
}

function evaluate(): void {
  const banner = lookupBanner();
  const starts: number[] = [];
  for (const r of inFlight) starts.push(r.startTs);
  const show = shouldShowServerBusyChip(starts, Date.now());
  if (banner !== null) banner.style.display = show ? '' : 'none';
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
  const banner = lookupBanner();
  if (banner !== null) banner.style.display = 'none';
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

/**
 * HS-8286 — register an open-ended "the server is responding slowly"
 * signal that does NOT correspond to a single HTTP request. Used by the
 * terminal stall detection (`terminalCheckout.tsx`) so when a PTY stops
 * echoing keystrokes, the same global banner surfaces — pre-fix the per-
 * terminal `.terminal-stall-indicator` chip painted on the tile / drawer
 * header instead, which the user found confusing because it suggested
 * something was wrong with that ONE terminal rather than the server.
 *
 * The token is registered with a synthetic `startTs` 1 ms past the
 * threshold so the banner shows immediately — the caller has already
 * applied its own threshold (e.g. terminal stall = 1.5 s of no echo).
 * Release the token when the slowness resolves.
 *
 * **HS-8309 (2026-05-09) — leak-prevention contract.** Because the
 * synthetic `startTs` always satisfies `now - startTs > threshold`, an
 * unreleased token pins the banner indefinitely. The caller MUST
 * guarantee one of: (a) the resolving condition will fire (e.g. real
 * echo arrives in the terminal stall path), or (b) the token's release
 * is invoked from the dispose / cleanup path even if the resolving
 * condition never comes. The terminal stall watcher pre-HS-8309 leaked
 * tokens on dropped keystrokes (no `ws` to send through → no echo can
 * ever come back); fixed at the keystroke-gate in `terminalCheckout.tsx`
 * so dropped input never opens a token in the first place.
 */
export function trackPersistentSlowEvent(): () => void {
  const req: InFlightRequest = { startTs: Date.now() - SERVER_BUSY_THRESHOLD_MS - 1 };
  inFlight.add(req);
  startEvaluateTimer();
  evaluate();
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
  const banner = lookupBanner();
  if (banner !== null) banner.style.display = 'none';
  bannerEl = null;
}

/** **TEST ONLY** — peek at the current in-flight count. */
export function _inspectServerBusyForTesting(): { inFlightCount: number; chipVisible: boolean } {
  const banner = lookupBanner();
  return {
    inFlightCount: inFlight.size,
    chipVisible: banner !== null && banner.style.display !== 'none',
  };
}
