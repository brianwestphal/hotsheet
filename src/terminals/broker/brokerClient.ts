/**
 * HS-9662 / docs/136 — node-server-side client for the PTY broker.
 *
 * The node server uses this to spawn/drive/stream PTYs that actually live in the
 * detached broker process. On startup it connects to an EXISTING broker (spawning
 * one if absent) and the `welcome` reply carries the sessions still alive from
 * before an accidental death — the re-adoption payload the registry rebuilds tabs
 * from. Output arrives via the `onData`/`onExit`/`onHistory` callbacks.
 */
import { connect as netConnect,type Socket } from 'net';

import {
  type BrokerSessionInfo,
  type BrokerSpawnSpec,
  type ClientMessage,
  encodeFrame,
  FrameSplitter,
  parseBrokerMessage,
  PROTOCOL_VERSION,
} from './protocol.js';

export interface BrokerClientHandlers {
  onData(sessionId: string, chunk: Buffer): void;
  onExit(sessionId: string, exitCode: number): void;
  onHistory(sessionId: string, chunk: Buffer): void;
  /** The socket dropped (broker died / restarted). The caller decides how to react. */
  onDisconnect?(): void;
}

export interface BrokerClientOptions {
  socketPath: string;
  clientId: string;
  handlers: BrokerClientHandlers;
  /** Called when the initial connect is refused/ENOENT, to launch a broker; the
   *  client then retries `connectAttempts` times. Omit in tests (broker already up). */
  spawnBrokerIfAbsent?: () => void;
  connectAttempts?: number;
  connectRetryMs?: number;
  /** Keepalive ping period; keeps the broker's client-lease alive. 0 disables. */
  pingIntervalMs?: number;
}

export class BrokerClient {
  private socket: Socket | null = null;
  private readonly splitter = new FrameSplitter();
  private pendingList: ((s: BrokerSessionInfo[]) => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly opts: BrokerClientOptions) {}

  /** Connect (spawning the broker if absent) and return the sessions the broker
   *  already has alive (re-adoption payload from `welcome`). */
  async connect(): Promise<BrokerSessionInfo[]> {
    const attempts = this.opts.connectAttempts ?? 40;
    const retryMs = this.opts.connectRetryMs ?? 100;
    let spawned = false;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.tryConnectOnce();
      } catch {
        if (!spawned && this.opts.spawnBrokerIfAbsent) { this.opts.spawnBrokerIfAbsent(); spawned = true; }
        await delay(retryMs);
      }
    }
    throw new Error(`could not connect to PTY broker at ${this.opts.socketPath}`);
  }

  private tryConnectOnce(): Promise<BrokerSessionInfo[]> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(this.opts.socketPath);
      socket.setEncoding('utf8');
      let settled = false;
      const onErr = (e: Error): void => { if (!settled) { settled = true; reject(e); } };
      socket.once('error', onErr);
      socket.once('connect', () => {
        this.socket = socket;
        socket.removeListener('error', onErr);
        socket.on('error', () => this.handleDisconnect());
        socket.on('close', () => this.handleDisconnect());
        socket.on('data', (chunk: string) => this.onSocketData(chunk, resolve, () => settled = true, () => settled));
        this.send({ t: 'hello', clientId: this.opts.clientId, protocolVersion: PROTOCOL_VERSION });
        this.startPing();
      });
    });
  }

  private onSocketData(chunk: string, resolveWelcome: (s: BrokerSessionInfo[]) => void, markSettled: () => void, isSettled: () => boolean): void {
    let lines: string[];
    try { lines = this.splitter.push(chunk); } catch { this.socket?.destroy(); return; }
    for (const line of lines) {
      const msg = parseBrokerMessage(line);
      if (!msg) continue;
      switch (msg.t) {
        case 'welcome': if (!isSettled()) { markSettled(); resolveWelcome(msg.sessions); } break;
        case 'sessions': { const cb = this.pendingList; this.pendingList = null; cb?.(msg.sessions); break; }
        case 'data': this.opts.handlers.onData(msg.sessionId, Buffer.from(msg.data, 'base64')); break;
        case 'history': this.opts.handlers.onHistory(msg.sessionId, Buffer.from(msg.data, 'base64')); break;
        case 'exit': this.opts.handlers.onExit(msg.sessionId, msg.exitCode); break;
        case 'spawned': case 'spawnError': case 'pong': break;
      }
    }
  }

  spawn(spec: BrokerSpawnSpec): void { this.send({ t: 'spawn', spec }); }
  write(sessionId: string, data: Buffer): void { this.send({ t: 'write', sessionId, data: data.toString('base64') }); }
  resize(sessionId: string, cols: number, rows: number): void { this.send({ t: 'resize', sessionId, cols, rows }); }
  kill(sessionId: string, signal = 'SIGTERM', remove = false): void { this.send({ t: 'kill', sessionId, signal, remove }); }
  killPrefix(prefix: string): void { this.send({ t: 'killPrefix', prefix }); }
  /** Ask the broker to kill everything and exit (explicit app quit). */
  shutdownBroker(): void { this.send({ t: 'shutdown' }); }

  /** Request the current session list. Single in-flight; later callers replace the earlier. */
  list(): Promise<BrokerSessionInfo[]> {
    return new Promise((resolve) => { this.pendingList = resolve; this.send({ t: 'list' }); });
  }

  /** Close the client connection WITHOUT killing PTYs (node-server shutdown that
   *  should leave the broker + terminals alive — the survival path). */
  close(): void {
    this.closed = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.socket?.destroy();
    this.socket = null;
  }

  private send(msg: ClientMessage): void {
    try { this.socket?.write(encodeFrame(msg)); } catch { /* dropped; onDisconnect fires */ }
  }

  private startPing(): void {
    const period = this.opts.pingIntervalMs ?? 10_000;
    if (period <= 0) return;
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), period);
    this.pingTimer.unref();
  }

  private handleDisconnect(): void {
    if (this.closed) return;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.socket = null;
    this.opts.handlers.onDisconnect?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
}
