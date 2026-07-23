// HS-9388 — daemon transport tests: the connect/start/retry ladder (injected fakes)
// plus a REAL UDS WebSocket round-trip against an in-test `ws` server standing in
// for the codex daemon (validates the `ws+unix://<sock>:/` form + frame handling).
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import { homedir,tmpdir  } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket as ServerWebSocket,WebSocketServer } from 'ws';

import {
  codexDaemonSocketPath,
  type CodexTransport,
  type CodexTransportHandlers,
  connectCodexDaemon,
} from './codexDaemonTransport.js';

const NOOP_HANDLERS: CodexTransportHandlers = { onMessage: () => { /* noop */ }, onClose: () => { /* noop */ } };

describe('codexDaemonSocketPath', () => {
  it('points at the fixed 0.145.0 control socket under ~/.codex', () => {
    expect(codexDaemonSocketPath()).toBe(join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock'));
  });
});

describe('connectCodexDaemon — connect/start/retry ladder', () => {
  const fakeTransport: CodexTransport = { kind: 'daemon', send: vi.fn(), close: vi.fn() };

  it('returns the first successful connection without starting the daemon', async () => {
    const openSocket = vi.fn().mockResolvedValue(fakeTransport);
    const startDaemon = vi.fn();
    expect(await connectCodexDaemon(NOOP_HANDLERS, { openSocket, startDaemon })).toBe(fakeTransport);
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it('starts the daemon when the socket is unreachable, then retries and connects', async () => {
    const openSocket = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fakeTransport);
    const startDaemon = vi.fn().mockResolvedValue(true);
    expect(await connectCodexDaemon(NOOP_HANDLERS, { openSocket, startDaemon })).toBe(fakeTransport);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(openSocket).toHaveBeenCalledTimes(3);
  });

  it('gives up (→ stdio fallback) when the daemon cannot be started', async () => {
    const openSocket = vi.fn().mockResolvedValue(null);
    const startDaemon = vi.fn().mockResolvedValue(false);
    expect(await connectCodexDaemon(NOOP_HANDLERS, { openSocket, startDaemon })).toBeNull();
    expect(openSocket).toHaveBeenCalledTimes(1); // no retries when start failed
  });

  it('gives up after the retry budget even when the daemon claims to have started', async () => {
    const openSocket = vi.fn().mockResolvedValue(null);
    const startDaemon = vi.fn().mockResolvedValue(true);
    expect(await connectCodexDaemon(NOOP_HANDLERS, { openSocket, startDaemon })).toBeNull();
    expect(openSocket).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe('connectCodexDaemon — real UDS WebSocket round-trip', () => {
  let dir: string;
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    wss?.close();
    await new Promise<void>((r) => {
      if (server !== null) server.close(() => { r(); });
      else r();
    });
    server = null;
    wss = null;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in daemon: a WS server bound to a temp UDS that records frames and
   *  can push frames back. Null when the environment denies UDS binds (some
   *  sandboxes) — the caller skips. */
  async function listenOnUds(): Promise<{ sockPath: string; received: string[]; clients: ServerWebSocket[] } | null> {
    dir = mkdtempSync(join(tmpdir(), 'hs-uds-'));
    const sockPath = join(dir, 'd.sock');
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on('error', () => { /* surfaced via the server 'error' listener below */ });
    const received: string[] = [];
    const clients: ServerWebSocket[] = [];
    wss.on('connection', (client) => {
      clients.push(client);
      client.on('message', (data) => { received.push(Buffer.isBuffer(data) ? data.toString('utf-8') : ''); });
    });
    const bound = await new Promise<boolean>((r) => {
      server!.once('error', () => { r(false); });
      try { server!.listen(sockPath, () => { r(true); }); }
      catch { r(false); } // some sandboxes throw EPERM synchronously from listen()
    });
    return bound ? { sockPath, received, clients } : null;
  }

  it('connects over ws+unix, exchanges frames both ways, and surfaces server close via onClose', async (ctx) => {
    const uds = await listenOnUds();
    if (uds === null) { ctx.skip(); return; }
    const { sockPath, received, clients } = uds;
    const messages: string[] = [];
    let closed = false;
    const transport = await connectCodexDaemon(
      { onMessage: (t) => { messages.push(t); }, onClose: () => { closed = true; } },
      { socketPath: sockPath },
    );
    expect(transport?.kind).toBe('daemon');

    // Outbound: a JSONL builder line (trailing newline) arrives as one clean frame.
    transport!.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    await vi.waitFor(() => { expect(received).toHaveLength(1); });
    expect(received[0]).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');

    // Inbound: one server frame → one onMessage.
    clients[0].send('{"jsonrpc":"2.0","method":"turn/started","params":{}}');
    await vi.waitFor(() => { expect(messages).toHaveLength(1); });

    // Server-side close (daemon stopped) → onClose so the session tears down.
    clients[0].close();
    await vi.waitFor(() => { expect(closed).toBe(true); });
  });

  it('resolves null (never throws) when nothing listens on the socket and starting is a no-op', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hs-uds-'));
    const transport = await connectCodexDaemon(NOOP_HANDLERS, {
      socketPath: join(dir, 'nothing-here.sock'),
      startDaemon: () => Promise.resolve(false),
    });
    expect(transport).toBeNull();
  });
});
