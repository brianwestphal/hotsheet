/**
 * HS-8054 — long-task instrumentation. The user reported "the UI hangs
 * for several seconds, usually when switching tabs but sometimes during
 * other interactions." Without a profile or repro it's hard to attribute
 * which synchronous block is responsible. This module:
 *
 *   1. Subscribes to `PerformanceObserver({ type: 'longtask' })` so any
 *      main-thread block ≥ 100 ms gets logged to the console with a
 *      clear `[hotsheet longtask]` prefix the user can grep / copy.
 *   2. **HS-8054 follow-up** — also runs a `setInterval`-based heartbeat
 *      that detects long tasks via "did this 50ms timer take much longer
 *      than 50ms to fire?" math. Catches the same hangs even when
 *      `PerformanceObserver({ type: 'longtask' })` is unsupported or
 *      silently dropping events (the user reported "still happens
 *      sometimes but i dont see any log messages" after the v1
 *      observer-only build, so this fallback is the v2 belt-and-braces).
 *   3. Maintains a small ring buffer of recent UI interactions
 *      (tab switch, project switch, activate-terminal, open-detail, etc)
 *      so each long-task log line includes the interactions that fired
 *      in the second or two before the block — pointing straight at the
 *      offending caller without requiring a DevTools profile.
 *   4. Surfaces a small toast on each detected long-task ≥ 500 ms so
 *      the user notices the instrumentation is working without having
 *      to keep DevTools open. Rate-limited to once per 10 s so a
 *      pathological loop doesn't carpet-bomb the UI.
 *   5. Exposes `window.__hotsheetGetLongTasks()` for bulk copy/paste.
 *
 * The heartbeat fallback runs in every browser (it's just `setInterval`),
 * so this module is no longer inert anywhere except happy-dom (which
 * doesn't run timers reliably under the test runner). The
 * `PerformanceObserver` path stays as the primary detector when
 * supported because it's free — no recurring timer overhead.
 */

const LONG_TASK_THRESHOLD_MS = 100;
const INTERACTION_BUFFER_SIZE = 30;
const LONG_TASK_BUFFER_SIZE = 50;
const INTERACTION_WINDOW_MS = 2000;
/** HS-8054 follow-up — heartbeat fires every N ms. Smaller = better
 *  resolution on short blocks, larger = lower constant-time overhead.
 *  50 ms is a reasonable trade — 20 ticks/sec is trivial, and any
 *  block ≥ 100 ms is detected with at most 50 ms of latency. */
const HEARTBEAT_INTERVAL_MS = 50;
/** Source-tagged so the user can tell if the v1 observer or v2
 *  heartbeat caught the hang — useful for debugging the instrumentation
 *  itself. */
type LongTaskSource = 'observer' | 'heartbeat';
/** HS-8054 follow-up — toasts on each detected long-task ≥ this many ms
 *  so the user sees the instrumentation working without DevTools open.
 *  Set above the buffer threshold so trivial 100–500 ms blocks don't
 *  carpet-bomb the UI on every interaction. */
const TOAST_THRESHOLD_MS = 500;
const TOAST_RATE_LIMIT_MS = 10_000;

interface InteractionEntry {
  ts: number; // performance.now()
  label: string;
}

interface LongTaskLog {
  ts: number; // performance.now() at observation
  wallClock: string; // formatted HH:MM:SS.mmm
  durationMs: number;
  source: LongTaskSource;
  recentInteractions: InteractionEntry[];
}

const interactionBuffer: InteractionEntry[] = [];
const longTaskBuffer: LongTaskLog[] = [];
let observer: PerformanceObserver | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatTs = 0;
let lastToastTs = 0;
let initialized = false;

/**
 * Record a UI interaction so the next long-task log can include it as
 * context. Cheap (single push + truncate); safe to call from hot
 * paths.
 *
 * `label` should be short and human-readable, e.g.:
 *   `'drawer-tab:terminal:default'`
 *   `'project-switch:Hot Sheet'`
 *   `'activate-terminal:claude'`
 *   `'open-detail:HS-1234'`
 *
 * The longtask observer correlates by timestamp — labels are free-form
 * strings, no enum.
 */
export function recordInteraction(label: string): void {
  interactionBuffer.push({ ts: performance.now(), label });
  if (interactionBuffer.length > INTERACTION_BUFFER_SIZE) {
    interactionBuffer.splice(0, interactionBuffer.length - INTERACTION_BUFFER_SIZE);
  }
}

/**
 * Start the PerformanceObserver + heartbeat detectors. Idempotent —
 * second + later calls are no-ops. Safe to call before / after DOM
 * ready.
 *
 * HS-8054 follow-up — heartbeat ALWAYS runs (no feature detection
 * needed; it's just `setInterval` + `performance.now()`). The
 * PerformanceObserver runs ONLY when the browser supports it. Both
 * record into the same buffer + console-log path.
 */
export function initLongTaskObserver(): void {
  if (initialized) return;
  initialized = true;

  // ── PerformanceObserver path (free when supported) ──
  let observerSupported = false;
  if (typeof PerformanceObserver !== 'undefined') {
    // PerformanceObserver.supportedEntryTypes is the canonical feature
    // detection — narrower than `try { observe(...) }` which can throw
    // synchronously OR fail silently depending on the browser.
    const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    const longtaskSupported = !Array.isArray(supported) || supported.includes('longtask');
    if (longtaskSupported) {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
            recordLongTask(entry.duration, 'observer');
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
        observerSupported = true;
      } catch {
        // Browser claimed to support it but threw on observe() — fall
        // through to the heartbeat-only path.
        observer = null;
      }
    }
  }

  // ── Heartbeat path (always-on belt-and-braces) ──
  // Detects "the timer SHOULD have fired N ms ago but didn't" — a
  // proxy for main-thread blocking that works in every browser. The
  // user reported v1 (observer-only) didn't surface anything for their
  // hangs, so this fallback is the second-line detector.
  if (typeof setInterval !== 'undefined' && typeof performance !== 'undefined') {
    lastHeartbeatTs = performance.now();
    heartbeatTimer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastHeartbeatTs;
      lastHeartbeatTs = now;
      // The interval should fire every HEARTBEAT_INTERVAL_MS. Anything
      // beyond that is the main thread blocking. Subtract the expected
      // interval so the reported duration is the BLOCK length, not
      // total elapsed (matches the PerformanceObserver semantics).
      const blockMs = elapsed - HEARTBEAT_INTERVAL_MS;
      if (blockMs >= LONG_TASK_THRESHOLD_MS) {
        recordLongTask(blockMs, 'heartbeat');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Expose retrieval helpers on window for the user to dump from
  // DevTools when they notice a hang.
  const w = window as unknown as Record<string, unknown>;
  w.__hotsheetGetLongTasks = (): LongTaskLog[] => longTaskBuffer.slice();
  w.__hotsheetClearLongTasks = (): void => { longTaskBuffer.length = 0; };
  w.__hotsheetGetInteractions = (): InteractionEntry[] => interactionBuffer.slice();

  // HS-8054 follow-up — print a startup line so the user can verify
  // the instrumentation is wired (the v1 build had no startup log;
  // when the user reported "no log messages" we couldn't tell whether
  // the observer was actually wired or not). Uses console.error so the
  // line stands out against console.log noise during page init.
  // eslint-disable-next-line no-console
  console.error(`[hotsheet longtask] init — observer:${observerSupported ? 'on' : 'off'} heartbeat:${heartbeatTimer !== null ? 'on' : 'off'} threshold:${LONG_TASK_THRESHOLD_MS}ms`);
}

function recordLongTask(durationMs: number, source: LongTaskSource): void {
  const ts = performance.now();
  const wallClock = formatWallClock(new Date());
  // Pick interactions that fired in the window leading up to (and a
  // little after — sometimes the long task starts before the
  // interaction handler logs) the long task. Long tasks are reported
  // AFTER they finish, so the recorded `ts` is the END; the caller
  // that triggered the work fired before that.
  const cutoffStart = ts - durationMs - INTERACTION_WINDOW_MS;
  const cutoffEnd = ts;
  const recentInteractions = interactionBuffer
    .filter(i => i.ts >= cutoffStart && i.ts <= cutoffEnd)
    .map(i => ({ ts: i.ts, label: i.label }));

  const log: LongTaskLog = { ts, wallClock, durationMs, source, recentInteractions };
  longTaskBuffer.push(log);
  if (longTaskBuffer.length > LONG_TASK_BUFFER_SIZE) {
    longTaskBuffer.splice(0, longTaskBuffer.length - LONG_TASK_BUFFER_SIZE);
  }

  // Single-line console output the user can copy/paste verbatim.
  // Shape: `[hotsheet longtask] 10:34:56.789 — 723ms [observer] (recent: foo @-50ms, bar @-180ms)`
  // HS-8054 follow-up — `console.error` instead of `console.warn` so
  // the line stands out against console-log noise; tagged with the
  // `[source]` so users can tell which detector caught the hang.
  const interactionStr = recentInteractions.length === 0
    ? 'no recent interactions'
    : recentInteractions
        .map(i => `${i.label} @${formatRelativeMs(i.ts - ts)}`)
        .join(', ');
  // eslint-disable-next-line no-console
  console.error(`[hotsheet longtask] ${wallClock} — ${durationMs.toFixed(0)}ms [${source}] (recent: ${interactionStr})`);

  // HS-8054 follow-up — toast on each ≥ 500 ms block so the user notices
  // the instrumentation working without DevTools. Rate-limited to once
  // per 10 s.
  if (durationMs >= TOAST_THRESHOLD_MS && (ts - lastToastTs) >= TOAST_RATE_LIMIT_MS) {
    lastToastTs = ts;
    void showLongTaskToast(durationMs, source, recentInteractions);
  }
}

/** HS-8054 follow-up — load the toast helper lazily so the heartbeat
 *  initialisation doesn't pay the import cost on app boot (toast.ts
 *  drags some DOM utilities). */
async function showLongTaskToast(
  durationMs: number,
  source: LongTaskSource,
  recentInteractions: InteractionEntry[],
): Promise<void> {
  try {
    const { showToast } = await import('./toast.js');
    const summary = recentInteractions.length === 0
      ? `${durationMs.toFixed(0)}ms UI hang [${source}]`
      : `${durationMs.toFixed(0)}ms UI hang during ${recentInteractions[recentInteractions.length - 1].label} [${source}]`;
    showToast(summary, { variant: 'warning' });
  } catch { /* swallow — diagnostic-only path */ }
}

function formatWallClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatRelativeMs(deltaMs: number): string {
  // Negative = past. Format as `-Nms` or `+Nms`.
  const sign = deltaMs < 0 ? '-' : '+';
  return `${sign}${Math.abs(deltaMs).toFixed(0)}ms`;
}

/** Test-only: drop all internal state so tests don't bleed across runs. */
export function _resetLongTaskObserverForTesting(): void {
  observer?.disconnect();
  observer = null;
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  initialized = false;
  interactionBuffer.length = 0;
  longTaskBuffer.length = 0;
  lastToastTs = 0;
  lastHeartbeatTs = 0;
}

/** Test-only: peek at the in-memory buffers without going through window globals. */
export function _getLongTaskBufferForTesting(): LongTaskLog[] {
  return longTaskBuffer.slice();
}

/** Test-only: peek at the interaction buffer. */
export function _getInteractionBufferForTesting(): InteractionEntry[] {
  return interactionBuffer.slice();
}

/** Test-only: synthesise a long-task observation. The real
 *  `PerformanceObserver` callback is hard to fire in JSDOM/happy-dom
 *  because the browser only fires it from the rendering pipeline. This
 *  helper exercises the same recording path so the formatting +
 *  interaction-window logic gets coverage. */
export function _recordLongTaskForTesting(durationMs: number, source: LongTaskSource = 'observer'): void {
  recordLongTask(durationMs, source);
}
