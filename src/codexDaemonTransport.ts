// HS-9388 (docs/121 §121.6) — the codex app-server DAEMON transport: instead of a
// private stdio child, the drive connects to the shared `codex app-server` daemon
// over its control UDS, so other app-server clients (the VS Code codex extension,
// the Codex desktop app, a `codex --remote`-attached TUI — HS-9394) can attach to
// the SAME driven thread and watch it live.
//
// Wire shape (HS-9386, live-verified on 0.145.0): the socket speaks WebSocket
// (HTTP Upgrade + frames — NOT raw JSONL; `app-server proxy` just bridges bytes),
// one JSON-RPC message per frame. Two handshake caveats or the daemon hangs up:
// `perMessageDeflate: false` and a plain `host` header.

import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

/** The one interface `codexAppServer.ts` drives sessions through — stdio child and
 *  daemon UDS-WS both implement it. Messages are whole serialized JSON-RPC strings
 *  (a trailing newline from the JSONL builders is tolerated on both). */
export interface CodexTransport {
  kind: 'stdio' | 'daemon';
  send: (json: string) => void;
  close: () => void;
}

export interface CodexTransportHandlers {
  /** One incoming JSON-RPC message (unparsed text). */
  onMessage: (text: string) => void;
  /** The connection/process ended (fired at most once). */
  onClose: () => void;
}

export interface ConnectCodexDaemonDeps {
  /** Injectable for tests. Defaults to `child_process.spawn` of `codex app-server daemon start`. */
  startDaemon?: () => Promise<boolean>;
  /** Injectable for tests. Defaults to a real `ws` UDS connection attempt. */
  openSocket?: (handlers: CodexTransportHandlers) => Promise<CodexTransport | null>;
  /** Injectable for tests (a temp UDS). Defaults to `codexDaemonSocketPath()`. */
  socketPath?: string;
}

/** The daemon's control socket (fixed location, codex-cli 0.145.0). */
export function codexDaemonSocketPath(): string {
  return join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
}

/** One WS connection attempt against the UDS. Resolves null on any failure
 *  (missing socket, refused upgrade, timeout) — never throws. */
function openDaemonSocket(handlers: CodexTransportHandlers, socketPath: string): Promise<CodexTransport | null> {
  return new Promise((resolve) => {
    let settled = false;
    let closed = false;
    let ws: WebSocket;
    try {
      // HS-9386 — `ws+unix://<sock>:/`; deflate off + plain host or the upgrade dies.
      ws = new WebSocket(`ws+unix://${socketPath}:/`, {
        perMessageDeflate: false,
        headers: { host: 'localhost' },
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.terminate(); } catch { /* ignore */ } resolve(null); }
    }, 3000);
    timer.unref();
    const emitClose = (): void => {
      if (closed) return;
      closed = true;
      handlers.onClose();
    };
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        kind: 'daemon',
        send: (json: string) => { try { ws.send(json.trimEnd()); } catch { /* dying socket — close handler cleans up */ } },
        close: () => { try { ws.close(); } catch { /* ignore */ } },
      });
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      handlers.onMessage(typeof data === 'string' ? data : (data as Buffer).toString('utf-8'));
    });
    ws.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      else emitClose();
    });
    ws.on('close', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      else emitClose();
    });
  });
}

/** `codex app-server daemon start` — idempotent (an already-running daemon just
 *  reports its status). Resolves once the command exits; false on spawn failure /
 *  non-zero exit. The env marker is belt-and-braces: the per-thread MCP override
 *  (`buildThreadMcpOverride`) is the authoritative marker path, but a daemon WE
 *  start also carries it for any config that bypasses the override. */
function startDaemonProcess(): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('codex', ['app-server', 'daemon', 'start'], {
        env: { ...process.env, HOTSHEET_DRIVE_SPAWNED: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(false); }, 20_000);
    timer.unref();
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/**
 * Connect to the shared codex daemon, starting it if it isn't running.
 * Sequence: try the socket → on failure `codex app-server daemon start` → retry
 * the socket (twice, spaced out — the freshly-started daemon needs a beat to
 * bind). Resolves null when the daemon can't be reached at all; the caller
 * (`codexAppServer.ts`) falls back to the private stdio child.
 */
export async function connectCodexDaemon(handlers: CodexTransportHandlers, deps: ConnectCodexDaemonDeps = {}): Promise<CodexTransport | null> {
  const sockPath = deps.socketPath ?? codexDaemonSocketPath();
  const open = deps.openSocket ?? ((h: CodexTransportHandlers) => openDaemonSocket(h, sockPath));
  const start = deps.startDaemon ?? startDaemonProcess;
  const first = await open(handlers);
  if (first !== null) return first;
  if (!await start()) return null;
  for (const delayMs of [250, 1500]) {
    await new Promise((r) => { const t = setTimeout(r, delayMs); t.unref(); });
    const attempt = await open(handlers);
    if (attempt !== null) return attempt;
  }
  return null;
}
