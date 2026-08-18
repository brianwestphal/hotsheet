/**
 * HS-9692 (docs/136) — distinguish a GENUINE app quit from an accidental/external
 * SIGTERM so the detached PTY broker is only torn down when the app is really
 * exiting.
 *
 * The problem: the Tauri shell's ⌘Q path (`confirm_quit`) and a bare external
 * `kill <pid>` both deliver **SIGTERM** to the sidecar — the signal alone can't tell
 * them apart. The old teardown gated on `reason === 'SIGTERM' || 'SIGINT'`, so an
 * external kill (which the HS-9656 supervisor RESPAWNS from) tore the broker + all
 * PTYs down → the fresh server re-adopted nothing → terminals came back blank. The
 * whole point of the broker (docs/136) is that an accidental death survives.
 *
 * The fix: the shell signals a real quit out-of-band by writing a marker FILE before
 * it SIGTERMs, and sets two env vars on the sidecar it spawns:
 *   - `HOTSHEET_TERMINAL_SUPERVISOR=1` — "a supervisor manages me; a bare signal may
 *     be an accidental kill I'll be respawned from, so don't tear the broker down on
 *     the signal alone."
 *   - `HOTSHEET_QUIT_INTENT_FILE=<path>` — the EXACT marker path the shell will write,
 *     so the two processes never disagree on where it lives (incl. `--test` instances
 *     whose `HOTSHEET_HOME` the shell can't itself resolve).
 *
 * Standalone (`npm run dev`, `npx hotsheet`): neither env is set, so a SIGINT/SIGTERM
 * is treated as a real quit (there is no supervisor to re-adopt, and leaving detached
 * shells alive would leak them).
 */
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import { globalHotsheetDir } from '../global-dir.js';

/** The quit-intent marker path. The shell sets `HOTSHEET_QUIT_INTENT_FILE` to the
 *  path it will write; the sidecar reads that same value so they always agree. Falls
 *  back to the global dir for standalone runs where no shell sets the env. */
export function quitIntentPath(): string {
  const override = process.env.HOTSHEET_QUIT_INTENT_FILE;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(globalHotsheetDir(), 'terminal-quit-intent');
}

/** Is a terminal SUPERVISOR (the Tauri shell) managing this sidecar? When true a bare
 *  SIGTERM/SIGINT may be an accidental kill the supervisor will respawn from, so broker
 *  teardown must wait for the explicit quit-intent marker. When false (standalone dev /
 *  CLI) a signal is a real quit and tears the broker down. */
export function isTerminalSupervised(): boolean {
  return process.env.HOTSHEET_TERMINAL_SUPERVISOR === '1';
}

/** True when the shell has signaled a genuine app quit (⌘Q / app exit) by writing the
 *  marker, as opposed to an external/accidental SIGTERM. Best-effort: any error reads
 *  as "no quit intent" (fail safe toward SURVIVAL under supervision). */
export function isQuitIntended(): boolean {
  try { return existsSync(quitIntentPath()); } catch { return false; }
}

/** Write the quit-intent marker. Used by standalone/test callers that simulate the
 *  shell; the real signal in the packaged app is written by the Rust shell. */
export function markQuitIntended(): void {
  try { writeFileSync(quitIntentPath(), `${Date.now()}\n`, 'utf-8'); } catch { /* best-effort */ }
}

/** Clear a stale marker at startup so a leftover from a prior real quit can't make the
 *  next run tear the broker down on an accidental signal. Best-effort. */
export function clearQuitIntent(): void {
  try { if (existsSync(quitIntentPath())) unlinkSync(quitIntentPath()); } catch { /* best-effort */ }
}

/**
 * Should this shutdown tear the detached broker (and its PTYs) down? True only for a
 * REAL quit:
 *  - the shell wrote the quit-intent marker (a genuine ⌘Q / app exit), OR
 *  - we're standalone (no supervisor) and got a real quit signal — nothing will
 *    re-adopt, so leaving detached shells alive would leak them.
 *
 * A bare SIGTERM/SIGINT under the supervisor is treated as an accidental kill the
 * supervisor will respawn from → the broker SURVIVES so the fresh server re-adopts it.
 */
export function shouldTearDownBroker(reason: string): boolean {
  const signalQuit = reason === 'SIGTERM' || reason === 'SIGINT';
  return isQuitIntended() || (!isTerminalSupervised() && signalQuit);
}
