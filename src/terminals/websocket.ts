import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { parse as parseUrl } from 'url';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

import { instrumentSync } from '../diagnostics/freezeLogger.js';
import { getProjectBySecret } from '../projects.js';
import { getDynamicTerminalConfig } from '../routes/terminal.js';
import { DEFAULT_TERMINAL_ID } from './config.js';
import { attach, detach, resizeTerminal, type TerminalSubscriber, writeInput } from './registry.js';

const WS_PATH = '/api/terminal/ws';

// HS-8192 — schema validates inbound text-frame control messages. Pre-fix
// the handler did `JSON.parse(text) as ControlMessage` with a raw `as` cast,
// so a malformed payload (wrong type literal, missing cols/rows on a resize,
// negative dims) silently fell through `handleControl`'s permissive guards.
// Centralising the schema rejects bad shapes before they reach the dispatcher.
const ControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resize'), cols: z.number().positive(), rows: z.number().positive() }),
  z.object({ type: z.literal('kill') }),
  z.object({ type: z.literal('ping') }),
]);

type ControlMessage = z.infer<typeof ControlMessageSchema>;

/**
 * Attach a WebSocket upgrade handler to an existing http.Server for the
 * embedded-terminal endpoint. One ws.Server instance in `noServer: true` mode
 * shares the HTTP port.
 */
export function wireTerminalWebSocket(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith(WS_PATH)) return;  // not ours — leave it for other upgrade handlers

    const authResult = authenticate(req);
    if (!authResult.ok) {
      reject(socket, authResult.status, authResult.reason);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleConnection(ws, authResult.secret, authResult.dataDir, authResult.terminalId, authResult.cols, authResult.rows, authResult.noSpawn);
    });
  });
}

export interface AuthOk { ok: true; secret: string; dataDir: string; terminalId: string; cols: number | undefined; rows: number | undefined; noSpawn: boolean }
export interface AuthFail { ok: false; status: number; reason: string }

export function authenticate(req: IncomingMessage): AuthOk | AuthFail {
  const headerSecret = readHeader(req, 'x-hotsheet-secret');
  const url = parseUrl(req.url ?? '', true);
  const queryParam = typeof url.query.project === 'string' ? url.query.project : undefined;
  const secret = (headerSecret ?? queryParam ?? '').trim();
  // HS-7940 audit (docs/46 §46.5): the terminal WebSocket requires a valid
  // per-project secret UNCONDITIONALLY — there is no open path. That already
  // satisfies "reject connections from untrusted origins that don't carry the
  // secret": the no-secret arm below rejects every origin (trusted or not), and
  // a connection presenting a valid secret is an authorized client regardless of
  // origin (a cross-site page can't read the secret, so it can't forge one). So
  // exposing the server via `--bind` doesn't widen terminal access. No origin
  // gate is added here — it would only break a legitimate remote client whose
  // browser sends its own (configured-trusted) Origin.
  if (secret === '') return { ok: false, status: 403, reason: 'Missing X-Hotsheet-Secret header or ?project= query param' };
  const project = getProjectBySecret(secret);
  if (!project) return { ok: false, status: 403, reason: 'Secret does not match any registered project' };
  const termQuery = typeof url.query.terminal === 'string' && url.query.terminal !== ''
    ? url.query.terminal
    : DEFAULT_TERMINAL_ID;
  // HS-6799: clients send their post-fit xterm dims here so the server can
  // spawn / resize the PTY to match *before* emitting the history frame.
  // Without this the PTY runs at DEFAULT 80×24 until the first resize message
  // arrives on the open socket, and the startup output is all laid out for
  // 80×24 — which leaves stray chars at the top of the client pane.
  return {
    ok: true,
    secret,
    dataDir: project.dataDir,
    terminalId: termQuery,
    cols: parsePositiveInt(url.query.cols),
    rows: parsePositiveInt(url.query.rows),
    // HS-8218 — `noSpawn=1` tells `attach` to skip the create-session +
    // spawn-PTY path when no live session exists, returning `noSession: true`.
    noSpawn: url.query.noSpawn === '1',
  };
}

function parsePositiveInt(v: unknown): number | undefined {
  const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  if (s === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function handleConnection(ws: WebSocket, secret: string, dataDir: string, terminalId: string, cols: number | undefined, rows: number | undefined, noSpawn: boolean): void {
  const subscriber: TerminalSubscriber = {
    onData(chunk) {
      if (ws.readyState === ws.OPEN) {
        // HS-8160 — wrap PTY → client send so a slow socket flush
        // shows up in freeze.log tagged `ws.send:pty-output:<id>`.
        instrumentSync(dataDir, `ws.send:pty-output:${terminalId}`, () => {
          ws.send(chunk, { binary: true });
        });
      }
    },
    onExit(exitCode) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      }
    },
  };

  let result;
  try {
    const configOverride = getDynamicTerminalConfig(secret, terminalId) ?? undefined;
    result = attach(secret, dataDir, subscriber, { configOverride, cols, rows, noSpawn }, terminalId);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
    ws.close(1011, 'attach failed');
    return;
  }

  // First frame: history replay (even if empty, so the client knows attach succeeded).
  // HS-8218 — when `noSession: true` (caller asked for noSpawn and no live
  // session existed), include the flag so the client can fall back without
  // having to infer it from `alive: false` (an exited session also has
  // `alive: false` but it has scrollback the consumer wants to see).
  ws.send(JSON.stringify({
    type: 'history',
    bytes: result.history.toString('base64'),
    alive: result.alive,
    exitCode: result.exitCode,
    cols: result.cols,
    rows: result.rows,
    command: result.command,
    noSession: result.noSession === true ? true : undefined,
  }));

  if (result.noSession === true) {
    // HS-8218 — no subscriber added (no session to subscribe to). Close
    // the socket cleanly so the client doesn't sit on a dead WS. The
    // close-code 1000 (normal closure) signals "intentional, do not
    // reconnect" to the client-side `terminalCheckout` reconnect path.
    try { ws.close(1000, 'no-session'); } catch { /* ignore */ }
    return;
  }

  ws.on('message', (data, isBinary) => {
    const text = normalizeMessage(data);
    if (isBinary) {
      // HS-8160 — wrap the binary-message → pty.write path. A slow
      // pty.write (Node-pty back-pressure, kernel pipe full, etc.)
      // shows up in freeze.log tagged `pty.write:from-ws:<id>`.
      instrumentSync(dataDir, `pty.write:from-ws:${terminalId}`, () => {
        writeInput(secret, text, terminalId);
      });
      return;
    }
    // Text frame — parse + validate as control JSON. HS-8192: schema
    // validation rejects bad shapes (unknown `type`, missing/negative dims)
    // before they hit `handleControl`'s dispatch.
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return; /* invalid JSON — ignore silently */ }
    const validated = ControlMessageSchema.safeParse(raw);
    if (!validated.success) return; /* wrong shape — ignore silently */
    const msg = validated.data;
    // HS-8160 — wrap the control-message handler. Resize frames
    // call into node-pty's resize which can block while the kernel
    // services SIGWINCH; long handlers tag freeze.log.
    instrumentSync(dataDir, `ws.message:control:${msg.type}:${terminalId}`, () => {
      handleControl(ws, secret, msg, terminalId);
    });
  });

  ws.on('close', () => { detach(secret, subscriber, terminalId); });
  ws.on('error', () => { detach(secret, subscriber, terminalId); });
}

/** Normalize a ws message (Buffer | ArrayBuffer | Buffer[]) into a utf8 string. */
function normalizeMessage(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof Buffer) return data.toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function handleControl(ws: WebSocket, secret: string, msg: ControlMessage, terminalId: string): void {
  switch (msg.type) {
    case 'resize':
      if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows) && msg.cols > 0 && msg.rows > 0) {
        resizeTerminal(secret, Math.floor(msg.cols), Math.floor(msg.rows), terminalId);
      }
      break;
    case 'kill':
      // We don't expose `kill` via the socket to avoid letting an untrusted client
      // destroy state. The HTTP POST /api/terminal/kill endpoint is the canonical path.
      break;
    case 'ping':
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}
