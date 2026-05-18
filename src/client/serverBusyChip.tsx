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
 *
 * ### HS-8425 (2026-05-17) — activation logging
 * Every banner show→hide cycle posts one JSONL entry to
 * `<dataDir>/freeze.log` via `POST /api/diagnostics/freeze` with
 * `source: 'client-server-busy-banner'` and a JSON-encoded `context`
 * payload. Pre-fix banner activations left no trace on disk and the
 * "why did the banner just appear?" question could only be answered
 * by inference from nearby upstream entries (event-loop heartbeats,
 * instrumented async durations). The new entries carry:
 *   - `triggerKind`        — `'http'` or `'persistent'`
 *   - `triggerStartTs`     — start ts of the in-flight item that first
 *                            crossed the threshold (the oldest one at
 *                            the moment of show)
 *   - `triggerUrl`         — URL path (query stripped) for HTTP triggers
 *   - `triggerLabel`       — caller-supplied label for persistent
 *                            triggers (e.g. `terminal-stall:default`)
 *   - `peakInFlightCount`  — max concurrent in-flight items during the
 *                            activation
 *   - `longestInFlightMs`  — max age observed across any in-flight item
 *   - `urlsSeen`           — distinct URL/label tokens encountered
 *                            during the activation (capped at
 *                            `URLS_SEEN_CAP`)
 * Best-effort `navigator.sendBeacon` flush on `pagehide` so a banner
 * up at unload still reaches the log. Failures are swallowed — the
 * freeze log is a diagnostic-only path.
 */
import { byIdOrNull } from './dom.js';
import { isDiagnosticsEnabled } from './globalDiagnostics.js';

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
  /** HS-8425 — discriminator so freeze-log activation entries can name
   *  the trigger as either an HTTP request (carries a `url`) or a
   *  non-HTTP slow event opened via `trackPersistentSlowEvent` (carries
   *  a `label`, e.g. `terminal-stall:default`). */
  kind: 'http' | 'persistent';
  /** HTTP URL for `kind === 'http'`. Stripped of query for log brevity. */
  url: string | null;
  /** Caller-supplied label for `kind === 'persistent'`. */
  label: string | null;
}

const inFlight = new Set<InFlightRequest>();
let evaluateTimer: number | null = null;
let bannerEl: HTMLElement | null = null;

/** HS-8425 — bookkeeping for an open banner-activation window. Created
 *  when `evaluate()` first flips the banner true; flushed to the
 *  freeze-log endpoint on the show→hide transition (in either
 *  `evaluate()` or `stopEvaluateTimerIfIdle()`). */
interface BannerActivation {
  firstShownAt: number;
  firstTriggerKind: 'http' | 'persistent';
  firstTriggerUrl: string | null;
  firstTriggerLabel: string | null;
  firstTriggerStartTs: number;
  peakInFlightCount: number;
  /** Distinct URL/label set encountered during the activation, capped at
   *  `URLS_SEEN_CAP` so a pathological burst can't grow the payload
   *  without bound. */
  urlsSeen: Set<string>;
  /** Max `now - startTs` observed across any in-flight item during the
   *  activation, in ms. Lets the freeze.log entry surface "longest
   *  single request" without us having to walk every URL's history. */
  longestInFlightMs: number;
}

const URLS_SEEN_CAP = 20;
let activation: BannerActivation | null = null;

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
  const now = Date.now();
  const banner = lookupBanner();
  const starts: number[] = [];
  for (const r of inFlight) starts.push(r.startTs);
  const show = shouldShowServerBusyChip(starts, now);
  setBannerVisible(show, now, banner);
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
  // HS-8425 — route through the same state machine evaluate() uses so
  // the show→hide transition flushes the activation entry to freeze.log.
  setBannerVisible(false, Date.now(), lookupBanner());
}

/** HS-8425 — central show/hide state machine. Both `evaluate()` (timer
 *  tick) and `stopEvaluateTimerIfIdle()` (last in-flight item drained)
 *  go through here so every show→hide transition flushes an activation
 *  entry exactly once.
 *
 *  HS-8446 — gated on the global `diagnosticsEnabled` flag. When off
 *  (the default), `show` is forced to `false` here at the last DOM-
 *  touching step so the underlying in-flight tracking + activation
 *  bookkeeping continues to run (so flipping the flag mid-session
 *  doesn't need a reload to take effect) but the banner element never
 *  paints and no `client-server-busy-banner` freeze-log entry fires. */
function setBannerVisible(show: boolean, now: number, banner: HTMLElement | null): void {
  if (show && !isDiagnosticsEnabled()) show = false;
  if (banner !== null) banner.style.display = show ? '' : 'none';
  const wasShown = activation !== null;
  if (show && !wasShown) {
    openActivation(now);
  } else if (show && wasShown && activation !== null) {
    recordInFlightIntoActivation(activation, now);
  } else if (!show && wasShown) {
    flushActivation(now);
  }
}

/** HS-8425 — capture the moment of show. The first trigger is the
 *  oldest in-flight item at this instant: by definition it's the one
 *  whose `startTs` first crossed the `now - startTs > threshold` line.
 *  (Tie-broken arbitrarily — Set iteration order is insertion order in
 *  modern JS, so the earlier-registered item wins.) */
function openActivation(now: number): void {
  let trigger: InFlightRequest | null = null;
  for (const r of inFlight) {
    if (trigger === null || r.startTs < trigger.startTs) trigger = r;
  }
  if (trigger === null) return; // defensive: show implies non-empty in-flight
  activation = {
    firstShownAt: now,
    firstTriggerKind: trigger.kind,
    firstTriggerUrl: trigger.url,
    firstTriggerLabel: trigger.label,
    firstTriggerStartTs: trigger.startTs,
    peakInFlightCount: 0,
    urlsSeen: new Set(),
    longestInFlightMs: 0,
  };
  recordInFlightIntoActivation(activation, now);
}

/** HS-8425 — sample current in-flight state into the activation. Called
 *  on every evaluate tick while the banner is up AND on add when
 *  activation is already open (so a request that joins and leaves
 *  inside one 250 ms tick window still gets captured). */
function recordInFlightIntoActivation(a: BannerActivation, now: number): void {
  if (inFlight.size > a.peakInFlightCount) a.peakInFlightCount = inFlight.size;
  for (const r of inFlight) {
    const age = now - r.startTs;
    if (age > a.longestInFlightMs) a.longestInFlightMs = age;
    if (a.urlsSeen.size < URLS_SEEN_CAP) {
      a.urlsSeen.add(formatInFlightForLog(r));
    }
  }
}

/** HS-8425 — collapse an in-flight item to a single log-friendly token.
 *  HTTP items use the URL path (query stripped — paths reveal which
 *  endpoint is slow without leaking auth params); persistent tokens use
 *  their caller-supplied label verbatim. */
function formatInFlightForLog(r: InFlightRequest): string {
  if (r.kind === 'http') {
    const u = r.url ?? '(unknown-url)';
    const q = u.indexOf('?');
    const path = q === -1 ? u : u.slice(0, q);
    return `http:${path}`;
  }
  return `persistent:${r.label ?? '(unknown-label)'}`;
}

/** HS-8425 — flush the activation to `/api/diagnostics/freeze`. Clears
 *  `activation` BEFORE the async post so a reentrant call (the
 *  diagnostics POST itself runs through `api()` → `trackServerRequest`,
 *  so it transiently re-enters this module) starts a brand new
 *  activation only if it itself crosses the threshold. */
function flushActivation(now: number): void {
  if (activation === null) return;
  const a = activation;
  activation = null;
  void postBannerActivation(a, now);
}

/** HS-8425 — fire-and-forget POST to the freeze-log endpoint. Mirrors
 *  the lazy-import pattern in `longTaskObserver.postFreezeLog` so the
 *  module-init path doesn't pay the `api.js` cost unless the banner
 *  actually fired. */
async function postBannerActivation(a: BannerActivation, now: number): Promise<void> {
  try {
    const { api } = await import('./api.js');
    const context = JSON.stringify({
      triggerKind: a.firstTriggerKind,
      triggerStartTs: a.firstTriggerStartTs,
      triggerUrl: a.firstTriggerUrl,
      triggerLabel: a.firstTriggerLabel,
      peakInFlightCount: a.peakInFlightCount,
      longestInFlightMs: Math.round(a.longestInFlightMs),
      urlsSeen: Array.from(a.urlsSeen),
    });
    await api('/diagnostics/freeze', {
      method: 'POST',
      body: {
        ts: new Date().toISOString(),
        source: 'client-server-busy-banner',
        durationMs: Math.max(0, Math.round(now - a.firstShownAt)),
        context,
      },
    });
  } catch { /* swallow — freeze.log is a diagnostic-only path */ }
}

/** HS-8425 — best-effort flush on page hide. `navigator.sendBeacon` is
 *  the only fetch primitive guaranteed to complete during unload; we
 *  also strip the activation state so a follow-up `setBannerVisible`
 *  on re-show doesn't double-post. Skipped under happy-dom / SSR. */
function flushActivationViaBeacon(now: number): void {
  if (activation === null) return;
  const a = activation;
  activation = null;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  const context = JSON.stringify({
    triggerKind: a.firstTriggerKind,
    triggerStartTs: a.firstTriggerStartTs,
    triggerUrl: a.firstTriggerUrl,
    triggerLabel: a.firstTriggerLabel,
    peakInFlightCount: a.peakInFlightCount,
    longestInFlightMs: Math.round(a.longestInFlightMs),
    urlsSeen: Array.from(a.urlsSeen),
  });
  const body = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'client-server-busy-banner',
    durationMs: Math.max(0, Math.round(now - a.firstShownAt)),
    context,
  });
  try {
    // sendBeacon doesn't carry the project secret header, but the
    // `/api/diagnostics/freeze` route is same-origin-friendly per its
    // existing middleware contract — no auth header needed for
    // same-origin browser POSTs.
    navigator.sendBeacon('/api/diagnostics/freeze', new Blob([body], { type: 'application/json' }));
  } catch { /* swallow */ }
}

let pagehideRegistered = false;
function registerPageHideFlushOnce(): void {
  if (pagehideRegistered) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('pagehide', () => {
    flushActivationViaBeacon(Date.now());
  });
  pagehideRegistered = true;
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
  const req: InFlightRequest = { startTs: Date.now(), kind: 'http', url, label: null };
  inFlight.add(req);
  startEvaluateTimer();
  registerPageHideFlushOnce();
  // HS-8425 — if the banner is already up, capture this URL now so a
  // request that joins-and-leaves inside a single 250 ms tick still
  // shows up in `urlsSeen`. The cheaper alternative (rely on the next
  // tick) would drop URLs entirely under fast burst patterns.
  if (activation !== null) recordInFlightIntoActivation(activation, Date.now());
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
export function trackPersistentSlowEvent(label: string = '(unlabeled)'): () => void {
  const req: InFlightRequest = {
    startTs: Date.now() - SERVER_BUSY_THRESHOLD_MS - 1,
    kind: 'persistent',
    url: null,
    // HS-8425 — caller-supplied label flows into the freeze-log
    // activation entry's `triggerLabel` so the user can grep
    // `freeze.log` for e.g. `terminal-stall:default` and find every
    // banner that was opened by that terminal.
    label,
  };
  inFlight.add(req);
  startEvaluateTimer();
  registerPageHideFlushOnce();
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
  activation = null;
  if (evaluateTimer !== null) {
    window.clearInterval(evaluateTimer);
    evaluateTimer = null;
  }
  const banner = lookupBanner();
  if (banner !== null) banner.style.display = 'none';
  bannerEl = null;
}

/** **TEST ONLY** — peek at the current activation. Returns null when
 *  the banner isn't currently up. Used by HS-8425 unit tests to assert
 *  the activation state machine without waiting for the async POST. */
export function _inspectActivationForTesting(): {
  firstShownAt: number;
  firstTriggerKind: 'http' | 'persistent';
  firstTriggerUrl: string | null;
  firstTriggerLabel: string | null;
  firstTriggerStartTs: number;
  peakInFlightCount: number;
  urlsSeen: string[];
  longestInFlightMs: number;
} | null {
  if (activation === null) return null;
  return {
    firstShownAt: activation.firstShownAt,
    firstTriggerKind: activation.firstTriggerKind,
    firstTriggerUrl: activation.firstTriggerUrl,
    firstTriggerLabel: activation.firstTriggerLabel,
    firstTriggerStartTs: activation.firstTriggerStartTs,
    peakInFlightCount: activation.peakInFlightCount,
    urlsSeen: Array.from(activation.urlsSeen),
    longestInFlightMs: activation.longestInFlightMs,
  };
}

/** **TEST ONLY** — peek at the current in-flight count. */
export function _inspectServerBusyForTesting(): { inFlightCount: number; chipVisible: boolean } {
  const banner = lookupBanner();
  return {
    inFlightCount: inFlight.size,
    chipVisible: banner !== null && banner.style.display !== 'none',
  };
}
