import { DEFAULT_TERMINAL_ID } from '../config.js';
import { createSession, spawnIntoSession } from './lifecycle.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  sessionKey,
  sessions,
} from './sessionStore.js';
import type { AttachOptions, AttachResult, TerminalSubscriber } from './types.js';

/**
 * HS-8189 — connection-management slice of the registry. Owns the four
 * subscriber-facing entry points: attach / detach / writeInput /
 * resizeTerminal. Pre-fix all four lived inline in
 * `src/terminals/registry.ts`.
 */

/**
 * Attach a subscriber to a project's terminal (identified by `terminalId`).
 * Creates + spawns the session lazily on first attach. If the session is
 * in `exited` state, returns its scrollback without respawning — caller
 * uses restart() to replace.
 */
export function attach(
  secret: string,
  dataDir: string,
  subscriber: TerminalSubscriber,
  opts: AttachOptions = {},
  terminalId: string = DEFAULT_TERMINAL_ID,
): AttachResult {
  const key = sessionKey(secret, terminalId);
  let session = sessions.get(key);
  if (!session) {
    if (opts.noSpawn === true) {
      // HS-8218 — no session and the caller forbade spawning. Return a
      // synthetic empty result so the transport can signal "no live
      // session" to the consumer (§47 popup uses this to skip its
      // live-checkout body and fall back to the flat preview).
      return {
        alive: false,
        cols: opts.cols ?? DEFAULT_COLS,
        rows: opts.rows ?? DEFAULT_ROWS,
        command: '',
        exitCode: null,
        scrollbackBytes: 0,
        history: Buffer.alloc(0),
        noSession: true,
      };
    }
    session = createSession(secret, dataDir, terminalId, opts.configOverride ?? null, opts.cols, opts.rows);
    sessions.set(key, session);
    spawnIntoSession(session, dataDir);
  } else if (session.pty === null && session.exitCode === null) {
    // Session exists but was never spawned — should be rare, but spawn now.
    if (opts.noSpawn === true) {
      // HS-8218 — same no-spawn contract as the no-session branch above.
      return {
        alive: false,
        cols: session.cols,
        rows: session.rows,
        command: '',
        exitCode: null,
        scrollbackBytes: 0,
        history: Buffer.alloc(0),
        noSession: true,
      };
    }
    if (opts.cols !== undefined && opts.cols > 0) session.cols = opts.cols;
    if (opts.rows !== undefined && opts.rows > 0) session.rows = opts.rows;
    spawnIntoSession(session, dataDir);
  } else if (session.pty !== null && !session.hasBeenAttached && (opts.cols !== undefined || opts.rows !== undefined)) {
    // HS-6799: first real client attach to an eager-spawned session. The
    // PTY has been running at DEFAULT_COLS × DEFAULT_ROWS since project
    // boot (nobody has called resize) so its startup output — shell
    // welcome, zsh PROMPT_SP EOL mark, Apple Terminal's "Restored
    // session: …", prompt — is all laid out for an 80×24 buffer.
    // Replaying those bytes into the client's actual (usually much
    // wider) pane leaves artifacts at the top even when we resize the
    // receiving xterm first: cursor-positioning escapes, charset shifts,
    // and line wraps don't cleanly reflow.
    //
    // Instead: resize the PTY to the client's real dims, drop the stale
    // scrollback, and poke the shell with Ctrl-L so it clears the screen
    // and reprints its prompt at the correct geometry.
    const newCols = opts.cols ?? session.cols;
    const newRows = opts.rows ?? session.rows;
    if (newCols > 0 && newRows > 0) {
      if (newCols !== session.cols || newRows !== session.rows) {
        session.cols = newCols;
        session.rows = newRows;
        session.pty.resize(newCols, newRows);
      }
      session.scrollback.clear();
      // Ctrl-L / Form Feed. Interactive shells (zsh, bash, fish) interpret
      // it as the `clear-screen` widget: emit `\x1b[2J\x1b[H` and redraw
      // the prompt at the current cursor column.
      try { session.pty.write('\x0c'); } catch { /* pty closed mid-attach */ }
    }
  } else if (session.pty !== null && (opts.cols !== undefined || opts.rows !== undefined)) {
    // Alive session, not-first attach: adopt a larger geometry if this
    // client is bigger. We never shrink — another subscriber might be at
    // the wider size and would reflow badly.
    const newCols = Math.max(session.cols, opts.cols ?? session.cols);
    const newRows = Math.max(session.rows, opts.rows ?? session.rows);
    if (newCols !== session.cols || newRows !== session.rows) {
      session.cols = newCols;
      session.rows = newRows;
      session.pty.resize(newCols, newRows);
    }
  }

  session.subscribers.add(subscriber);
  session.hasBeenAttached = true;

  return {
    alive: session.pty !== null,
    cols: session.cols,
    rows: session.rows,
    command: session.command ?? '',
    exitCode: session.exitCode,
    scrollbackBytes: session.scrollback.size(),
    history: session.scrollback.snapshot(),
  };
}

export function detach(
  secret: string,
  subscriber: TerminalSubscriber,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  sessions.get(sessionKey(secret, terminalId))?.subscribers.delete(subscriber);
}

export function writeInput(
  secret: string,
  data: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (s?.pty) s.pty.write(data);
  // HS-8029 Phase 1 — user typing into the terminal clears any "Not a
  // prompt" suppression on the scanner AND drops the stashed
  // pendingPrompt (the user is interacting with the terminal directly,
  // so the overlay's job is done). Mirrors the client detector's
  // `notifyUserKeystroke`.
  if (s !== undefined) {
    s.promptScanner.notifyUserKeystroke();
    s.pendingPrompt = null;
  }
}

export function resizeTerminal(
  secret: string,
  cols: number,
  rows: number,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (!s) return;
  s.cols = cols;
  s.rows = rows;
  if (s.pty) s.pty.resize(cols, rows);
}
