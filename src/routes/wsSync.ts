// HS-7945 / HS-8979 — the `/ws/sync` WebSocket endpoint (docs/93 §93.3 + §93.7).
// Pushes the event bus (HS-8978) to connected clients in place of the
// `/api/poll` long-poll for multi-client deployments. Reuses the exact
// transport already proven for terminal PTYs (`src/terminals/websocket.ts`):
// one `ws` WebSocketServer in `noServer` mode sharing the HTTP port via
// `httpServer.on('upgrade')`.
//
// Wire shape:
//   server → client: `{type:'connected', seq}` (baseline) on open; each bus
//     `SyncEvent` (carries `seq`); `{type:'ping'}` every 20s; `{type:'resync'}`
//     when a `?since=` catch-up is too far behind the ring.
//   client → server: `{type:'pong'}` (heartbeat reply).
//
// The client dedups by `seq` (applies only seq > last-applied), so the small
// replay/live overlap window on reconnect is harmless.

import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { parse as parseUrl } from 'url';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { getProjectBySecret } from '../projects.js';
import { coalesceEvents } from '../sync/coalesce.js';
import { eventBus, getEventsSince, registerSyncSink } from '../sync/eventBus.js';
import { isRequestTrusted } from '../trusted-origin.js';

const WS_PATH = '/ws/sync';
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_MISSED_HEARTBEATS = 2;
const SECRET_SUBPROTOCOL_PREFIX = 'hotsheet-secret-';

export interface WireSyncOptions {
  exposed: boolean;
  trustedOrigins: string[];
}

export interface SyncAuthOk { ok: true; secret: string; since: number | undefined }
export interface SyncAuthFail { ok: false; status: number; reason: string }

/** Live sync sockets, tracked so graceful shutdown can close them before the
 *  HTTP server stops (so `gracefulShutdown` doesn't wait on open sockets). */
const openSockets = new Set<WebSocket>();

/** Attach the `/ws/sync` upgrade handler to the shared HTTP server. */
export function wireSyncWebSocket(httpServer: HttpServer, options: WireSyncOptions): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    // Echo back the `hotsheet-secret-<X>` subprotocol so a browser that
    // authenticated via the subprotocol (not the URL) completes the handshake.
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p.startsWith(SECRET_SUBPROTOCOL_PREFIX)) return p;
      return false;
    },
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith(WS_PATH)) return; // not ours — leave it for other upgrade handlers (terminal WS)

    const auth = authenticateSync(req, options);
    if (!auth.ok) {
      reject(socket, auth.status, auth.reason);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleSyncConnection(ws, auth.secret, auth.since);
    });
  });

  // HS-7931 — when the HTTP server closes during graceful shutdown, terminate
  // every live sync socket so nothing keeps the process (or the close) hanging.
  httpServer.on('close', () => {
    for (const ws of [...openSockets]) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
  });
}

/** Authenticate the upgrade: a valid per-project secret is mandatory (no open
 *  path). On an exposed server, a *present* Origin must additionally be trusted
 *  (blocks a browser on an untrusted origin even if it somehow has the secret;
 *  a non-browser client with no Origin + a valid secret is still allowed, same
 *  as the HTTP secret-header path). HS-7940 / §93.7. */
export function authenticateSync(req: IncomingMessage, options: WireSyncOptions): SyncAuthOk | SyncAuthFail {
  const url = parseUrl(req.url ?? '', true);
  const headerSecret = readHeader(req, 'x-hotsheet-secret');
  const queryParam = typeof url.query.project === 'string' ? url.query.project : undefined;
  const subprotoSecret = readSubprotocolSecret(req);
  const secret = (headerSecret ?? queryParam ?? subprotoSecret ?? '').trim();
  if (secret === '') {
    return { ok: false, status: 403, reason: 'Missing secret (?project=, X-Hotsheet-Secret, or hotsheet-secret-<secret> subprotocol)' };
  }
  const project = getProjectBySecret(secret);
  if (!project) return { ok: false, status: 403, reason: 'Secret does not match any registered project' };

  if (options.exposed) {
    const origin = readHeader(req, 'origin');
    if (origin !== undefined && origin !== '' && !isRequestTrusted(origin, undefined, options.trustedOrigins)) {
      return { ok: false, status: 403, reason: 'Untrusted origin' };
    }
  }

  return { ok: true, secret, since: parseSince(url.query.since) };
}

function handleSyncConnection(ws: WebSocket, secret: string, since: number | undefined): void {
  openSockets.add(ws);

  // Baseline: tell the client the current seq so it knows where the stream
  // starts (and can detect gaps against its own last-applied seq).
  sendJson(ws, { type: 'connected', seq: eventBus.currentSeq(secret) });

  // Register the live sink FIRST so no event emitted during catch-up is missed.
  // Replayed + live events may overlap by a few seq; the client dedups by seq.
  const unregister = registerSyncSink(secret, (event) => sendJson(ws, event));

  // Catch-up: a reconnecting client passes `?since=<lastSeq>`. Replay the tail,
  // or tell it to refetch when it's fallen behind the ring. A fresh client
  // (no `since`) has just loaded state over HTTP, so it only needs live events.
  if (since !== undefined) {
    const { evicted, events } = getEventsSince(secret, since);
    if (evicted) sendJson(ws, { type: 'resync' });
    // HS-8982 — a far-behind client can be owed up to the full ring; coalesce
    // same-type runs into batch-operation frames so the catch-up isn't hundreds
    // of individual frames. The client tracks `seq` either way.
    else for (const event of coalesceEvents(events)) sendJson(ws, event);
  }

  // Heartbeat: ping every 20s, reset on pong, close after 2 unanswered pings.
  let missed = 0;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (missed >= MAX_MISSED_HEARTBEATS) { ws.terminate(); return; }
    missed++;
    sendJson(ws, { type: 'ping' });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  ws.on('message', (data) => {
    let raw: unknown;
    try { raw = JSON.parse(normalizeMessage(data)); } catch { return; }
    if (raw !== null && typeof raw === 'object' && (raw as { type?: unknown }).type === 'pong') missed = 0;
  });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unregister();
    openSockets.delete(ws);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Extract the secret from a `hotsheet-secret-<X>` value in `Sec-WebSocket-Protocol`. */
function readSubprotocolSecret(req: IncomingMessage): string | undefined {
  const header = readHeader(req, 'sec-websocket-protocol');
  if (header === undefined) return undefined;
  for (const part of header.split(',')) {
    const p = part.trim();
    if (p.startsWith(SECRET_SUBPROTOCOL_PREFIX)) return p.slice(SECRET_SUBPROTOCOL_PREFIX.length);
  }
  return undefined;
}

/** Parse `?since=` into a non-negative integer, or undefined when absent/invalid. */
function parseSince(v: unknown): number | undefined {
  const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  if (s === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function normalizeMessage(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof Buffer) return data.toString('utf8');
  // Remaining branch is ArrayBuffer — same cast the sibling terminal WS uses.
  return Buffer.from(data as ArrayBuffer).toString('utf8');
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
