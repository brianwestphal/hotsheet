// HS-9519 — name what is blocking the loop before the watchdog SIGKILLs.
//
// `~/.hotsheet/startup.log` records 16 watchdog FATALs and not one names the call
// that blocked. `freeze.log` cannot fill the gap by construction: its instrumentation
// is a main-loop `setInterval` and a `finally` hook, so it records nothing while the
// loop is pinned. Every wedge has therefore cost a full investigation and still ended
// at "leading suspect" — HS-9518 removed candidates rather than a confirmed cause.
//
// The watchdog worker is on its own OS thread and still running while the main thread
// is pinned. It is the one place that can observe the wedge *as it happens*, so it
// captures a native stack immediately before killing.
//
// This module is the pure half: it decides WHAT to run. The worker executes it inline,
// because the worker source is an eval string and cannot import anything.

import { join } from 'path';

/**
 * HS-9554 — the token the WORKER replaces with the capture timestamp.
 *
 * This command is built once, at watchdog start, so it cannot know when a wedge
 * will happen. It used to bake `Date.now()` into the filename anyway, which meant
 * the name recorded when the *server booted*: the 2026-08-01 wedge produced
 * `watchdog-stack-2026-07-31T04-29-43-055Z.txt`, 26 hours off, and — worse — every
 * wedge in one process wrote to that same path, so only the last capture survived.
 * The worker substitutes this at capture time instead.
 */
export const CAPTURED_AT_PLACEHOLDER = '__CAPTURED_AT__';

/** A bounded external command that writes a stack dump for `pid` to a file.
 *  `outPath` contains `CAPTURED_AT_PLACEHOLDER`; the worker resolves it. */
export interface StackCaptureCommand {
  command: string;
  args: string[];
  /** Where the dump lands, so the FATAL line can point at it. */
  outPath: string;
  /** Hard bound. The process is already wedged, but the capture must never be the
   *  reason the SIGKILL is delayed indefinitely (HS-9510: timeout AND SIGKILL). */
  timeoutMs: number;
}

/** Seconds of sampling. Two is enough to show a stack that is not moving — which is
 *  exactly the case here — without adding meaningfully to the delay before SIGKILL. */
const SAMPLE_SECONDS = 2;
/** Generous vs `SAMPLE_SECONDS` so a slow spawn isn't cut off, small enough that a
 *  hung sampler can't hold up the kill. */
const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Build the stack-capture command for this platform, or null when we have no
 * known-good way to read a wedged process.
 *
 * **macOS `sample`** is deliberately first: it is the technique that finally placed
 * the HS-9391 `execFileSync` hang on this machine, and — the property that matters —
 * it reads NATIVE frames. The wedges seen here block inside
 * `SyncProcessRunner::Spawn` / `uv_run` / PGLite WASM, where a JS-level stack shows
 * nothing useful, so a JS-only capture would have answered none of the 16 FATALs.
 *
 * Linux uses `eu-stack` (elfutils) for the same reason. Both may be absent; the
 * caller treats a failed capture as "no stack", never as an error worth blocking on.
 */
export function buildStackCaptureCommand(
  platform: NodeJS.Platform,
  pid: number,
  logDir: string,
): StackCaptureCommand | null {
  if (!Number.isInteger(pid) || pid <= 1) return null; // never sample pid 0/1
  const outPath = join(logDir, `watchdog-stack-${CAPTURED_AT_PLACEHOLDER}.txt`);
  if (platform === 'darwin') {
    return { command: 'sample', args: [String(pid), String(SAMPLE_SECONDS), '-file', outPath], outPath, timeoutMs: CAPTURE_TIMEOUT_MS };
  }
  if (platform === 'linux') {
    // `-p <pid>` attaches; output goes to stdout, so the worker redirects it.
    return { command: 'eu-stack', args: ['-p', String(pid)], outPath, timeoutMs: CAPTURE_TIMEOUT_MS };
  }
  return null; // win32 and anything else — no capture rather than a wrong guess
}

/** Env opt-out. Capture is on by default: a wedge is rare, and the whole point is that
 *  it is the ONE moment the evidence exists. */
export function isStackCaptureEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.HOTSHEET_WATCHDOG_STACK !== '0';
}
