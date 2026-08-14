/**
 * HS-9662 / docs/136 — the PTY-broker control protocol.
 *
 * The broker is a detached process that OWNS every terminal's node-pty (so the
 * PTYs survive an accidental node-server death). The node server talks to it over
 * a unix-domain socket using newline-delimited JSON frames; binary PTY bytes ride
 * as base64 in `data`/`history` fields. `sessionId` is the registry's stable
 * `secret::terminalId` key — the same value across a server restart, which is what
 * lets a fresh server RE-ADOPT the broker's still-live sessions.
 *
 * This module is PURE (types + encode/decode/frame-split only) so it is fully
 * unit-testable without a socket or a real PTY. The process + client live in
 * `ptyBroker.ts` / `brokerClient.ts`.
 */

/** Spawn parameters the broker needs to create a PTY (mirrors registry `SpawnArgs`
 *  but env is a plain record for JSON transport). `sessionId` keys the session. */
export interface BrokerSpawnSpec {
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  /** Opaque identity the broker stores + echoes back on `sessions` so the server
   *  can rebuild a dynamic terminal's tab after a restart (docs/136 §136.5). */
  meta?: Record<string, unknown>;
}

/** One live session as the broker reports it (in `welcome` / `sessions`). */
export interface BrokerSessionInfo {
  sessionId: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  cols: number;
  rows: number;
  command: string;
  startedAt: number;
  meta?: Record<string, unknown>;
}

/** Node server → broker. */
export type ClientMessage =
  /** First frame after connect. `clientId` identifies the server instance; the
   *  broker (re)starts its client-lease timer keyed off any connected client. */
  | { t: 'hello'; clientId: string; protocolVersion: number }
  | { t: 'spawn'; spec: BrokerSpawnSpec }
  | { t: 'write'; sessionId: string; data: string /* base64 */ }
  | { t: 'resize'; sessionId: string; cols: number; rows: number }
  /** Explicit kill (user Stop/close). `remove` drops the session record entirely
   *  (close a tab / destroy); without it the session stays as `exited`. */
  | { t: 'kill'; sessionId: string; signal?: string; remove?: boolean }
  /** Kill every session whose id starts with `prefix` (project-tab close). */
  | { t: 'killPrefix'; prefix: string }
  /** Ask for the current session list (server startup re-adoption). */
  | { t: 'list' }
  /** Keep the client lease alive. */
  | { t: 'ping' }
  /** Explicit broker shutdown (app quit): kill all PTYs and exit. */
  | { t: 'shutdown' };

/** Broker → node server. */
export type BrokerMessage =
  /** Reply to `hello`: the sessions already alive (re-adoption payload). */
  | { t: 'welcome'; protocolVersion: number; sessions: BrokerSessionInfo[] }
  | { t: 'sessions'; sessions: BrokerSessionInfo[] }
  /** Confirms a spawn (or reports it failed). */
  | { t: 'spawned'; sessionId: string; pid: number; startedAt: number }
  | { t: 'spawnError'; sessionId: string; message: string }
  /** Live PTY output. */
  | { t: 'data'; sessionId: string; data: string /* base64 */ }
  /** Full scrollback for a session (sent once right after `welcome`/spawn so a
   *  re-adopting server can replay history to reconnecting clients). */
  | { t: 'history'; sessionId: string; data: string /* base64 */ }
  | { t: 'exit'; sessionId: string; exitCode: number }
  | { t: 'pong' };

export const PROTOCOL_VERSION = 1;

/** Encode a message as one newline-delimited JSON frame. */
export function encodeFrame(msg: ClientMessage | BrokerMessage): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Stateful newline frame splitter for a socket byte stream. Feed it each chunk;
 * it returns complete lines and buffers the partial tail. Robust to a frame
 * arriving across multiple chunks or several frames in one chunk.
 */
export class FrameSplitter {
  private buf = '';
  /** Cap so a peer that never sends a newline can't grow the buffer unbounded. */
  constructor(private readonly maxBufferBytes = 64 * 1024 * 1024) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    if (this.buf.length > this.maxBufferBytes) {
      this.buf = '';
      throw new Error(`FrameSplitter buffer exceeded ${String(this.maxBufferBytes)} bytes without a newline`);
    }
    const out: string[] = [];
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length > 0) out.push(line);
      nl = this.buf.indexOf('\n');
    }
    return out;
  }
}

/** Parse one frame line into a client message, or null if malformed / wrong shape. */
export function parseClientMessage(line: string): ClientMessage | null {
  const obj = safeParse(line);
  if (obj === null || typeof (obj as { t?: unknown }).t !== 'string') return null;
  return obj as ClientMessage;
}

/** Parse one frame line into a broker message, or null if malformed / wrong shape. */
export function parseBrokerMessage(line: string): BrokerMessage | null {
  const obj = safeParse(line);
  if (obj === null || typeof (obj as { t?: unknown }).t !== 'string') return null;
  return obj as BrokerMessage;
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
