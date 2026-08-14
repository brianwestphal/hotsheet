/**
 * HS-9662 / docs/136 — the PTY broker process.
 *
 * A detached process (its own process group) that OWNS every terminal's node-pty.
 * The node server connects over a unix socket and proxies spawn/write/resize/kill
 * + streams output; because the broker outlives an accidental node-server death
 * (OOM / watchdog SIGKILL / crash / `--replace`), the PTYs — and their AI sessions
 * — survive, and a fresh server RE-ADOPTS them via `hello`→`welcome`.
 *
 * Lifecycle rules (docs/136):
 * - Explicit `kill {remove}` / `killPrefix` / `shutdown` DO kill PTYs (user closed
 *   a tab / a project / quit the app).
 * - A client simply disconnecting does NOT kill anything (that's the accidental
 *   death we survive) — but if NO client reconnects within the lease grace, the
 *   broker self-exits and kills its PTYs so a dead app can't orphan shells forever.
 *
 * The PTY factory is injectable so unit tests can drive the broker with a fake
 * PTY (no real process) for the kill/lease paths; the default uses node-pty.
 */
import { createServer,type Server, type Socket } from 'net';
import { spawn as spawnPty } from 'node-pty';

import { killProcessTreeBestEffort } from '../processInspect.js';
import type { PtyLike, SpawnArgs } from '../registry/types.js';
import { RingBuffer } from '../ringBuffer.js';
import {
  type BrokerMessage,
  type BrokerSessionInfo,
  type BrokerSpawnSpec,
  type ClientMessage,
  encodeFrame,
  FrameSplitter,
  parseClientMessage,
  PROTOCOL_VERSION,
} from './protocol.js';

const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;
/** How long the broker survives with no connected client before self-exiting. A
 *  fresh server reconnects in well under this on a restart; a dead app never does. */
const DEFAULT_LEASE_GRACE_MS = 45_000;

interface BrokerSession {
  pty: PtyLike | null;
  pid: number;
  exitCode: number | null;
  cols: number;
  rows: number;
  command: string;
  startedAt: number;
  meta: Record<string, unknown> | undefined;
  scrollback: RingBuffer;
  disposables: { dispose(): void }[];
}

export interface BrokerOptions {
  /** PTY factory — default node-pty; tests inject a fake. */
  spawnPty?: (args: SpawnArgs) => PtyLike;
  scrollbackBytes?: number;
  leaseGraceMs?: number;
  /** Called when the lease expires (no client). Default: kill all + `process.exit`.
   *  Tests override to assert without exiting the worker. */
  onLeaseExpired?: () => void;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Process-tree killer — default `killProcessTreeBestEffort`. Tests MUST inject a
   *  no-op: fake-PTY pids are arbitrary integers and signalling them would hit real
   *  system processes (the src/terminals test hazard). */
  killTree?: (pid: number, signal: string) => void;
}

export class PtyBroker {
  private readonly sessions = new Map<string, BrokerSession>();
  private readonly clients = new Map<Socket, FrameSplitter>();
  private server: Server | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly spawnPtyFn: (args: SpawnArgs) => PtyLike;
  private readonly scrollbackBytes: number;
  private readonly leaseGraceMs: number;
  private readonly onLeaseExpired: () => void;
  private readonly now: () => number;
  private readonly killTree: (pid: number, signal: string) => void;

  constructor(opts: BrokerOptions = {}) {
    this.spawnPtyFn = opts.spawnPty ?? defaultBrokerPtyFactory;
    this.scrollbackBytes = opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.leaseGraceMs = opts.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS;
    this.now = opts.now ?? Date.now;
    // Wrap so the option type stays a plain string; the underlying helper narrows
    // to its own `Signals` union (type-level only — no runtime concern).
    this.killTree = opts.killTree ?? ((pid, signal) => { killProcessTreeBestEffort(pid, signal as Parameters<typeof killProcessTreeBestEffort>[1]); });
    this.onLeaseExpired = opts.onLeaseExpired ?? (() => { this.killAll(); process.exit(0); });
  }

  /** Start listening on `socketPath`. Resolves once bound. */
  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onClientConnect(socket));
      server.on('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        this.server = server;
        // No client yet — arm the lease so a broker nobody ever connects to exits.
        this.armLease();
        resolve();
      });
    });
  }

  /** For tests: current live/known sessions as the wire shape. */
  sessionInfos(): BrokerSessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => this.infoFor(sessionId, s));
  }

  /** Close the server + kill everything (test teardown / explicit shutdown). */
  shutdown(): void {
    this.killAll();
    for (const socket of this.clients.keys()) socket.destroy();
    this.clients.clear();
    if (this.leaseTimer) { clearTimeout(this.leaseTimer); this.leaseTimer = null; }
    this.server?.close();
    this.server = null;
  }

  private onClientConnect(socket: Socket): void {
    socket.setEncoding('utf8');
    const splitter = new FrameSplitter();
    this.clients.set(socket, splitter);
    this.clearLease(); // a client is present → cancel any pending self-exit
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try { lines = splitter.push(chunk); } catch { socket.destroy(); return; }
      for (const line of lines) {
        const msg = parseClientMessage(line);
        if (msg) this.handleMessage(socket, msg);
      }
    });
    const drop = (): void => {
      this.clients.delete(socket);
      if (this.clients.size === 0) this.armLease();
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private handleMessage(socket: Socket, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello': {
        this.send(socket, { t: 'welcome', protocolVersion: PROTOCOL_VERSION, sessions: this.sessionInfos() });
        // Replay scrollback for every live session so a re-adopting server can
        // repaint reconnecting clients.
        for (const [sessionId, s] of this.sessions) {
          const snap = s.scrollback.snapshot();
          if (snap.length > 0) this.send(socket, { t: 'history', sessionId, data: snap.toString('base64') });
        }
        break;
      }
      case 'spawn': return this.spawn(msg.spec);
      case 'write': { this.sessions.get(msg.sessionId)?.pty?.write(Buffer.from(msg.data, 'base64').toString('utf8')); break; }
      case 'resize': {
        const s = this.sessions.get(msg.sessionId);
        if (s) { s.cols = msg.cols; s.rows = msg.rows; try { s.pty?.resize(msg.cols, msg.rows); } catch { /* dead */ } }
        break;
      }
      case 'kill': { this.killSession(msg.sessionId, msg.signal ?? 'SIGTERM', msg.remove ?? false); break; }
      case 'killPrefix': {
        for (const id of [...this.sessions.keys()]) if (id.startsWith(msg.prefix)) this.killSession(id, 'SIGTERM', true);
        break;
      }
      case 'list': { this.send(socket, { t: 'sessions', sessions: this.sessionInfos() }); break; }
      case 'ping': { this.send(socket, { t: 'pong' }); break; }
      case 'shutdown': { this.killAll(); this.broadcast({ t: 'pong' }); this.onLeaseExpired(); break; }
    }
  }

  private spawn(spec: BrokerSpawnSpec): void {
    // A duplicate spawn for a live session is ignored (idempotent re-adoption).
    const existing = this.sessions.get(spec.sessionId);
    if (existing && existing.pty !== null) {
      this.broadcast({ t: 'spawned', sessionId: spec.sessionId, pid: existing.pid, startedAt: existing.startedAt });
      return;
    }
    let pty: PtyLike;
    try {
      pty = this.spawnPtyFn({ command: spec.command, cwd: spec.cwd, cols: spec.cols, rows: spec.rows, env: spec.env });
    } catch (e) {
      this.broadcast({ t: 'spawnError', sessionId: spec.sessionId, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const startedAt = this.now();
    const session: BrokerSession = {
      pty, pid: pty.pid, exitCode: null, cols: spec.cols, rows: spec.rows,
      command: spec.command, startedAt, meta: spec.meta, scrollback: new RingBuffer(this.scrollbackBytes), disposables: [],
    };
    this.sessions.set(spec.sessionId, session);
    const dData = pty.onData((str) => {
      const chunk = Buffer.from(str, 'utf8');
      session.scrollback.push(chunk);
      this.broadcast({ t: 'data', sessionId: spec.sessionId, data: chunk.toString('base64') });
    });
    const dExit = pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.pty = null;
      this.broadcast({ t: 'exit', sessionId: spec.sessionId, exitCode });
    });
    session.disposables = [dData, dExit];
    this.broadcast({ t: 'spawned', sessionId: spec.sessionId, pid: session.pid, startedAt });
  }

  private killSession(sessionId: string, signal: string, remove: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const d of s.disposables) { try { d.dispose(); } catch { /* ignore */ } }
    s.disposables = [];
    if (s.pty) {
      const rootPid = s.pty.pid;
      if (rootPid > 0) this.killTree(rootPid, 'SIGTERM');
      try { s.pty.kill(signal); } catch { /* already dead */ }
      s.pty = null;
    }
    if (remove) this.sessions.delete(sessionId);
  }

  private killAll(): void {
    for (const id of [...this.sessions.keys()]) this.killSession(id, 'SIGTERM', true);
  }

  private infoFor(sessionId: string, s: BrokerSession): BrokerSessionInfo {
    return { sessionId, pid: s.pid, alive: s.pty !== null, exitCode: s.exitCode, cols: s.cols, rows: s.rows, command: s.command, startedAt: s.startedAt, meta: s.meta };
  }

  private send(socket: Socket, msg: BrokerMessage): void {
    try { socket.write(encodeFrame(msg)); } catch { /* client gone */ }
  }

  private broadcast(msg: BrokerMessage): void {
    const frame = encodeFrame(msg);
    for (const socket of this.clients.keys()) { try { socket.write(frame); } catch { /* skip */ } }
  }

  private armLease(): void {
    this.clearLease();
    if (this.leaseGraceMs <= 0) return;
    this.leaseTimer = setTimeout(() => { this.leaseTimer = null; this.onLeaseExpired(); }, this.leaseGraceMs);
    this.leaseTimer.unref();
  }

  private clearLease(): void {
    if (this.leaseTimer) { clearTimeout(this.leaseTimer); this.leaseTimer = null; }
  }
}

/** Default node-pty factory — mirrors the registry's `defaultFactory` (sh -c / cmd /c). */
function defaultBrokerPtyFactory(args: SpawnArgs): PtyLike {
  const isWindows = process.platform === 'win32';
  const file = isWindows ? 'cmd.exe' : '/bin/sh';
  const forkArgs = isWindows ? ['/c', args.command] : ['-c', args.command];
  return spawnPty(file, forkArgs, { name: 'xterm-256color', cols: args.cols, rows: args.rows, cwd: args.cwd, env: args.env });
}
