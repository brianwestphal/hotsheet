import { chmodSync, existsSync } from 'fs';
import { createRequire } from 'module';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { dirname, join } from 'path';

import { readFileSettings } from '../file-settings.js';
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
    spawnIntoSession(session, dataDir);
  } else if (session.pty !== null && (opts.cols !== undefined || opts.rows !== undefined)) {
    // Alive session: adopt a larger geometry if this client is bigger.
    const newCols = Math.max(session.cols, opts.cols ?? session.cols);
    const newRows = Math.max(session.rows, opts.rows ?? session.rows);
    if (newCols !== session.cols || newRows !== session.rows) {
      session.cols = newCols;
      session.rows = newRows;
      session.pty.resize(newCols, newRows);
    }
  }

  session.subscribers.add(subscriber);

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
  if (!session) {
    session = createSession(dataDir, terminalId, null);
    sessions.set(key, session);
  } else {
    teardownPty(session);
    session.scrollback.clear();
  }
  spawnIntoSession(session, dataDir);
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
  };
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

  const dData = pty.onData((str) => {
    const chunk = Buffer.from(str, 'utf8');
    session.scrollback.push(chunk);
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
    try { session.pty.kill('SIGTERM'); } catch { /* already dead */ }
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
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOTSHEET_IN_TERMINAL: '1',
  };
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
