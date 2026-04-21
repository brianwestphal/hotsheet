import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { parse as parseUrl } from 'url';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { getProjectBySecret } from '../projects.js';
import { getDynamicTerminalConfig } from '../routes/terminal.js';
import { DEFAULT_TERMINAL_ID } from './config.js';
import { attach, detach, resizeTerminal, type TerminalSubscriber, writeInput } from './registry.js';

const WS_PATH = '/api/terminal/ws';

type ControlMessage =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }
  | { type: 'ping' };

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
      handleConnection(ws, authResult.secret, authResult.dataDir, authResult.terminalId);
    });
  });
}

export interface AuthOk { ok: true; secret: string; dataDir: string; terminalId: string }
export interface AuthFail { ok: false; status: number; reason: string }

export function authenticate(req: IncomingMessage): AuthOk | AuthFail {
  const headerSecret = readHeader(req, 'x-hotsheet-secret');
  const url = parseUrl(req.url ?? '', true);
  const queryParam = typeof url.query.project === 'string' ? url.query.project : undefined;
  const secret = (headerSecret ?? queryParam ?? '').trim();
  if (secret === '') return { ok: false, status: 403, reason: 'Missing X-Hotsheet-Secret header or ?project= query param' };
  const project = getProjectBySecret(secret);
  if (!project) return { ok: false, status: 403, reason: 'Secret does not match any registered project' };
  const termQuery = typeof url.query.terminal === 'string' && url.query.terminal !== ''
    ? url.query.terminal
    : DEFAULT_TERMINAL_ID;
  return { ok: true, secret, dataDir: project.dataDir, terminalId: termQuery };
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

function handleConnection(ws: WebSocket, secret: string, dataDir: string, terminalId: string): void {
  const subscriber: TerminalSubscriber = {
    onData(chunk) {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk, { binary: true });
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
    result = attach(secret, dataDir, subscriber, { configOverride }, terminalId);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
    ws.close(1011, 'attach failed');
    return;
  }

  // First frame: history replay (even if empty, so the client knows attach succeeded).
  ws.send(JSON.stringify({
    type: 'history',
    bytes: result.history.toString('base64'),
    alive: result.alive,
    exitCode: result.exitCode,
    cols: result.cols,
    rows: result.rows,
    command: result.command,
  }));

  ws.on('message', (data, isBinary) => {
    const text = normalizeMessage(data);
    if (isBinary) {
      writeInput(secret, text, terminalId);
      return;
    }
    // Text frame — parse as control JSON
    try {
      const msg = JSON.parse(text) as ControlMessage;
      handleControl(ws, secret, msg, terminalId);
    } catch {
      // Invalid JSON — ignore silently
    }
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
