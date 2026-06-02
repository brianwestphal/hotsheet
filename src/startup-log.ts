/**
 * HS-8704 (option A — self-diagnosing launch): persist the startup timeline to
 * `~/.hotsheet/startup.log` so a hang is diagnosable even when there is no
 * terminal to print to.
 *
 * The installed beta app got stuck forever on the "Starting Hot Sheet…" splash.
 * The user could reproduce it ONLY via a GUI launch (`open -a 'Hot Sheet'` /
 * Dock / Spotlight) — running the binary straight from a terminal worked. The
 * difference is the controlling terminal: a GUI launch gives the process none,
 * so every `console.error` phase marker the sidecar already emitted went to a
 * pipe nobody was reading ("but no logs are shown"). The Node sidecar's stderr
 * is captured by the Tauri shell as a pipe (never a TTY) and re-emitted with
 * `eprintln!`, which on a GUI launch also vanishes — so there was no record at
 * all of WHERE startup stalled.
 *
 * This module mirrors each phase marker to BOTH stderr (so terminal launches +
 * the live sidecar-stderr reader keep working unchanged) AND an append-only
 * on-disk log. The Tauri Rust shell (`src-tauri/src/lib.rs::startup_log`)
 * appends its own milestone lines to the SAME file, so the two processes
 * interleave by timestamp into one launch timeline.
 *
 * Everything here is best-effort: any filesystem error silently disables file
 * logging (`logPath` stays null) so diagnostics can never themselves break
 * startup.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** Cap the persisted log so it can't grow without bound across launches. When
 *  the existing file exceeds this on init, it is truncated before the new
 *  session header is written. ~1 MB is many dozens of launches' worth. */
const MAX_LOG_BYTES = 1_000_000;

let logPath: string | null = null;
let startMs = 0;
let currentPhase = 'init';

/** Path to the persisted startup log. Honors the `HOTSHEET_STARTUP_LOG`
 *  override env var (full path) — handy for support escalations and for
 *  tests; defaults to `~/.hotsheet/startup.log`. */
export function getStartupLogPath(): string {
  const override = process.env.HOTSHEET_STARTUP_LOG;
  if (typeof override === 'string' && override !== '') return override;
  return join(homedir(), '.hotsheet', 'startup.log');
}

/** The phase the most recent `startupMark` recorded — read by the watchdog
 *  when it fires so it can name exactly where startup stalled. */
export function getCurrentPhase(): string {
  return currentPhase;
}

/** Milliseconds since `initStartupLog`. */
export function getElapsedMs(now: () => number = Date.now): number {
  return now() - startMs;
}

/** Best-effort append of a single line. Never throws — diagnostics must not be
 *  able to break startup. No-op until `initStartupLog` has resolved a path. */
function appendLine(line: string): void {
  if (logPath === null) return;
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* best-effort diagnostics only */
  }
}

/**
 * Open a fresh startup-log session. Ensures the parent dir exists, bounds the
 * file size, and writes a header capturing the exact launch context (argv,
 * cwd, and crucially whether a TTY is attached). Safe to call once at the top
 * of `main()`. On any filesystem error, file logging silently disables and
 * startup proceeds unaffected.
 */
export function initStartupLog(now: () => number = Date.now): void {
  startMs = now();
  currentPhase = 'init';
  try {
    const path = getStartupLogPath();
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > MAX_LOG_BYTES) truncateSync(path, 0);
    } catch {
      /* no existing file — nothing to bound */
    }
    logPath = path;
  } catch {
    logPath = null;
    return;
  }
  const ttyNote = process.stderr.isTTY
    ? 'yes (terminal launch)'
    : 'no (GUI launch — this file is the only record)';
  appendLine('');
  appendLine(`==== Hot Sheet startup ${new Date(startMs).toISOString()} pid=${process.pid} platform=${process.platform} node=${process.version} ====`);
  appendLine(`  argv: ${JSON.stringify(process.argv.slice(1))}`);
  appendLine(`  cwd:  ${process.cwd()}`);
  // A GUI launch (Dock / Spotlight / Finder) has no controlling terminal — the
  // exact case (HS-8704) where this file is the ONLY record of what happened.
  appendLine(`  tty:  ${ttyNote}`);
}

/**
 * Record a phase transition. Updates the current-phase tracker (read by the
 * watchdog) and mirrors the marker to BOTH stderr — so terminal launches and
 * the live Tauri sidecar-stderr reader still see it — and the on-disk log, so
 * GUI launches have a durable record.
 */
export function startupMark(phase: string, now: () => number = Date.now): void {
  currentPhase = phase;
  const elapsed = now() - startMs;
  console.error(`[startup +${elapsed}ms] ${phase}`);
  appendLine(`${new Date(now()).toISOString()} [+${elapsed}ms] ${phase}`);
}

/**
 * Write an arbitrary diagnostic line (not a phase transition) to both stderr
 * and the log. Used by the watchdog and the top-level fatal-error handler.
 */
export function startupLog(msg: string, now: () => number = Date.now): void {
  console.error(msg);
  appendLine(`${new Date(now()).toISOString()} ${msg}`);
}

export interface StartupWatchdogHooks<H = unknown> {
  getElapsedMs: () => number;
  getCurrentPhase: () => string;
  log: (msg: string) => void;
  schedule: (fn: () => void, ms: number) => H;
  cancel: (handle: H) => void;
}

/**
 * Escalating startup watchdog. Fires at 10s, 20s, 30s, then every 30s
 * thereafter — each time naming the phase startup is currently stuck in.
 *
 * Pre-fix (HS-8704) the watchdog was a single 10s one-shot that only said
 * "startup has taken … — still not ready" with no phase, and on a GUI launch
 * even that line was invisible. Now it keeps stamping the (durable) log so a
 * truly wedged launch leaves an unambiguous trail pointing at the stuck phase.
 *
 * Pure factory — timers and clock are injected so the escalation contract is
 * unit-testable without real time (mirrors `createSignalHandler` in cli.ts).
 */
export function createStartupWatchdog<H>(hooks: StartupWatchdogHooks<H>): { start: () => void; stop: () => void } {
  const THRESHOLDS_MS = [10_000, 20_000, 30_000];
  const REPEAT_MS = 30_000;
  let fires = 0;
  let handle: H | null = null;

  const fire = (): void => {
    fires += 1;
    const phase = hooks.getCurrentPhase();
    const elapsed = hooks.getElapsedMs();
    const severity = fires >= THRESHOLDS_MS.length ? 'STILL HANGING' : 'WARNING';
    hooks.log(`[startup] ${severity}: not ready after ${elapsed}ms — stuck in phase "${phase}"`);
    if (fires === 1) {
      hooks.log('[startup] The phase named above is where startup stalled. Usual suspects: PGLite DB init / snapshot-restore, the login-shell PATH probe, the npm update check, or project restore.');
      hooks.log('[startup] Full timeline is being written to the startup log for diagnosis.');
    }
    const nextDelay = fires < THRESHOLDS_MS.length
      ? THRESHOLDS_MS[fires] - THRESHOLDS_MS[fires - 1]
      : REPEAT_MS;
    handle = hooks.schedule(fire, nextDelay);
  };

  return {
    start(): void {
      handle = hooks.schedule(fire, THRESHOLDS_MS[0]);
    },
    stop(): void {
      if (handle !== null) {
        hooks.cancel(handle);
        handle = null;
      }
    },
  };
}
