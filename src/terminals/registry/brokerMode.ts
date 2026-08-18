/**
 * HS-9662 / docs/136 phase 2 — node-server side of the PTY broker.
 *
 * Gated behind `HOTSHEET_PTY_BROKER=1` (docs/124 dev-gate). When ON, terminals are
 * spawned in the detached broker process instead of in-process node-pty, so they
 * survive an accidental node-server death and are re-adopted on restart. When OFF,
 * NONE of this runs and the registry uses the original in-process path unchanged.
 *
 * This module owns: the gate check, the singleton `BrokerClient`, the per-session
 * output router (broker `data`/`exit` → the registry's `SessionState` handlers via
 * a `BrokerBackedPty`), buffered `history` for re-adoption, the per-instance socket
 * path, and the detached broker spawn. Registry mutation (createSession / the
 * `sessions` map) stays in `lifecycle.ts`; this module is the transport.
 */
import { spawn } from 'child_process';
import { openSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { globalHotsheetDir } from '../../global-dir.js';
import { BrokerClient } from '../broker/brokerClient.js';
import type { BrokerSessionInfo, BrokerSpawnSpec } from '../broker/protocol.js';
import type { PtyLike, SpawnArgs } from './types.js';

/**
 * HS-9662 / docs/136 — is terminal-survival broker mode active?
 *
 * DEFAULT ON (so beta / packaged users get survival), with an escape hatch and two
 * carve-outs:
 * - `HOTSHEET_PTY_BROKER=0` → off (escape hatch); `=1` → on (forces it, e.g. tests).
 * - **Windows** → the named-pipe transport IS implemented (HS-9666:
 *   `brokerSocketPathFor` + `brokerSpawnOptions`), but the DEFAULT stays off until
 *   it's verified on a real Windows host — an unverified pipe/spawn bug would cost
 *   the full connect-retry window (~4s) before the in-process fallback. Verify with
 *   `HOTSHEET_PTY_BROKER=1` (which forces it on, checked above), then remove this
 *   gate. Follow-up ticket tracks the verify-then-enable step.
 * - **Unit suite** opts out via `vitest.setup.ts` (sets `=0`), so `registry.test.ts`
 *   etc. keep using the in-process factory; e2e sets `=0` too (HS-9666 adds a broker
 *   e2e). If the broker can't be reached at runtime, spawn falls back to in-process.
 */
export function isBrokerMode(): boolean {
  if (process.env.HOTSHEET_PTY_BROKER === '0') return false;
  if (process.env.HOTSHEET_PTY_BROKER === '1') return true;
  if (process.platform === 'win32') return false;
  return true;
}

/** HS-9666 — stable 32-bit FNV-1a hash of a string, hex. Used to derive a unique
 *  Windows named-pipe name per `HOTSHEET_HOME` (pipes share one global namespace,
 *  so the per-instance scoping the unix socket gets from its directory path has to
 *  come from the pipe NAME instead). Deterministic + dependency-free → testable. */
function hashForPipe(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * HS-9666 — the broker control-socket path for a platform + instance dir. Pure +
 * exported so BOTH OS branches are testable on any host (the `build_kill_command`
 * pattern). node's `net` transports a Windows **named pipe** through the same
 * `connect(path)` / `createServer().listen(path)` API as a unix socket, so only
 * the path shape differs:
 * - **win32** → `\\.\pipe\hotsheet-pty-broker-<hash>` (hash of the instance dir,
 *   since the pipe namespace is global — a fixed name would collide across
 *   `HOTSHEET_HOME`s / test instances).
 * - **else** → `<dir>/pty-broker.sock` (a real file, scoped by its own path).
 */
export function brokerSocketPathFor(platform: NodeJS.Platform, dir: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\hotsheet-pty-broker-${hashForPipe(dir)}`;
  return join(dir, 'pty-broker.sock');
}

/** Per-instance broker socket path (scoped by `HOTSHEET_HOME` via globalHotsheetDir). */
export function brokerSocketPath(): string {
  return brokerSocketPathFor(process.platform, globalHotsheetDir());
}

interface Sink { onData(chunk: Buffer): void; onExit(code: number): void; pty: BrokerBackedPty }
const sinks = new Map<string, Sink>();
const historyBuffer = new Map<string, Buffer>();
let client: BrokerClient | null = null;
/** Sessions the broker reported alive at connect — the re-adoption pool. Consumed
 *  as sessions are adopted (eager-spawn or the post-restore sweep). */
const survivedSessions = new Map<string, BrokerSessionInfo>();

/** The live client, or null when broker mode is off / not yet initialized. */
export function brokerClient(): BrokerClient | null { return client; }

/** A broker session that survived a prior server death, or null. Consumed on adopt. */
export function takeSurvivedSession(sessionId: string): BrokerSessionInfo | null {
  const s = survivedSessions.get(sessionId);
  if (s === undefined) return null;
  survivedSessions.delete(sessionId);
  return s;
}

/** All still-unadopted survived sessions (the post-restore sweep iterates these). */
export function remainingSurvivedSessions(): BrokerSessionInfo[] {
  return [...survivedSessions.values()];
}

/**
 * HS-9694 — refresh the re-adoption pool from the broker's CURRENT live sessions
 * (authoritative), not just the connect-time `welcome` snapshot. The snapshot can be
 * empty/stale (e.g. a transient reconnect race), which would leave a live PTY
 * un-adopted → `/api/terminal/list` returns 0 despite the terminal being alive. Adds
 * any alive session that isn't already adopted (`isAdopted`) or already pooled. Never
 * removes. Best-effort — a broker/list failure leaves the welcome snapshot in place.
 */
export async function refreshSurvivedFromBroker(isAdopted: (sessionId: string) => boolean): Promise<void> {
  if (!client) return;
  let live: BrokerSessionInfo[];
  try { live = await client.list(); } catch { return; }
  for (const s of live) {
    if (!s.alive || isAdopted(s.sessionId) || survivedSessions.has(s.sessionId)) continue;
    survivedSessions.set(s.sessionId, s);
  }
}

function registerSink(sessionId: string, sink: Sink): void { sinks.set(sessionId, sink); }
function unregisterSink(sessionId: string): void { sinks.delete(sessionId); }

/** Drain any buffered scrollback for a re-adopted session (fed into its RingBuffer). */
export function takeHistory(sessionId: string): Buffer | null {
  const h = historyBuffer.get(sessionId);
  if (h === undefined) return null;
  historyBuffer.delete(sessionId);
  return h;
}

/**
 * Connect to the broker (spawning it detached if absent) and return the sessions
 * it already has alive — the re-adoption payload. Idempotent: a second call
 * returns a fresh `list()`.
 */
export async function initBrokerMode(): Promise<BrokerSessionInfo[]> {
  if (client) return client.list();
  const socketPath = brokerSocketPath();
  const c = new BrokerClient({
    socketPath,
    clientId: `hotsheet-server-${String(process.pid)}`,
    handlers: {
      onData: (id, chunk) => sinks.get(id)?.onData(chunk),
      onExit: (id, code) => sinks.get(id)?.onExit(code),
      onHistory: (id, chunk) => {
        const sink = sinks.get(id);
        // If the session is already re-adopted, feed its scrollback directly;
        // otherwise buffer until the re-adopt loop picks it up.
        if (sink) sink.onData(chunk);
        else historyBuffer.set(id, Buffer.concat([historyBuffer.get(id) ?? Buffer.alloc(0), chunk]));
      },
      onDisconnect: () => { console.error('[pty-broker] client disconnected from broker'); },
    },
    spawnBrokerIfAbsent: () => spawnDetachedBroker(socketPath),
  });
  const sessions = await c.connect();
  client = c;
  survivedSessions.clear();
  for (const s of sessions) if (s.alive) survivedSessions.set(s.sessionId, s);
  return sessions;
}

/** A `PtyLike` whose I/O is proxied to a broker session. Lets `lifecycle.ts`'s
 *  spawn path stay identical (its onData scrollback/OSC/bell handling is unchanged). */
export class BrokerBackedPty implements PtyLike {
  pid = 0;
  cols: number;
  rows: number;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  constructor(private readonly c: BrokerClient, private readonly sessionId: string, cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    registerSink(sessionId, {
      onData: (chunk) => this.dataCb?.(chunk.toString('utf8')),
      onExit: (code) => this.exitCb?.({ exitCode: code }),
      pty: this,
    });
  }

  onData(listener: (data: string) => void): { dispose(): void } { this.dataCb = listener; return { dispose: () => { this.dataCb = null; } }; }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } { this.exitCb = listener; return { dispose: () => { this.exitCb = null; } }; }
  write(data: string): void { this.c.write(this.sessionId, Buffer.from(data, 'utf8')); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.c.resize(this.sessionId, cols, rows); }
  /** Non-removing kill (matches the in-process `pty.kill` — session stays exited). */
  kill(signal?: string): void { this.c.kill(this.sessionId, signal ?? 'SIGHUP', false); }
}

/** Spawn + proxy a NEW broker session; returns the proxy pty. */
export function brokerSpawn(sessionId: string, spec: SpawnArgs, meta?: Record<string, unknown>): PtyLike {
  const c = client;
  if (!c) throw new Error('brokerSpawn called before initBrokerMode');
  const spawnSpec: BrokerSpawnSpec = {
    sessionId, command: spec.command, cwd: spec.cwd, cols: spec.cols, rows: spec.rows,
    env: envToRecord(spec.env), meta,
  };
  c.spawn(spawnSpec);
  return new BrokerBackedPty(c, sessionId, spec.cols, spec.rows);
}

/** Attach a proxy pty to an ALREADY-LIVE broker session (re-adoption; no spawn). */
export function brokerAdopt(sessionId: string, info: BrokerSessionInfo): PtyLike {
  const c = client;
  if (!c) throw new Error('brokerAdopt called before initBrokerMode');
  const pty = new BrokerBackedPty(c, sessionId, info.cols, info.rows);
  pty.pid = info.pid;
  return pty;
}

/** Tell the broker to remove a session (explicit close of a terminal). */
export function brokerRemove(sessionId: string): void { client?.kill(sessionId, 'SIGHUP', true); unregisterSink(sessionId); }
/** Tell the broker to remove every session for a project (explicit project close). */
export function brokerRemovePrefix(prefix: string): void {
  client?.killPrefix(prefix);
  for (const id of [...sinks.keys()]) if (id.startsWith(prefix)) unregisterSink(id);
}
/** Explicit app quit: kill all broker sessions + let the broker exit. */
export function brokerShutdownForQuit(): void { client?.shutdownBroker(); }
/** Disconnect WITHOUT killing (the survival path — node shutdown that isn't a quit). */
export function brokerDisconnect(): void { client?.close(); client = null; sinks.clear(); historyBuffer.clear(); }

function envToRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * Launch the broker as a DETACHED child (its own process group) so it outlives an
 * accidental node-server death and Tauri's `kill(-pid)` of the node group. Dev
 * runs the entry via tsx; prod runs the bundled entry. Best-effort: the client
 * retries the connect after this.
 */
/**
 * HS-9666 — platform detach options for the broker spawn. Pure + exported so both
 * OS branches are testable on any host (the `build_kill_command` pattern).
 * - **unix** → `detached: true` puts the child in its own process group (setsid),
 *   so Tauri's `kill(-nodePid)` of the node group doesn't take it down.
 * - **win32** → `detached: true` gives the child its own process group too (it's
 *   not tied to the parent's console), and `windowsHide` keeps a console window
 *   from flashing. Combined with `.unref()` the broker outlives the node server.
 */
export function brokerSpawnOptions(platform: NodeJS.Platform): { detached: true; windowsHide?: true } {
  return platform === 'win32' ? { detached: true, windowsHide: true } : { detached: true };
}

function spawnDetachedBroker(socketPath: string): void {
  try {
    const here = fileURLToPath(import.meta.url);
    const isSource = here.endsWith('.ts');
    const logFd = openLogFd();
    const stdio = ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'] as const;
    const opts = brokerSpawnOptions(process.platform);
    if (isSource) {
      // dev: src/terminals/registry/brokerMode.ts → ../broker/ptyBrokerEntry.ts
      const entry = join(dirname(here), '..', 'broker', 'ptyBrokerEntry.ts');
      spawn(process.execPath, ['--import', 'tsx', entry, socketPath], { ...opts, stdio: [...stdio], env: process.env }).unref();
    } else {
      // prod: the bundled entry sits next to dist/cli.js.
      const entry = join(dirname(here), 'ptyBrokerEntry.js');
      spawn(process.execPath, [entry, socketPath], { ...opts, stdio: [...stdio], env: process.env }).unref();
    }
  } catch (e) {
    console.error('[pty-broker] failed to spawn broker:', e instanceof Error ? e.message : String(e));
  }
}

function openLogFd(): number | null {
  try { return openSync(join(globalHotsheetDir(), 'pty-broker.log'), 'a'); } catch { return null; }
}
