import { chmodSync, existsSync } from 'fs';
import { createRequire } from 'module';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { dirname, join } from 'path';

import { readFileSettings } from '../file-settings.js';
import { containsClaudeSpinner } from './claudeSpinner.js';
import { DEFAULT_TERMINAL_ID, type TerminalConfig } from './config.js';
import { resolveTerminalCommand } from './resolveCommand.js';
import { RingBuffer } from './ringBuffer.js';

export type TerminalState = 'alive' | 'exited' | 'not_spawned';

export interface TerminalStatus {
  state: TerminalState;
  startedAt: number | null;
  command: string | null;
  exitCode: number | null;
  cols: number;
  rows: number;
  scrollbackBytes: number;
}

export interface TerminalSubscriber {
  onData(chunk: Buffer): void;
  onExit(exitCode: number): void;
}

export interface AttachResult {
  alive: boolean;
  cols: number;
  rows: number;
  command: string;
  exitCode: number | null;
  scrollbackBytes: number;
  /** Full scrollback at attach time; the subscriber should replay this before live data. */
  history: Buffer;
}

/** Minimal PTY interface the registry depends on — matches node-pty's IPty. */
export interface PtyLike {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnArgs {
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export type PtyFactory = (args: SpawnArgs) => PtyLike;

/** Options passed through `attach()` for terminals that are not registered in settings. */
export interface AttachOptions {
  cols?: number;
  rows?: number;
  /**
   * When the terminalId is not present in settings (e.g. a dynamic terminal
   * created via POST /api/terminal/create), the caller supplies the TerminalConfig
   * here so the registry can spawn without consulting settings.
   */
  configOverride?: TerminalConfig;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK_MIN = 64 * 1024;
const SCROLLBACK_MAX = 16 * 1024 * 1024;
const SCROLLBACK_DEFAULT = 1024 * 1024;

interface SessionState {
  pty: PtyLike | null;
  ptyDisposables: { dispose(): void }[];
  startedAt: number | null;
  command: string | null;
  exitCode: number | null;
  cols: number;
  rows: number;
  scrollback: RingBuffer;
  subscribers: Set<TerminalSubscriber>;
  terminalId: string;
  /** Optional config override (used by dynamic terminals not in settings). */
  configOverride: TerminalConfig | null;
  /** True when the process has rung the bell (`\x07`) since the flag was last
   *  cleared via clearBellPending(). Set by the PTY data handler and consumed
   *  by the in-drawer and cross-project bell indicators (HS-6603 / §24). */
  bellPending: boolean;
  /** Most recent OSC 9 payload (iTerm2-style desktop notification — HS-7264).
   *  Set alongside `bellPending` when the PTY data handler parses
   *  `\x1b]9;<message>\x07`; cleared together with bellPending. The in-drawer
   *  client reads this from `/api/terminal/list` to surface a toast; the
   *  cross-project bellPoll surfaces it too (§27). */
  notificationMessage: string | null;
  /** Most recent OSC 7 CWD pushed by the shell (`\x1b]7;file://host/path\x07`,
   *  HS-7278). Parallel to the client-side `runtimeCwd` on TerminalInstance
   *  (HS-7262) but server-tracked so the dashboard tile can render a CWD
   *  badge without mounting xterm. Null until the first OSC 7 arrives; resets
   *  on PTY restart. */
  currentCwd: string | null;
  /** Cross-chunk state for `scanPtyChunk` — tracks whether the byte stream
   *  is currently inside an OSC/DCS/APC/PM/SOS escape string (where a trailing
   *  BEL is a terminator, not a user-visible bell). HS-6766. */
  bellScanInString: boolean;
  bellScanAfterEsc: boolean;
  /** When non-null, the scanner is inside an OSC string specifically (not
   *  DCS/APC/PM/SOS) and bytes are being appended here so we can inspect the
   *  payload on terminator. Reset to null on string close. Capped at
   *  MAX_OSC_PAYLOAD_LEN bytes to guard against pathological input. HS-7264. */
  oscAccumulator: string | null;
  /** True once a real client has attached. Used by the eager-spawn cleanup in
   *  attach() — the first real attach clears scrollback, resizes the PTY to
   *  the client's actual pane dims, and sends Ctrl-L so the shell redraws its
   *  prompt at the right geometry instead of the startup-time 80×24 output
   *  leaking through as stray characters (HS-6799). */
  hasBeenAttached: boolean;
  /** Wall-clock ms timestamp of the last PTY chunk (`pty.onData`). Used by
   *  the HS-6702 PTY-activity busy detection to spot terminals that have
   *  been silent for a while. */
  lastOutputAtMs: number | null;
  /** Wall-clock ms timestamp of the last PTY chunk that contained a Claude
   *  busy-spinner glyph (`· ✢ ✳ ✶ ✻ ✽`). The channel-UI degraded-busy
   *  state fires when channel-busy is true AND `nowMs - lastSpinnerAtMs >
   *  5000` (i.e. Claude looks idle even though the channel hook says busy).
   *  Reset to null on PTY restart. HS-6702. */
  lastSpinnerAtMs: number | null;
}

const sessions = new Map<string, SessionState>();

function sessionKey(secret: string, terminalId: string): string {
  return `${secret}::${terminalId}`;
}

let activeFactory: PtyFactory = defaultFactory;

/** Override the PTY factory (used by tests). Returns the previous factory. */
export function setPtyFactory(factory: PtyFactory): PtyFactory {
  const prev = activeFactory;
  activeFactory = factory;
  return prev;
}

/**
 * Attach a subscriber to a project's terminal (identified by `terminalId`).
 * Creates + spawns the session lazily on first attach. If the session is in
 * `exited` state, returns its scrollback without respawning — caller uses
 * restart() to replace.
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
    session = createSession(dataDir, terminalId, opts.configOverride ?? null, opts.cols, opts.rows);
    sessions.set(key, session);
    spawnIntoSession(session, dataDir);
  } else if (session.pty === null && session.exitCode === null) {
    // Session exists but was never spawned — should be rare, but spawn now.
    if (opts.cols !== undefined && opts.cols > 0) session.cols = opts.cols;
    if (opts.rows !== undefined && opts.rows > 0) session.rows = opts.rows;
    spawnIntoSession(session, dataDir);
  } else if (session.pty !== null && !session.hasBeenAttached && (opts.cols !== undefined || opts.rows !== undefined)) {
    // HS-6799: first real client attach to an eager-spawned session. The PTY
    // has been running at DEFAULT_COLS × DEFAULT_ROWS since project boot (nobody
    // has called resize) so its startup output — shell welcome message, zsh
    // PROMPT_SP EOL mark, Apple Terminal's "Restored session: …", prompt —
    // is all laid out for an 80×24 buffer. Replaying those bytes into the
    // client's actual (usually much wider) pane leaves artifacts at the top
    // even when we resize the receiving xterm first: cursor-positioning
    // escapes, charset shifts, and line wraps don't cleanly reflow.
    //
    // Instead: resize the PTY to the client's real dims, drop the stale
    // scrollback, and poke the shell with Ctrl-L so it clears the screen and
    // reprints its prompt at the correct geometry. The client's xterm now
    // receives a fresh stream of bytes that were generated *for* its actual
    // dimensions.
    const newCols = opts.cols ?? session.cols;
    const newRows = opts.rows ?? session.rows;
    if (newCols > 0 && newRows > 0) {
      if (newCols !== session.cols || newRows !== session.rows) {
        session.cols = newCols;
        session.rows = newRows;
        session.pty.resize(newCols, newRows);
      }
      session.scrollback.clear();
      // Ctrl-L / Form Feed. Interactive shells (zsh, bash, fish) interpret it
      // as the `clear-screen` widget: emit `\x1b[2J\x1b[H` and redraw the
      // prompt at the current cursor column. If the terminal is running a
      // non-shell command that happens to ignore FF, the worst case is the
      // same blank scrollback the user would have with a lazy-spawn anyway.
      try { session.pty.write('\x0c'); } catch { /* pty closed mid-attach */ }
    }
  } else if (session.pty !== null && (opts.cols !== undefined || opts.rows !== undefined)) {
    // Alive session, not-first attach: adopt a larger geometry if this client
    // is bigger. We never shrink — another subscriber might be at the wider
    // size and would reflow badly.
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
 * Ensure a PTY exists for `(secret, terminalId)` without attaching a subscriber.
 * Used by the eager-spawn path (HS-6310) so non-lazy terminals launch at project
 * boot without needing a WebSocket. If the session already exists (alive or
 * exited), this is a no-op — we never auto-respawn an exited PTY.
 */
export function ensureSpawned(
  secret: string,
  dataDir: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
  configOverride: TerminalConfig | null = null,
): void {
  const key = sessionKey(secret, terminalId);
  let session = sessions.get(key);
  if (!session) {
    session = createSession(dataDir, terminalId, configOverride);
    sessions.set(key, session);
    spawnIntoSession(session, dataDir);
    return;
  }
  if (session.pty === null && session.exitCode === null) {
    spawnIntoSession(session, dataDir);
  }
}

/** Explicit kill — PTY exits, subscribers receive onExit. Session remains in `exited` state. */
export function killTerminal(
  secret: string,
  signal: string = 'SIGTERM',
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (s?.pty) s.pty.kill(signal);
}

/**
 * Restart the terminal: kill the existing PTY (quietly, no onExit notification
 * to subscribers), clear scrollback, and spawn a fresh PTY. Subscribers stay
 * attached and will receive output from the new process.
 */
export function restartTerminal(
  secret: string,
  dataDir: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const key = sessionKey(secret, terminalId);
  let session = sessions.get(key);
  let bellFlipped = false;
  if (!session) {
    session = createSession(dataDir, terminalId, null);
    sessions.set(key, session);
  } else {
    teardownPty(session);
    session.scrollback.clear();
    // HS-6603 §24.6 — reset bellPending on restart. A bell from the previous
    // process shouldn't leak into the freshly-spawned one.
    if (session.bellPending) {
      session.bellPending = false;
      bellFlipped = true;
    }
    // HS-6702 — reset PTY-activity timestamps on restart so a stale
    // spinner from the previous Claude session doesn't paint the new
    // process as "still busy".
    session.lastOutputAtMs = null;
    session.lastSpinnerAtMs = null;
  }
  spawnIntoSession(session, dataDir);
  if (bellFlipped) {
    void import('../routes/notify.js').then(m => m.notifyBellWaiters()).catch(() => { /* ignore */ });
  }
}

/** Fully remove the session (used on project unregister or on closing a dynamic terminal). Kills the PTY if alive. */
export function destroyTerminal(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const key = sessionKey(secret, terminalId);
  const session = sessions.get(key);
  if (!session) return;
  teardownPty(session);
  session.subscribers.clear();
  sessions.delete(key);
}

/** Destroy every terminal for a project (e.g. on project unregister). */
export function destroyProjectTerminals(secret: string): void {
  const prefix = `${secret}::`;
  for (const key of [...sessions.keys()]) {
    if (key.startsWith(prefix)) sessions.delete(key);
  }
}

/** List ids of terminals the registry currently knows about for a project. */
export function listProjectTerminalIds(secret: string): string[] {
  const prefix = `${secret}::`;
  const out: string[] = [];
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

/**
 * HS-6603 §24 — bell helpers. `bellPending` is a per-session sticky flag set by
 * the PTY data handler on `\x07`. These helpers let the route layer read it
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
 *  appeared in this terminal's PTY output. `null` when no spinner has
 *  been seen since the session started or last restart. The
 *  `/api/terminal/list` route surfaces this so the channel-UI can decide
 *  whether to render its degraded-busy state. */
export function getLastSpinnerAtMs(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): number | null {
  return sessions.get(sessionKey(secret, terminalId))?.lastSpinnerAtMs ?? null;
}

/** HS-6702 — most recent timestamp at which the PTY emitted ANY output.
 *  Useful as a last-resort idle heuristic when spinner detection isn't
 *  applicable (e.g. terminals running something other than Claude). */
export function getLastOutputAtMs(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): number | null {
  return sessions.get(sessionKey(secret, terminalId))?.lastOutputAtMs ?? null;
}

/**
 * Clear the bell for one terminal. Returns true if the flag was flipped (so
 * the caller knows whether to bump `bellVersion`). No-op when the session
 * doesn't exist or the flag is already false. HS-7264: also clears any
 * pending OSC 9 notification message — the two are always cleared together
 * since they share a single "attention on this tab" concept.
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

/** Read the most recent OSC 7 CWD for a terminal, or null if the shell
 *  hasn't pushed one yet. HS-7278 — consumed by `/api/terminal/list` so the
 *  dashboard can render a CWD badge on cold tiles. */
export function getCurrentCwd(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): string | null {
  return sessions.get(sessionKey(secret, terminalId))?.currentCwd ?? null;
}

/** HS-7596 — read the PTY's root pid for foreground-process inspection in
 *  the §37 quit-confirm flow. Returns null when the session doesn't exist,
 *  is no longer alive (`pty === null`), or never spawned. The caller (the
 *  /api/terminal/foreground-process route) walks the OS process tree from
 *  this pid. */
export function getTerminalPid(
  secret: string,
  terminalId: string = DEFAULT_TERMINAL_ID,
): number | null {
  const s = sessions.get(sessionKey(secret, terminalId));
  if (s === undefined || s.pty === null) return null;
  return s.pty.pid;
}

/** HS-7596 — list every project's alive terminals as `{secret, terminalId,
 *  rootPid}` triples. Used by the /api/terminals/quit-summary route to
 *  enumerate what's running across all known projects in a single pass. */
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
 *  optional OSC 9 notification message for each. Return shape is designed
 *  for `/api/projects/bell-state` (§24) and `/api/terminal/list` (§22) to
 *  consume in one scan. HS-7264. */
export function listBellPendingForProject(secret: string): Array<{ terminalId: string; message: string | null }> {
  const prefix = `${secret}::`;
  const out: Array<{ terminalId: string; message: string | null }> = [];
  for (const [key, session] of sessions.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (session.bellPending) out.push({ terminalId: key.slice(prefix.length), message: session.notificationMessage });
  }
  return out;
}

/** Kill every live PTY. For server SIGTERM/SIGINT. */
export function destroyAllTerminals(): void {
  for (const key of [...sessions.keys()]) {
    const session = sessions.get(key);
    if (!session) continue;
    teardownPty(session);
    session.subscribers.clear();
    sessions.delete(key);
  }
}

// --- Internals ---

function createSession(
  dataDir: string,
  terminalId: string,
  configOverride: TerminalConfig | null,
  cols?: number,
  rows?: number,
): SessionState {
  return {
    pty: null,
    ptyDisposables: [],
    startedAt: null,
    command: null,
    exitCode: null,
    cols: cols ?? DEFAULT_COLS,
    rows: rows ?? DEFAULT_ROWS,
    scrollback: new RingBuffer(resolveScrollbackBytes(dataDir)),
    subscribers: new Set(),
    terminalId,
    configOverride,
    bellPending: false,
    notificationMessage: null,
    currentCwd: null,
    bellScanInString: false,
    bellScanAfterEsc: false,
    oscAccumulator: null,
    hasBeenAttached: false,
    lastOutputAtMs: null,
    lastSpinnerAtMs: null,
  };
}

/** Cap on the OSC accumulator so a malformed or adversarial stream can't pin
 *  a session's heap usage. OSC payloads in real use are short (titles, URLs,
 *  notification strings) — 4 KiB is generous. HS-7264. */
const MAX_OSC_PAYLOAD_LEN = 4096;

/**
 * Scan a chunk of PTY output for (1) a *real* bell — a `\x07` byte that isn't
 * the terminator of an OSC/DCS/APC/PM/SOS string — (2) OSC 9 desktop
 * notification payloads (`\x1b]9;<message>\x07`, HS-7264), and (3) OSC 7
 * current-working-directory pushes (`\x1b]7;file://host/path\x07`, HS-7278 —
 * so the dashboard can render a CWD badge on cold tiles without mounting
 * xterm).
 *
 * Many shells emit OSC sequences like `\x1b]0;TITLE\x07` or
 * `\x1b]7;file://host/cwd\x07` on every prompt (and on startup via Apple
 * Terminal's zshrc integration) — the trailing BEL is a terminator, not a
 * user-visible bell. A naive `chunk.includes(0x07)` check treats those as
 * bells, which is why a fresh dynamic terminal would show a bell indicator
 * immediately on open (HS-6766).
 *
 * State is stored on the session so it carries across chunks — a shell could
 * flush an OSC introducer in one write and the BEL terminator in the next.
 * The `oscAccumulator` field also carries across chunks for OSC-content
 * inspection on close.
 *
 * Returns `{ bell, osc9Message, osc7Cwd }`. Both message/cwd are the most
 * recent values seen in the chunk (later payloads overwrite earlier ones —
 * latest-wins for both notification and CWD semantics).
 */
function scanPtyChunk(session: SessionState, chunk: Buffer): { bell: boolean; osc9Message: string | null; osc7Cwd: string | null } {
  let foundBell = false;
  let osc9Message: string | null = null;
  let osc7Cwd: string | null = null;
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i];
    if (session.bellScanInString) {
      if (b === 0x07) {
        // BEL = OSC-style terminator; close the string and inspect payload.
        const parsed = finishOscString(session);
        if (parsed.osc9 !== null) osc9Message = parsed.osc9;
        if (parsed.osc7 !== null) osc7Cwd = parsed.osc7;
        session.bellScanInString = false;
        session.bellScanAfterEsc = false;
        session.oscAccumulator = null;
        continue;
      }
      if (session.bellScanAfterEsc) {
        session.bellScanAfterEsc = false;
        if (b === 0x5C /* backslash */) {
          // ESC\\ (ST) = terminator.
          const parsed = finishOscString(session);
          if (parsed.osc9 !== null) osc9Message = parsed.osc9;
          if (parsed.osc7 !== null) osc7Cwd = parsed.osc7;
          session.bellScanInString = false;
          session.oscAccumulator = null;
          continue;
        }
        // ESC followed by other: the string is effectively broken, but to
        // stay conservative we remain in string-state until a real terminator.
      }
      if (b === 0x1B) {
        session.bellScanAfterEsc = true;
        continue;
      }
      // Plain content byte inside a string escape. Append to the OSC payload
      // buffer if we're tracking one (i.e. this is an OSC, not DCS/APC/PM/SOS).
      if (session.oscAccumulator !== null && session.oscAccumulator.length < MAX_OSC_PAYLOAD_LEN) {
        session.oscAccumulator += String.fromCharCode(b);
      }
      continue;
    }
    if (session.bellScanAfterEsc) {
      session.bellScanAfterEsc = false;
      if (b === 0x5D /* ] */) {
        // OSC introducer — begin string AND begin accumulating payload bytes.
        session.bellScanInString = true;
        session.oscAccumulator = '';
        continue;
      }
      if (b === 0x50 || b === 0x5F || b === 0x5E || b === 0x58) {
        // DCS=P, APC=_, PM=^, SOS=X: string-type escapes whose contents must
        // not be interpreted as bells, but we don't need to inspect their
        // payloads (not OSC 9). Leave accumulator null so no memory is spent.
        session.bellScanInString = true;
        session.oscAccumulator = null;
        continue;
      }
      // Any other ESC-prefixed byte is a non-string escape (CSI, SS3, charset
      // switches like ESC(0, etc.) — drop back to normal scanning so the next
      // iteration evaluates `b` against the bell check below.
    }
    if (b === 0x1B) {
      session.bellScanAfterEsc = true;
      continue;
    }
    if (b === 0x07) {
      foundBell = true;
    }
  }
  return { bell: foundBell, osc9Message, osc7Cwd };
}

/**
 * Called on OSC-string close. Inspects the accumulated payload for the two
 * OSC numbers Hot Sheet cares about — `9;<message>` for desktop notifications
 * (HS-7264) and `7;file://host/path` for the shell's current working
 * directory (HS-7278). Titles (`0;`, `1;`, `2;`), hyperlinks (`8;`), and
 * everything else pass through without affecting session state. Returns the
 * parsed value for whichever OSC number matched (at most one can match).
 */
function finishOscString(session: SessionState): { osc9: string | null; osc7: string | null } {
  if (session.oscAccumulator === null) return { osc9: null, osc7: null };
  const payload = session.oscAccumulator;
  if (payload.startsWith('9;')) {
    const rest = payload.slice(2);
    // iTerm2 has proprietary numeric sub-commands in the 9 namespace (9;1 for
    // progress, 9;4 for newer progress, etc.). They start with "<digit>;" which
    // is NOT a human-readable message. Skip them — the plain "9;<message>"
    // form is the only one we surface as a notification.
    if (/^\d+;/.test(rest)) return { osc9: null, osc7: null };
    return { osc9: rest, osc7: null };
  }
  if (payload.startsWith('7;')) {
    // HS-7278 — `file://host/path` parsing. Empty host is accepted
    // (`file:///path`); percent-encoded bytes are decoded. Anything that
    // doesn't parse to a file URL is rejected — we don't want to surface
    // garbled text as a CWD.
    const rest = payload.slice(2);
    if (!rest.startsWith('file://')) return { osc9: null, osc7: null };
    const afterScheme = rest.slice('file://'.length);
    const pathStart = afterScheme.indexOf('/');
    if (pathStart < 0) return { osc9: null, osc7: null };
    try {
      return { osc9: null, osc7: decodeURIComponent(afterScheme.slice(pathStart)) };
    } catch {
      return { osc9: null, osc7: null };
    }
  }
  return { osc9: null, osc7: null };
}

function spawnIntoSession(session: SessionState, dataDir: string): void {
  const resolved = resolveTerminalCommand({
    dataDir,
    terminalId: session.terminalId,
    configOverride: session.configOverride ?? undefined,
  });
  const pty = activeFactory({
    command: resolved.command,
    cwd: resolved.cwd,
    cols: session.cols,
    rows: session.rows,
    env: buildEnv(),
  });

  session.pty = pty;
  session.startedAt = Date.now();
  session.command = resolved.command;
  session.exitCode = null;
  // Fresh PTY — drop any OSC-scan state left from a previous process.
  session.bellScanInString = false;
  session.bellScanAfterEsc = false;
  session.oscAccumulator = null;
  // HS-7278 — drop the server-side CWD too; the new shell will push its own
  // OSC 7 on the first prompt.
  session.currentCwd = null;

  const dData = pty.onData((str) => {
    const chunk = Buffer.from(str, 'utf8');
    session.scrollback.push(chunk);
    // HS-6702 — PTY-activity timestamp + Claude spinner detection.
    // `lastOutputAtMs` ticks on every chunk so the client can spot
    // long-silent terminals; `lastSpinnerAtMs` only updates when the
    // chunk contains one of the Claude busy-spinner glyphs, which is
    // the more reliable signal (Claude pulses the spinner ~10 Hz while
    // working, so any 5+ s gap means Claude really is idle).
    const nowMs = Date.now();
    session.lastOutputAtMs = nowMs;
    if (containsClaudeSpinner(str)) session.lastSpinnerAtMs = nowMs;
    // HS-6603 §24.2 — server-side bell detection. Always run the scanner so
    // cross-chunk OSC/DCS/APC/PM/SOS state is tracked even when `bellPending`
    // is already set (HS-6766). The scanner returns `bell` only for BELs that
    // aren't OSC-style terminators, so a shell emitting `\x1b]0;TITLE\x07`
    // on every prompt no longer trips the indicator. HS-7264 extends the same
    // pass to capture OSC 9 (`\x1b]9;<message>\x07`) desktop-notification
    // payloads — when present, we stash the message AND flip bellPending so
    // the tab gets the bell glyph + a toast carries the message text.
    const { bell: realBell, osc9Message, osc7Cwd } = scanPtyChunk(session, chunk);
    const wasPending = session.bellPending;
    if (realBell) session.bellPending = true;
    if (osc9Message !== null) {
      session.bellPending = true;
      session.notificationMessage = osc9Message;
    }
    // HS-7278 — stash server-side CWD so the dashboard tile can show a CWD
    // badge for cold tiles. Does NOT set bellPending — OSC 7 arrives on every
    // prompt and would be indistinguishable from a real attention request.
    if (osc7Cwd !== null) session.currentCwd = osc7Cwd;
    if (!wasPending && session.bellPending) {
      // Lazy dynamic import to avoid a circular dep between registry ↔ routes.
      void import('../routes/notify.js').then(m => m.notifyBellWaiters()).catch(() => { /* ignore */ });
    }
    for (const sub of session.subscribers) {
      try { sub.onData(chunk); } catch { /* subscriber errors don't break the broadcast */ }
    }
  });

  const dExit = pty.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    session.pty = null;
    for (const sub of session.subscribers) {
      try { sub.onExit(exitCode); } catch { /* ignore */ }
    }
  });

  session.ptyDisposables = [dData, dExit];
}

function teardownPty(session: SessionState): void {
  for (const d of session.ptyDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  session.ptyDisposables = [];
  if (session.pty) {
    // HS-7528: use SIGHUP rather than SIGTERM — interactive shells
    // (zsh / bash / fish) ignore SIGTERM but exit cleanly on hang-up. Same
    // rationale as the `/api/terminal/kill` route (HS-6471). SIGTERM here
    // left shells running after Hot Sheet shutdown, so the PTYs became
    // orphans when the server process exited.
    try { session.pty.kill('SIGHUP'); } catch { /* already dead */ }
  }
  session.pty = null;
  session.startedAt = null;
  session.command = null;
  session.exitCode = null;
}

function resolveScrollbackBytes(dataDir: string): number {
  const settings = readFileSettings(dataDir);
  const raw = settings.terminal_scrollback_bytes;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return SCROLLBACK_DEFAULT;
  return Math.max(SCROLLBACK_MIN, Math.min(SCROLLBACK_MAX, Math.floor(n)));
}

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...scrubParentEnv(process.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOTSHEET_IN_TERMINAL: '1',
  };
}

/**
 * HS-7527: strip env vars that leak from Hot Sheet's own runtime into
 * spawned terminals. The canonical repro: Hot Sheet runs under `tsx`, which
 * exports `TSX_TSCONFIG_PATH=tsconfig.json`. That env var leaks into every
 * PTY, so `npm run some-script` inside the Hot Sheet terminal re-invokes
 * `tsx` with `TSX_TSCONFIG_PATH` pointing at a path that's valid only in
 * the Hot Sheet working tree — it fails in the user's actual project with
 * `Cannot resolve tsconfig at path: …`.
 *
 * General solution: strip the well-known "this process is being run by
 * tool X" markers that toolchains add to their children's environment.
 * These are an implementation detail of how Hot Sheet itself was launched
 * and have no business leaking into the user's interactive shells.
 *
 * Exported so this module's tests can verify the scrub list without having
 * to spawn a real PTY. The list is deliberately a fixed allowlist of
 * matchers, not an opt-out — every entry is a concrete instance of the
 * "tool-marker vars shouldn't leak" rule.
 */
export function scrubParentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldStripEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/** True iff an env-var name matches one of the "don't leak into children" patterns. Exported for tests. */
export function shouldStripEnvKey(key: string): boolean {
  // tsx loader (HS-7527 root cause). `TSX_*` covers TSX_TSCONFIG_PATH plus
  // any future tsx-specific vars.
  if (key.startsWith('TSX_')) return true;
  // npm's script environment. When Hot Sheet is launched via `npm start` /
  // `npm run dev`, npm exports ~20 npm_* vars (npm_config_*, npm_lifecycle_*,
  // npm_package_*, npm_node_execpath, npm_command, etc.) that leak into the
  // PTY and can confuse tools that branch on "am I being run by npm?".
  if (key.startsWith('npm_')) return true;
  if (key === 'NODE') return true;
  // NODE_OPTIONS can carry `--import tsx/esm` or `--require …` that hijacks
  // child Node processes inside the PTY. NODE_PATH is similar.
  if (key === 'NODE_OPTIONS') return true;
  if (key === 'NODE_PATH') return true;
  // pnpm equivalents of npm_*.
  if (key.startsWith('PNPM_')) return true;
  if (key === 'INIT_CWD') return true;
  // Yarn
  if (key.startsWith('YARN_')) return true;
  if (key.startsWith('BERRY_')) return true;
  // macOS: `__CFBundleIdentifier` is set by Launch Services to identify the
  // launching app (e.g. Terminal.app, hotsheet.app). A PTY child picking
  // this up can mis-attribute itself to Hot Sheet in telemetry / crash
  // reporters. Strip the whole `__CF*` family since Apple adds new ones
  // per-release.
  if (key.startsWith('__CF')) return true;
  // Tauri sidecar markers — the Tauri runtime sets these so the sidecar can
  // detect its launch mode. User shells shouldn't inherit them.
  if (key.startsWith('TAURI_')) return true;
  return false;
}

// --- Default PTY factory (uses node-pty; wraps the command string via $SHELL -c) ---

function defaultFactory(args: SpawnArgs): PtyLike {
  ensureSpawnHelperExecutable();
  const isWindows = process.platform === 'win32';
  const file = isWindows ? 'cmd.exe' : '/bin/sh';
  const forkArgs = isWindows ? ['/c', args.command] : ['-c', args.command];
  const pty: IPty = spawnPty(file, forkArgs, {
    name: 'xterm-256color',
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    env: args.env as { [key: string]: string },
  });
  return pty;
}

/**
 * npm occasionally strips the execute bit from node-pty's spawn-helper binary
 * on macOS/Linux. The first spawn fails with `posix_spawnp failed` when this
 * happens. Re-apply +x defensively on startup — a no-op in the healthy case.
 */
let spawnHelperFixed = false;
function ensureSpawnHelperExecutable(): void {
  if (spawnHelperFixed || process.platform === 'win32') return;
  spawnHelperFixed = true;
  try {
    const platformDir = `${process.platform}-${process.arch}`;
    const nodeRequire = createRequire(import.meta.url);
    const nodePtyDir = dirname(nodeRequire.resolve('node-pty/package.json'));
    const helper = join(nodePtyDir, 'prebuilds', platformDir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch { /* ignore — spawn will surface the real error if this didn't help */ }
}
