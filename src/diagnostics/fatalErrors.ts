/**
 * HS-9557 — record WHY the server process died.
 *
 * ## The blackout this closes
 *
 * On 2026-08-03 the server exited at 10:07:54Z and the Tauri window sat against
 * a dead `localhost:4174` for 49 minutes. Afterwards there was no artifact
 * anywhere on the machine saying what happened: no watchdog FATAL (the watchdog
 * only fires on a *wedge*, and this was an *exit*), no macOS `.ips` crash
 * report, no JetsamEvent. `~/.hotsheet/diagnostics/freeze.log` simply stopped
 * mid-stream. The cause is permanently unrecoverable — see HS-9561.
 *
 * The reason nothing was recorded is that a fatal JS fault reports itself on
 * **stderr**, and the dev Tauri wrapper spawns the server with
 * `Stdio::inherit()` into a GUI process that has no controlling terminal. The
 * startup log already knows this — its own header stamps the launch as having
 * no tty, calling the file "the only record" — but nothing was routing fatals
 * to it. `startup-log.ts::startupLog`'s doc comment even advertised "used by
 * the watchdog and the top-level fatal-error handler". There was no such
 * handler.
 *
 * This module is that handler. The Rust half (capturing the child's stderr) is
 * the other half of HS-9557 and catches what a JS handler structurally cannot:
 * a V8/WASM OOM abort or a native crash, which never reach JS at all.
 *
 * ## Why these handlers do not change what the process does
 *
 * Installing a listener for either event SUPPRESSES Node's default, so each
 * handler must reproduce it or this module would silently convert a crash into
 * a process limping on in an unknown state — strictly worse than the blackout
 * it replaces. Both therefore log and then `exit(1)`:
 *
 * - `uncaughtException` — Node's default is print-and-exit(1).
 * - `unhandledRejection` — Node's default mode since v15 is `throw`, which
 *   raises it as an `uncaughtException` *only when no `unhandledRejection`
 *   listener exists*. Adding one here takes ownership of that path, so it has
 *   to exit too.
 *
 * `process.exit(1)` still runs the registered `'exit'` handlers, so the lock
 * release (`lock.ts`) and instance cleanup (`cli.ts`) happen exactly as they
 * did before this module existed.
 */
import { getCurrentPhase, getElapsedMs, startupLog } from '../startup-log.js';
import { pushAll } from '../utils/largeArray.js';

const BYTES_PER_MB = 1024 * 1024;

/** The two fatal events this module owns. */
export type FatalKind = 'uncaughtException' | 'unhandledRejection';

/**
 * HS-9572 — a data-critical section: a stretch of code where dying costs the
 * user data that is not recoverable by restarting.
 *
 * On 2026-08-04 a corrupt-open recovery had renamed a project's `db/` aside and
 * was about to restore it from the snapshot when a stray `ErrnoError` rejected
 * with nothing attached to it. The process died in that gap. The next start
 * found no `db/`, created a fresh empty cluster, and the project came up with
 * zero tickets — no corruption left to detect, so nothing announced itself.
 *
 * A rejection nobody awaited is a bug worth fixing wherever it comes from, but
 * it must not be able to kill the process *during the seconds when the user's
 * data exists only as a directory we just renamed*. Inside a critical section an
 * `unhandledRejection` is logged and absorbed instead of exiting.
 *
 * Deliberately scoped to `unhandledRejection` only. An `uncaughtException` is a
 * synchronous throw that escaped every frame, so the process state is genuinely
 * unknown and continuing is the more dangerous choice; a rejection from a
 * half-closed WASM instance is not the same thing.
 *
 * Note the listener registration below is what suppresses **Node's own**
 * default. Since v15 an unhandled rejection is fatal unless a listener exists —
 * and in the 2026-08-04 process none did, because it predated this module.
 */
let criticalDepth = 0;
let absorbedInSection: string[] = [];
let absorbListener: ((reason: unknown) => void) | null = null;

/** Process seam, so tests can drive the listener wiring without arming a real
 *  handler on the vitest process. */
interface CriticalSectionHooks {
  on: (e: 'unhandledRejection', h: (r: unknown) => void) => void;
  off: (e: 'unhandledRejection', h: (r: unknown) => void) => void;
  log: (msg: string) => void;
}

let processHooks: CriticalSectionHooks = {
  on: (e, h) => { process.on(e, h); },
  off: (e, h) => { process.off(e, h); },
  // Deliberately `startupLog` rather than the `installFatalErrorHandlers` hook:
  // a section can be entered before — or entirely without — those handlers, and
  // that is the case the 2026-08-04 process was actually in.
  log: startupLog,
};

export function inDataCriticalSection(): boolean {
  return criticalDepth > 0;
}

/**
 * Enter a data-critical section. Returns the release function — call it in a
 * `finally`, matching the `pinClustersForDirs` idiom.
 *
 * Nestable: only the outermost entry arms and disarms the listener, so an inner
 * section can't disarm the protection its caller is relying on.
 */
export function beginDataCriticalSection(label: string): () => void {
  criticalDepth += 1;
  if (criticalDepth === 1) {
    absorbedInSection = [];
    absorbListener = (reason: unknown) => {
      // The report itself is written by `report()` when the handlers are
      // installed. This listener exists so Node's default doesn't fire when
      // they are NOT — which is exactly the case the incident hit.
      absorbedInSection.push(describeUnknown(reason));
    };
    processHooks.on('unhandledRejection', absorbListener);
  }
  let released = false;
  return () => {
    if (released) return; // double-release must not drop an outer section's hold
    released = true;
    criticalDepth -= 1;
    if (criticalDepth > 0) return;
    if (absorbListener !== null) {
      processHooks.off('unhandledRejection', absorbListener);
      absorbListener = null;
    }
    if (absorbedInSection.length > 0) {
      processHooks.log(
        `[fatal] absorbed ${String(absorbedInSection.length)} unhandled rejection(s) during the data-critical section "${label}" `
        + `so it could finish (HS-9572). These are real bugs — the section completing is not a reason to stop chasing them: `
        + absorbedInSection.join(' | ')
      );
      absorbedInSection = [];
    }
  };
}

/** Test seam for the listener wiring + depth, so a leaked section in one case
 *  can't silently disarm the next. */
export function _resetDataCriticalSectionForTests(hooks?: Partial<CriticalSectionHooks>): void {
  if (absorbListener !== null) processHooks.off('unhandledRejection', absorbListener);
  criticalDepth = 0;
  absorbedInSection = [];
  absorbListener = null;
  if (hooks) processHooks = { ...processHooks, ...hooks };
}

/** Injected seams, so the report contents and the exit contract are testable
 *  without actually killing the test runner. */
export interface FatalErrorHooks {
  log: (msg: string) => void;
  exit: (code: number) => void;
  on: (event: FatalKind, handler: (value: unknown) => void) => void;
  memory: () => NodeJS.MemoryUsage;
  phase: () => string;
  elapsedMs: () => number;
}

/**
 * Render the fatal report. Pure, so the exact shape a post-mortem reader will
 * find in `startup.log` is pinned by tests rather than discovered during the
 * next outage.
 *
 * A thrown value is NOT necessarily an `Error` — `throw 'boom'` and rejecting
 * with a plain object are both legal and both showed up as plausible causes
 * while diagnosing HS-9561, so the formatter never assumes `.stack` exists.
 */
export function formatFatalReport(
  kind: FatalKind,
  value: unknown,
  ctx: { phase: string; elapsedMs: number; memory: NodeJS.MemoryUsage },
): string[] {
  const mb = (n: number): number => Math.round(n / BYTES_PER_MB);
  const lines = [
    `[fatal] ${kind}: the server is exiting. This line exists because a GUI launch has no terminal `
      + 'to print to (HS-9557); before it, a fatal exit left no record anywhere.',
    `[fatal] phase="${ctx.phase}" uptime=${String(ctx.elapsedMs)}ms`,
  ];

  if (value instanceof Error) {
    lines.push(`[fatal] ${value.name}: ${value.message}`);
    // `stack` already repeats name+message on its first line; keep both anyway —
    // a truncated log is likelier than a redundant one.
    if (typeof value.stack === 'string' && value.stack !== '') {
      pushAll(lines, value.stack.split('\n').map((l) => `[fatal]   ${l}`));
    }
    // An AggregateError / a rethrow chain hides the real culprit in `cause`.
    const cause: unknown = (value as { cause?: unknown }).cause;
    if (cause !== undefined) lines.push(`[fatal] caused by: ${describeUnknown(cause)}`);
  } else {
    lines.push(`[fatal] non-Error value thrown: ${describeUnknown(value)}`);
  }

  const m = ctx.memory;
  // `external` is the field that matters and the one nobody looks at — it is
  // where PGLite's WASM heaps live and it does NOT appear in rss (docs/128).
  lines.push(
    `[fatal] memory: rss=${String(mb(m.rss))}MB heapUsed=${String(mb(m.heapUsed))}MB `
      + `external=${String(mb(m.external))}MB arrayBuffers=${String(mb(m.arrayBuffers))}MB`,
  );
  return lines;
}

/** Best-effort one-line description of an arbitrary thrown value. */
function describeUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  // `JSON.stringify` genuinely returns `undefined` — not a string — for these
  // three, despite its lib signature promising `string`. Screening them out here
  // is what lets the call below be used directly as a string.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Circular, getter-throwing, or BigInt-bearing values must not turn the
    // fatal handler into a second fatal.
    return Object.prototype.toString.call(value);
  }
}

let installed = false;

/**
 * Install the handlers. Idempotent — a second call is a no-op, mirroring
 * `startEventLoopWatchdog`.
 *
 * Call this as early in `main()` as the startup log allows: it can only report
 * faults that happen after it is installed, and startup is the most fault-prone
 * window.
 */
export function installFatalErrorHandlers(overrides: Partial<FatalErrorHooks> = {}): void {
  if (installed) return;
  installed = true;

  const hooks: FatalErrorHooks = {
    log: startupLog,
    exit: (code) => process.exit(code),
    on: (event, handler) => { process.on(event, handler); },
    memory: () => process.memoryUsage(),
    phase: getCurrentPhase,
    elapsedMs: () => getElapsedMs(),
    ...overrides,
  };

  const report = (kind: FatalKind, value: unknown): void => {
    // Re-entrancy + self-failure guard. If reporting throws (a full disk, a
    // getter that throws), the process must still die the way it would have
    // without this module — never hang holding the port and the project locks.
    try {
      for (const line of formatFatalReport(kind, value, {
        phase: hooks.phase(),
        elapsedMs: hooks.elapsedMs(),
        memory: hooks.memory(),
      })) hooks.log(line);
    } catch {
      /* diagnostics must never outrank the exit */
    }
    // HS-9572 — inside a data-critical section a stray rejection is absorbed:
    // dying here costs the user data that no restart can bring back. The report
    // above is still written, so the bug stays visible.
    if (kind === 'unhandledRejection' && inDataCriticalSection()) {
      try {
        hooks.log('[fatal] ...but a data-critical section is in progress, so the process is NOT exiting (HS-9572).');
      } catch { /* as above */ }
      return;
    }
    hooks.exit(1);
  };

  hooks.on('uncaughtException', (err) => { report('uncaughtException', err); });
  hooks.on('unhandledRejection', (reason) => { report('unhandledRejection', reason); });
}

/** Test seam — allow a fresh install in the next test. */
export function _resetFatalErrorHandlersForTests(): void {
  installed = false;
}
