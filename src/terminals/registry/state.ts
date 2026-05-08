import { DEFAULT_TERMINAL_ID } from '../config.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  resolveScrollbackBytes,
  sessionKey,
  sessions,
} from './sessionStore.js';
import type { TerminalState, TerminalStatus } from './types.js';

/**
 * HS-8189 — read-only query slice of the registry. Owns the bell / cwd /
 * pid / spinner / status getters that route handlers and the Tauri
 * shutdown path consume. Pre-fix all of this lived inline in
 * `src/terminals/registry.ts`.
 */

export function getTerminalStatus(
  secret: string,
  dataDir: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): TerminalStatus {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (!s) {
    return {
      state: 'not_spawned',
      startedAt: null,
      command: null,
      exitCode: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollbackBytes: resolveScrollbackBytes(dataDir),
    };
  }
  const state: TerminalState = s.pty !== null ? 'alive' : (s.exitCode !== null ? 'exited' : 'not_spawned');
  return {
    state,
    startedAt: s.startedAt,
    command: s.command,
    exitCode: s.exitCode,
    cols: s.cols,
    rows: s.rows,
    scrollbackBytes: s.scrollback.size(),
  };
}

/**
 * HS-6603 §24 — `bellPending` is a per-session sticky flag set by the
 * PTY data handler on `\x07`. These helpers let the route layer read it
 * for `/api/terminal/list` + `/api/projects/bell-state` and clear it via
 * `/api/terminal/clear-bell`.
 */
export function getBellPending(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): boolean {
  return sessions.get(sessionKey(secret, terminalId))?.bellPending === true;
}

/** HS-6702 — most recent timestamp at which a Claude busy-spinner glyph
 *  appeared in this terminal's PTY output. */
export function getLastSpinnerAtMs(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): number | null {
  return sessions.get(sessionKey(secret, terminalId))?.lastSpinnerAtMs ?? null;
}

/** HS-6702 — most recent timestamp at which the PTY emitted ANY output. */
export function getLastOutputAtMs(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): number | null {
  return sessions.get(sessionKey(secret, terminalId))?.lastOutputAtMs ?? null;
}

/**
 * Clear the bell for one terminal. Returns true if the flag was flipped
 * (so the caller knows whether to bump `bellVersion`). HS-7264: also
 * clears any pending OSC 9 notification message.
 */
export function clearBellPending(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): boolean {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (!s || !s.bellPending) return false;
  s.bellPending = false;
  s.notificationMessage = null;
  return true;
}

/** Read the most recent OSC 9 notification message for a terminal, or null
 *  if none is pending. HS-7264. */
export function getNotificationMessage(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): string | null {
  return sessions.get(sessionKey(secret, terminalId))?.notificationMessage ?? null;
}

/** Read the most recent OSC 7 CWD for a terminal, or null. HS-7278. */
export function getCurrentCwd(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): string | null {
  return sessions.get(sessionKey(secret, terminalId))?.currentCwd ?? null;
}

/** HS-7596 — read the PTY's root pid for foreground-process inspection. */
export function getTerminalPid(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): number | null {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (s === undefined || s.pty === null) return null;
  return s.pty.pid;
}

/** HS-7596 — list every project's alive terminals as `{secret, terminalId, rootPid}` triples. */
export function listAliveTerminalsAcrossProjects(): Array<{ secret: string; terminalId: string; rootPid: number }> {
  const result: Array<{ secret: string; terminalId: string; rootPid: number }> = [];
  for (const [key, session] of sessions.entries()) {
    if (session.pty === null) continue;
    const sepIdx = key.indexOf('::');
    if (sepIdx <= 0) continue;
    const secret = key.slice(0, sepIdx);
    const terminalId = key.slice(sepIdx + 2);
    result.push({ secret, terminalId, rootPid: session.pty.pid });
  }
  return result;
}

/** List terminal ids with pending bells for a single project, plus the
 *  optional OSC 9 notification message for each. HS-7264. */
export function listBellPendingForProject(secret: string): Array<{ terminalId: string; message: string | null }> {
  const prefix = `${secret}::`;
  const out: Array<{ terminalId: string; message: string | null }> = [];
  for (const [key, session] of sessions.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (session.bellPending) out.push({ terminalId: key.slice(prefix.length), message: session.notificationMessage });
  }
  return out;
}

