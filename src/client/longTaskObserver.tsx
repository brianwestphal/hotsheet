/**
 * HS-8054 — long-task instrumentation. The user reported "the UI hangs
 * for several seconds, usually when switching tabs but sometimes during
 * other interactions." Without a profile or repro it's hard to attribute
 * which synchronous block is responsible. This module:
 *
 *   1. Subscribes to `PerformanceObserver({ type: 'longtask' })` so any
 *      main-thread block ≥ 100 ms gets logged to the console with a
 *      clear `[hotsheet longtask]` prefix the user can grep / copy.
 *   2. Maintains a small ring buffer of recent UI interactions
 *      (tab switch, project switch, activate-terminal, open-detail, etc)
 *      so each long-task log line includes the interactions that fired
 *      in the second or two before the block — pointing straight at the
 *      offending caller without requiring a DevTools profile.
 *   3. Exposes `window.__hotsheetGetLongTasks()` for bulk copy/paste.
 *
 * Inert when `PerformanceObserver` or the `longtask` entry type is
 * unavailable (Safari before 15.4 / older WKWebView, happy-dom). All
 * exports are no-op-safe so callers don't need to feature-detect.
 */

const LONG_TASK_THRESHOLD_MS = 100;
const INTERACTION_BUFFER_SIZE = 30;
const LONG_TASK_BUFFER_SIZE = 50;
const INTERACTION_WINDOW_MS = 2000;

interface InteractionEntry {
  ts: number; // performance.now()
  label: string;
}

interface LongTaskLog {
  ts: number; // performance.now() at observation
  wallClock: string; // formatted HH:MM:SS.mmm
  durationMs: number;
  recentInteractions: InteractionEntry[];
}

const interactionBuffer: InteractionEntry[] = [];
const longTaskBuffer: LongTaskLog[] = [];
let observer: PerformanceObserver | null = null;
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
 * Start the PerformanceObserver. Idempotent — second + later calls
 * are no-ops. Safe to call before / after DOM ready. Inert when the
 * `longtask` entry type isn't supported.
 */
export function initLongTaskObserver(): void {
  if (initialized) return;
  initialized = true;
  if (typeof PerformanceObserver === 'undefined') return;
  // PerformanceObserver.supportedEntryTypes is the canonical feature
  // detection — narrower than `try { observe(...) }` which can throw
  // synchronously OR fail silently depending on the browser.
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
  if (Array.isArray(supported) && !supported.includes('longtask')) return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
        recordLongTask(entry.duration);
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // Browser claimed to support it but threw on observe() — bail.
    observer = null;
  }
  // Expose retrieval helpers on window for the user to dump from
  // DevTools when they notice a hang.
  const w = window as unknown as Record<string, unknown>;
  w.__hotsheetGetLongTasks = (): LongTaskLog[] => longTaskBuffer.slice();
  w.__hotsheetClearLongTasks = (): void => { longTaskBuffer.length = 0; };
  w.__hotsheetGetInteractions = (): InteractionEntry[] => interactionBuffer.slice();
}

function recordLongTask(durationMs: number): void {
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

  const log: LongTaskLog = { ts, wallClock, durationMs, recentInteractions };
  longTaskBuffer.push(log);
  if (longTaskBuffer.length > LONG_TASK_BUFFER_SIZE) {
    longTaskBuffer.splice(0, longTaskBuffer.length - LONG_TASK_BUFFER_SIZE);
  }

  // Single-line console output the user can copy/paste verbatim.
  // Shape: `[hotsheet longtask] 10:34:56.789 — 723ms (recent: foo @-50ms, bar @-180ms)`
  const interactionStr = recentInteractions.length === 0
    ? 'no recent interactions'
    : recentInteractions
        .map(i => `${i.label} @${formatRelativeMs(i.ts - ts)}`)
        .join(', ');
  console.warn(`[hotsheet longtask] ${wallClock} — ${durationMs.toFixed(0)}ms (recent: ${interactionStr})`);
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
  initialized = false;
  interactionBuffer.length = 0;
  longTaskBuffer.length = 0;
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
export function _recordLongTaskForTesting(durationMs: number): void {
  recordLongTask(durationMs);
}
