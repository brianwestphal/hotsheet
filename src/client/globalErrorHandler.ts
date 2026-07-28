/**
 * HS-9455 (the "recover" half of HS-9451) — surface client-side crashes.
 *
 * Until now there was no `window.onerror` and no `unhandledrejection` listener
 * anywhere in the client. An exception thrown inside an event handler, a render, or
 * a floating promise therefore went to the devtools console and nowhere else: the UI
 * simply stopped doing the thing you asked, with no indication why. That is the
 * hardest failure to report — the user has nothing to tell you beyond "it didn't
 * work" — and it's the shape HS-9451 would have taken had the stack overflow been on
 * the client instead of the server.
 *
 * Deliberately modest. This REPORTS; it does not try to recover, because a generic
 * handler cannot know what state was left half-applied. Its value is turning silence
 * into a message that names the error and where it came from.
 *
 * Three things it has to get right, all of which are easy to get wrong:
 *
 *  1. **It must not loop.** If rendering the popup itself throws, that throw arrives
 *     back here. A re-entrancy flag makes the second one a console-only report.
 *  2. **A storm must not become a popup storm.** A runaway interval throwing every
 *     tick would otherwise rebuild the overlay endlessly. After the first report we
 *     go quiet for a cool-off window and count what was suppressed.
 *  3. **It must not fight the shutdown path.** `showErrorPopup` already suppresses
 *     while shutting down (HS-9029); everything routes through it so that holds.
 */
import { showErrorPopup } from './api.js';

/** Quiet window after a report. Long enough that a runaway loop produces one popup,
 *  short enough that a genuinely separate failure minutes later still surfaces. */
const COOLDOWN_MS = 10_000;

let installed = false;
/** Guards against an error raised while we are reporting an error. */
let reporting = false;
let lastReportAt = 0;
let suppressedSinceLastReport = 0;

/** Test seam — reset the module's rate-limit state. */
export function _resetGlobalErrorHandlerForTesting(): void {
  installed = false;
  reporting = false;
  lastReportAt = 0;
  suppressedSinceLastReport = 0;
}

/** Pure: what the popup should say for a caught value. Exported for testing. */
export function describeClientError(err: unknown, source: 'error' | 'unhandledrejection'): string {
  const base = err instanceof Error
    ? (err.message === '' ? err.name : `${err.name}: ${err.message}`)
    : `Unexpected value thrown: ${String(err)}`;
  return source === 'unhandledrejection' ? `${base} (unhandled promise rejection)` : base;
}

/** `file.ts:12:34` from an ErrorEvent, or null when the browser didn't say. */
export function formatErrorLocation(filename: unknown, lineno: unknown, colno: unknown): string | null {
  if (typeof filename !== 'string' || filename === '') return null;
  const file = filename.slice(filename.lastIndexOf('/') + 1);
  const line = typeof lineno === 'number' && lineno > 0 ? `:${String(lineno)}` : '';
  const col = typeof colno === 'number' && colno > 0 ? `:${String(colno)}` : '';
  return `${file}${line}${col}`;
}

function report(err: unknown, source: 'error' | 'unhandledrejection', location: string | null, now: number): void {
  if (reporting) { console.error('[client error while reporting a client error]', err); return; }
  if (now - lastReportAt < COOLDOWN_MS) {
    suppressedSinceLastReport += 1;
    console.error(`[client error, suppressed ×${String(suppressedSinceLastReport)}]`, err);
    return;
  }
  const alsoSuppressed = suppressedSinceLastReport;
  lastReportAt = now;
  suppressedSinceLastReport = 0;
  reporting = true;
  try {
    console.error('[client error]', err);
    const context = [location, alsoSuppressed > 0 ? `+${String(alsoSuppressed)} more suppressed` : null]
      .filter((x): x is string => x !== null)
      .join(' · ');
    showErrorPopup(describeClientError(err, source), {
      title: 'Something went wrong',
      context: context === '' ? undefined : context,
    });
  } catch (e) {
    console.error('[client error handler failed]', e);
  } finally {
    reporting = false;
  }
}

/**
 * Install the listeners. Idempotent — a second call is a no-op and returns a disposer
 * that does nothing, so a double-install can't detach the live one.
 *
 * Returns a disposer because these are page-lifetime in the app but NOT in tests: an
 * `addEventListener` with no way to remove it meant every test that installed left a
 * live handler on `window`, and the next test's single thrown error was counted by
 * all of them. (Found by this module's own rate-limit test reporting 74 suppressed
 * errors where 24 were raised.)
 */
export function installGlobalErrorHandler(now: () => number = () => Date.now()): () => void {
  if (installed) return () => { /* not ours to remove */ };
  installed = true;
  const onError = (e: ErrorEvent): void => {
    // A failed <img>/<script> load also fires `error`, but on the ELEMENT, and it
    // has no `error` property. Those are not app crashes — ignore them.
    if (e.target !== window && e.target !== null && !(e.target instanceof Window)) return;
    report(e.error ?? e.message, 'error', formatErrorLocation(e.filename, e.lineno, e.colno), now());
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    report(e.reason, 'unhandledrejection', null, now());
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}
