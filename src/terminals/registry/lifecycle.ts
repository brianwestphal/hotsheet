import { chmodSync, existsSync } from 'fs';
import { createRequire } from 'module';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { dirname, join } from 'path';

import { projectDriveService } from '../../aiTools/serverCapabilities.js';
import { containsClaudeSpinner } from '../claudeSpinner.js';
import { DEFAULT_TERMINAL_ID, type TerminalConfig } from '../config.js';
import { scanPtyChunk } from '../oscScanner.js';
import { killProcessTreeBestEffort } from '../processInspect.js';
import { resolveTerminalCommand } from '../resolveCommand.js';
import { RingBuffer } from '../ringBuffer.js';
import { setupShellHistoryForSpawn } from '../shellHistory.js';
import {
  brokerAdopt,
  BrokerBackedPty,
  brokerClient,
  brokerDisconnect,
  brokerRemove,
  brokerRemovePrefix,
  brokerSpawn,
  isBrokerMode,
  remainingSurvivedSessions,
  takeHistory,
  takeSurvivedSession,
} from './brokerMode.js';
import { buildOtelEnv } from './otelEnv.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  projectPrefix,
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
  secret: string,
  dataDir: string,
  terminalId: string,
  configOverride: TerminalConfig | null,
  cols?: number,
  rows?: number,
): SessionState {
  return {
    secret,
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

/**
 * Spawn a PTY into the session. Synchronous in the common case.
 *
 * HS-9429 (docs/129 §129.4, model-B) — the ONE exception: a cold codex-model-B
 * terminal (discovery gate on, `ai_tool=codex`, daemon socket not up yet) must
 * launch daemon-hosted (`codex --remote`), which needs the daemon running. So we
 * `ensureCodexDaemonRunning` FIRST and defer the actual spawn until it resolves —
 * the maintainer's "await the daemon" choice (HS-9429), scoped to just that case so
 * every other spawn (and `attach`'s synchronous pty read) is unaffected. If the
 * ensure fails, the deferred spawn resolves to plain `codex` (the socket-absent
 * fallback in `codexTerminalRemoteCommand`), so the terminal always works.
 */
export function spawnIntoSession(session: SessionState, dataDir: string): void {
  // HS-9493 — does this project's drive have a backing service that a terminal spawn
  // must wait for? Null (and so `false`) for every tool without one — docs/132 §132.1.1.
  const service = projectDriveService(dataDir);
  if (service !== null && service.blocksTerminalSpawn(dataDir)) {
    void service.ensureUpForSpawn()
      .catch(() => false)
      // Re-check the guard after the await: the session may have been spawned by
      // another path or torn down while we waited (~1-2s on a cold daemon).
      .finally(() => { if (session.pty === null && session.exitCode === null) doSpawnIntoSession(session, dataDir); });
    return;
  }
  doSpawnIntoSession(session, dataDir);
}

function doSpawnIntoSession(session: SessionState, dataDir: string): void {
  const resolved = resolveTerminalCommand({
    dataDir,
    terminalId: session.terminalId,
    configOverride: session.configOverride ?? undefined,
  });
  // HS-9493 — the drive service notices if the terminal did not end up hosted by it and
  // warns once. Which flags that depends on is the service's business, not ours.
  // Resolved here rather than passed in: this function is also reached directly from the
  // deferred-spawn `.finally` above, so a parameter would have two call sites to keep in
  // step for no gain (the lookup is a settings read the spawn path already does).
  projectDriveService(dataDir)?.noteTerminalLaunch(dataDir, session.terminalId, resolved.command);
  // HS-7965 — generate per-terminal shell init files + collect env / command
  // overrides so up-arrow recall is scoped per (project, terminal id) rather
  // than sharing the user's global ~/.zsh_history / ~/.bash_history.
  const shellInit = setupShellHistoryForSpawn({
    dataDir,
    terminalId: session.terminalId,
    command: resolved.command,
  });
  const finalCommand = shellInit.rewrittenCommand ?? resolved.command;
  const spawnArgs: SpawnArgs = {
    command: finalCommand,
    cwd: resolved.cwd,
    cols: session.cols,
    rows: session.rows,
    env: buildEnv(shellInit.env, dataDir),
  };

  session.startedAt = Date.now();
  session.command = finalCommand;
  session.exitCode = null;
  // Fresh PTY — drop any OSC-scan state left from a previous process.
  session.bellScanInString = false;
  session.bellScanAfterEsc = false;
  session.oscAccumulator = null;
  // HS-7278 — drop the server-side CWD too; the new shell will push its own
  // OSC 7 on the first prompt.
  session.currentCwd = null;

  // HS-9662 — in broker mode the PTY lives in the detached broker (so it survives
  // an accidental server death). The returned `BrokerBackedPty` proxies I/O; the
  // handler wiring below is identical either way. If the broker isn't connected
  // (init failed), fall back to an in-process PTY so terminals still work — just
  // without survival — rather than throwing.
  const pty = (isBrokerMode() && brokerClient() !== null)
    ? brokerSpawn(
        sessionKey(session.secret, session.terminalId),
        spawnArgs,
        session.configOverride !== null ? { config: session.configOverride } : undefined,
      )
    : activeFactory(spawnArgs);

  wireSessionToPty(session, pty);
}

/**
 * HS-9662 — wire a session's scrollback / OSC-scan / bell / spinner / subscriber
 * broadcast onto a (freshly spawned OR re-adopted) PTY. Extracted from
 * `doSpawnIntoSession` so the broker re-adoption path reuses the exact same
 * handling. Sets `session.pty` + `session.ptyDisposables`.
 */
function wireSessionToPty(session: SessionState, pty: PtyLike): void {
  session.pty = pty;
  const dData = pty.onData((str) => {
    const chunk = Buffer.from(str, 'utf8');
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

/**
 * HS-9662 — adopt a single broker session that survived a prior server death, if
 * one exists for `(secret, terminalId)` and no local session does yet. Rebuilds
 * the `SessionState`, seeds its scrollback from the broker's replayed history, and
 * attaches a proxy pty. Returns true if it adopted. Shared by the eager-spawn path
 * (`ensureSpawned`) and the post-restore sweep (`readoptBrokerSessions`).
 */
export function adoptSurvivedSession(secret: string, dataDir: string, terminalId: string): boolean {
  if (!isBrokerMode()) return false;
  const key = sessionKey(secret, terminalId);
  if (sessions.has(key)) return false;
  const info = takeSurvivedSession(key);
  if (info === null) return false;
  const session = createSession(secret, dataDir, terminalId, extractConfig(info.meta), info.cols, info.rows);
  session.command = info.command;
  session.startedAt = info.startedAt;
  session.exitCode = info.alive ? null : info.exitCode;
  // Seed scrollback from the broker's replayed history (before wiring live data).
  const history = takeHistory(key);
  if (history !== null && history.length > 0) session.scrollback.push(history);
  const pty = brokerAdopt(key, info);
  wireSessionToPty(session, pty);
  if (!info.alive) { session.pty = null; }
  sessions.set(key, session);
  // HS-9662 — a survived DYNAMIC terminal (carries a configOverride) needs its
  // config re-registered so `/api/terminal/list` shows the tab with its name.
  // Lazy import avoids a registry ↔ routes cycle (mirrors the notify import above).
  const cfg = session.configOverride;
  if (cfg !== null) {
    void import('../../routes/terminal.js')
      .then((m) => m.registerDynamicTerminalConfig(secret, terminalId, cfg))
      .catch(() => { /* list will fall back to the defense-pass id */ });
  }
  return true;
}

/**
 * HS-9662 / docs/136 phase 2 — sweep the remaining survived broker sessions after
 * projects are restored (the ones no eager-spawn adopted, e.g. lazy terminals), so
 * their tabs come back too. `dataDirForSecret` maps a project secret → its dataDir;
 * sessions whose project isn't registered this run are left in the broker.
 */
export function readoptBrokerSessions(dataDirForSecret: (secret: string) => string | null): number {
  if (!isBrokerMode()) return 0;
  let adopted = 0;
  for (const info of remainingSurvivedSessions()) {
    const sep = info.sessionId.indexOf('::');
    if (sep === -1) continue;
    const secret = info.sessionId.slice(0, sep);
    const terminalId = info.sessionId.slice(sep + 2);
    const dataDir = dataDirForSecret(secret);
    if (dataDir === null) continue;
    if (adoptSurvivedSession(secret, dataDir, terminalId)) adopted++;
  }
  return adopted;
}

function extractConfig(meta: Record<string, unknown> | undefined): TerminalConfig | null {
  if (meta === undefined) return null;
  const cfg = (meta as { config?: unknown }).config;
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return null;
  return cfg as TerminalConfig;
}

export function teardownPty(session: SessionState): void {
  for (const d of session.ptyDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  session.ptyDisposables = [];
  if (session.pty) {
    // HS-9662 — a broker-backed PTY's process tree lives in the broker; `pty.kill`
    // routes there (which does the tree-kill), so a LOCAL `killProcessTreeBestEffort`
    // would be wrong. Keyed off the pty TYPE (not just the gate) so an in-process
    // fallback PTY spawned while broker mode was on is still tree-killed correctly.
    if (!(session.pty instanceof BrokerBackedPty)) {
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
    // HS-9662 — if this terminal survived a prior server death in the broker,
    // re-adopt it (keeping the running process + scrollback) instead of spawning
    // a fresh one.
    if (adoptSurvivedSession(secret, dataDir, terminalId)) return;
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
  // HS-9662 — explicit close: drop the broker's session record too.
  if (isBrokerMode()) brokerRemove(key);
}

/** Destroy every terminal for a project (e.g. on project unregister, when its
 *  tab is closed). HS-8604 — this MUST `teardownPty` each session before
 *  dropping the map entry; the pre-fix version only deleted the entry, which
 *  orphaned every live PTY (a running `claude`, dev server, etc.) — the
 *  process kept running, unreachable from any UI, until the whole app exited.
 *  Mirrors `destroyTerminal` / `destroyAllTerminals`. */
export function destroyProjectTerminals(secret: string): void {
  const prefix = projectPrefix(secret);
  for (const key of [...sessions.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const session = sessions.get(key);
    if (session) {
      teardownPty(session);
      session.subscribers.clear();
    }
    sessions.delete(key);
  }
  // HS-9662 — explicit project-tab close: drop the broker's records for it too.
  if (isBrokerMode()) brokerRemovePrefix(prefix);
}

/** List ids of terminals the registry currently knows about for a project. */
export function listProjectTerminalIds(secret: string): string[] {
  const prefix = projectPrefix(secret);
  const out: string[] = [];
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

/**
 * Tear down the LOCAL session registry on server shutdown.
 *
 * HS-9662 — in broker mode this is the survival path: it must NOT kill the PTYs
 * (they live in the detached broker and outlive this process). It only disposes
 * local handlers, disconnects from the broker, and clears the local map — the
 * broker keeps the sessions alive for the next server to re-adopt. An EXPLICIT
 * quit (SIGTERM/SIGINT) separately calls `brokerShutdownForQuit()` from the
 * graceful pipeline (`src/lifecycle.ts`) to actually kill them. In non-broker mode
 * this kills every live PTY as before.
 */
export function destroyAllTerminals(): void {
  if (isBrokerMode()) {
    for (const key of [...sessions.keys()]) {
      const session = sessions.get(key);
      if (session) {
        for (const d of session.ptyDisposables) { try { d.dispose(); } catch { /* ignore */ } }
        session.subscribers.clear();
      }
      sessions.delete(key);
    }
    brokerDisconnect();
    return;
  }
  for (const key of [...sessions.keys()]) {
    const session = sessions.get(key);
    if (!session) continue;
    teardownPty(session);
    session.subscribers.clear();
    sessions.delete(key);
  }
}

// --- Env scrub + buildEnv ---

function buildEnv(extra: Record<string, string> = {}, dataDir?: string): NodeJS.ProcessEnv {
  return {
    ...scrubParentEnv(process.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOTSHEET_IN_TERMINAL: '1',
    // HS-7965 — per-(project, terminal) shell-history overrides.
    ...extra,
    // HS-8145 — Claude Code OpenTelemetry env injection (§67.3).
    // Default-empty when `dataDir` isn't known (test fixtures) or when
    // the project's `telemetry_enabled` setting isn't `true`. Helper
    // is in `./otelEnv.ts`.
    ...(dataDir !== undefined ? buildOtelEnv(dataDir) : {}),
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
    env: args.env,
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
