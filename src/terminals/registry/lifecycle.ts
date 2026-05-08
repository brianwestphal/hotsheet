import { chmodSync, existsSync } from 'fs';
import { createRequire } from 'module';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { dirname, join } from 'path';

import { containsClaudeSpinner } from '../claudeSpinner.js';
import { DEFAULT_TERMINAL_ID, type TerminalConfig } from '../config.js';
import { scanPtyChunk } from '../oscScanner.js';
import { killProcessTreeBestEffort } from '../processInspect.js';
import { resolveTerminalCommand } from '../resolveCommand.js';
import { RingBuffer } from '../ringBuffer.js';
import { setupShellHistoryForSpawn } from '../shellHistory.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  resolveScrollbackBytes,
  sessionKey,
  sessions,
} from './sessionStore.js';
import type { PtyFactory, PtyLike, SessionState, SpawnArgs } from './types.js';

/**
 * HS-8189 — terminal-lifecycle slice of the registry. Owns the PTY factory
 * (default + override), session creation, spawn/teardown, and the
 * destroy/kill/restart/list public exports. Pre-fix all of this lived
 * inline in `src/terminals/registry.ts`.
 */

let activeFactory: PtyFactory = defaultFactory;

/** Override the PTY factory (used by tests). Returns the previous factory. */
export function setPtyFactory(factory: PtyFactory): PtyFactory {
  const prev = activeFactory;
  activeFactory = factory;
  return prev;
}

export function createSession(
  _secret: string,
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

export function spawnIntoSession(session: SessionState, dataDir: string): void {
  const resolved = resolveTerminalCommand({
    dataDir,
    terminalId: session.terminalId,
    configOverride: session.configOverride ?? undefined,
  });
  // HS-7965 — generate per-terminal shell init files + collect env / command
  // overrides so up-arrow recall is scoped per (project, terminal id) rather
  // than sharing the user's global ~/.zsh_history / ~/.bash_history.
  const shellInit = setupShellHistoryForSpawn({
    dataDir,
    terminalId: session.terminalId,
    command: resolved.command,
  });
  const finalCommand = shellInit.rewrittenCommand ?? resolved.command;
  const pty = activeFactory({
    command: finalCommand,
    cwd: resolved.cwd,
    cols: session.cols,
    rows: session.rows,
    env: buildEnv(shellInit.env),
  });

  session.pty = pty;
  session.startedAt = Date.now();
  session.command = finalCommand;
  session.exitCode = null;
  // HS-8287 DIAGNOSTIC #2 — log every PTY spawn so the user's repro can
  // correlate banner counts with spawn events. If 5 spawns happen against
  // the same `(dataDir, terminalId)` pair, that's the smoking gun: claude
  // is being relaunched (channel auto-fire / shell loop / restart-on-exit
  // wiring) and each launch emits its own banner.
  if (process.env.HOTSHEET_HS8287_QUIET !== '1') {
    const projectTag = dataDir.replace(/\/+$/, '').split('/').slice(-2).join('/');
    console.log(`[HS-8287:spawn] ${projectTag}::${session.terminalId} pid=${pty.pid} cmd=${finalCommand.slice(0, 80)}${finalCommand.length > 80 ? '…' : ''} cwd=${resolved.cwd}`);
  }
  // Fresh PTY — drop any OSC-scan state left from a previous process.
  session.bellScanInString = false;
  session.bellScanAfterEsc = false;
  session.oscAccumulator = null;
  // HS-7278 — drop the server-side CWD too; the new shell will push its own
  // OSC 7 on the first prompt.
  session.currentCwd = null;

  // HS-8287 DIAGNOSTIC #2 — log every PTY chunk + scrollback size so a
  // post-reproduction server log can answer: "is 5 different Claude
  // banners hitting THIS session's ring buffer over time, or are 5
  // separate sessions each emitting 1 banner that end up cross-routed?".
  // Intentionally loud — counts the literal bytes so a 1-banner ring
  // buffer (~600 bytes) is distinguishable from a 5-banner one (~3 KB)
  // at a glance. Includes a banner-substring marker so a single grep can
  // pull out the Claude-startup events. Disabled when the env var
  // HOTSHEET_HS8287_QUIET is set so the spam is opt-out for users who
  // don't want it. Identifier uses the dataDir basename + terminalId
  // (the registry-internal `secret` isn't in scope here, but the
  // dataDir basename is human-readable and uniquely identifies the
  // project's `.hotsheet/` directory which is enough to grep for).
  const hs8287Quiet = process.env.HOTSHEET_HS8287_QUIET === '1';
  const projectTag = dataDir.replace(/\/+$/, '').split('/').slice(-2).join('/');
  const dataKey = `${projectTag}::${session.terminalId}`;
  let chunkCounter = 0;
  const dData = pty.onData((str) => {
    const chunk = Buffer.from(str, 'utf8');
    if (!hs8287Quiet) {
      chunkCounter++;
      const isBanner = str.includes('Claude Code v');
      // Sample first 5 chunks + every chunk that mentions the banner,
      // with running scrollback bytes after the push so reproducer can
      // see exactly how the ring buffer fills.
      if (chunkCounter <= 5 || isBanner) {
        console.log(`[HS-8287:rcv] ${dataKey} chunk#${chunkCounter} bytes=${chunk.length} bannerStart=${isBanner ? 'YES' : 'no'} scrollbackAfter=${session.scrollback.size() + chunk.length}`);
      }
    }
    session.scrollback.push(chunk);
    // HS-6702 — PTY-activity timestamp + Claude spinner detection.
    const nowMs = Date.now();
    session.lastOutputAtMs = nowMs;
    if (containsClaudeSpinner(str)) session.lastSpinnerAtMs = nowMs;
    // HS-6603 §24.2 — server-side bell detection. Always run the scanner
    // so cross-chunk OSC/DCS/APC/PM/SOS state is tracked even when
    // `bellPending` is already set (HS-6766).
    const { bell: realBell, osc9Message, osc7Cwd } = scanPtyChunk(session, chunk);
    const wasPending = session.bellPending;
    if (realBell) session.bellPending = true;
    if (osc9Message !== null) {
      session.bellPending = true;
      session.notificationMessage = osc9Message;
    }
    if (osc7Cwd !== null) session.currentCwd = osc7Cwd;
    if (!wasPending && session.bellPending) {
      // Lazy dynamic import to avoid a circular dep between registry ↔ routes.
      void import('../../routes/notify.js').then(m => m.notifyBellWaiters()).catch(() => { /* ignore */ });
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

export function teardownPty(session: SessionState): void {
  for (const d of session.ptyDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  session.ptyDisposables = [];
  if (session.pty) {
    // HS-8140 — SIGTERM every descendant before SIGHUP-ing the shell.
    // node-pty's `kill('SIGHUP')` reaches only the immediate shell process;
    // grandchildren (a backgrounded `&` job, a `claude` instance running
    // inside zsh, anything that traps SIGHUP) survive the shell's exit.
    // Walking the process tree once via `ps -o pid,ppid,comm -A` and
    // signalling each descendant catches those before the shell goes away.
    const rootPid = session.pty.pid;
    if (rootPid > 0) {
      killProcessTreeBestEffort(rootPid, 'SIGTERM');
    }
    // HS-7528: SIGHUP rather than SIGTERM — interactive shells ignore
    // SIGTERM but exit cleanly on hang-up.
    try { session.pty.kill('SIGHUP'); } catch { /* already dead */ }
  }
  session.pty = null;
  session.startedAt = null;
  session.command = null;
  session.exitCode = null;
}

/**
 * Ensure a PTY exists for `(secret, terminalId)` without attaching a
 * subscriber. Used by the eager-spawn path (HS-6310) so non-lazy
 * terminals launch at project boot without needing a WebSocket. If the
 * session already exists (alive or exited), this is a no-op — we never
 * auto-respawn an exited PTY.
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
    session = createSession(secret, dataDir, terminalId, configOverride);
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
 * Restart the terminal: kill the existing PTY (quietly, no onExit
 * notification to subscribers), clear scrollback, and spawn a fresh
 * PTY. Subscribers stay attached and will receive output from the new
 * process.
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
    session = createSession(secret, dataDir, terminalId, null);
    sessions.set(key, session);
  } else {
    teardownPty(session);
    session.scrollback.clear();
    // HS-6603 §24.6 — reset bellPending on restart. A bell from the
    // previous process shouldn't leak into the freshly-spawned one.
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
    void import('../../routes/notify.js').then(m => m.notifyBellWaiters()).catch(() => { /* ignore */ });
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
    if (key.startsWith(prefix)) {
      sessions.delete(key);
    }
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

// --- Env scrub + buildEnv ---

function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...scrubParentEnv(process.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOTSHEET_IN_TERMINAL: '1',
    // HS-7965 — per-(project, terminal) shell-history overrides.
    ...extra,
  };
}

/**
 * HS-7527: strip env vars that leak from Hot Sheet's own runtime into
 * spawned terminals. Exported so this module's tests can verify the
 * scrub list without having to spawn a real PTY.
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
  // tsx loader (HS-7527 root cause).
  if (key.startsWith('TSX_')) return true;
  // npm's script environment.
  if (key.startsWith('npm_')) return true;
  if (key === 'NODE') return true;
  // NODE_OPTIONS can carry `--import tsx/esm` or `--require …`.
  if (key === 'NODE_OPTIONS') return true;
  if (key === 'NODE_PATH') return true;
  // pnpm equivalents of npm_*.
  if (key.startsWith('PNPM_')) return true;
  if (key === 'INIT_CWD') return true;
  // Yarn
  if (key.startsWith('YARN_')) return true;
  if (key.startsWith('BERRY_')) return true;
  // macOS Launch Services ids.
  if (key.startsWith('__CF')) return true;
  // Tauri sidecar markers.
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
 * on macOS/Linux. Re-apply +x defensively on startup — a no-op in the healthy case.
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
