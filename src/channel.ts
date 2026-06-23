#!/usr/bin/env node
/**
 * Hot Sheet Channel Server for Claude Code.
 * MCP server that bridges Hot Sheet UI → Claude Code session.
 * Spawned by Claude Code as a subprocess via .mcp.json.
 */

/** Bump this when changing channel server capabilities (endpoints, protocol, etc.).
 *  The main server compares this against the running channel server's reported version
 *  and warns if they don't match (user needs to reconnect via /mcp in Claude Code). */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { z } from 'zod';

import { callTool, listTools } from './channel.tools.js';
import { slugifyDataDir } from './channel-config.js';
import { createChannelLogger } from './channelLog.js';
import {
  clearAllPermissions,
  completePermission,
  enqueuePermission,
  peekPending,
} from './channelPermissions.js';
import { maybeUnlinkPortFile, writeChannelInfo } from './channelPortFile.js';
import { installPortFileWatcher } from './channelPortFileWatcher.js';
import {
  listAliveEntries,
  pickLeader,
  registerSelf,
  unregisterSelf,
} from './channelRegistry.js';
import { installStdioDisconnectHandler } from './channelStdioWatcher.js';
import { HotsheetSettingsSchema } from './schemas.js';

// HS-8346 — bumped from 4 → 5 for the new MCP tool surface (tools/list +
// tools/call handlers exposing hotsheet_update_ticket / hotsheet_create_ticket /
// hotsheet_signal_done / hotsheet_add_attachment / hotsheet_request_feedback).
// HS-8347 — bumped from 5 → 6 for the Phase 2 expansion (9 more tools:
// hotsheet_get_ticket / delete_ticket / restore_ticket / toggle_up_next /
// duplicate_tickets / batch / edit_note / delete_note / query_tickets).
// HS-8349 — bumped from 6 → 7 for the Phase 4 multi-project tool naming
// (`.mcp.json` key + Server({name}) are now per-project `hotsheet-channel-<slug>`).
// HS-8454 — bumped from 7 → 8 for the richer `/health` echo body
// (`{ok, version, pid, slug, startedAt}`) + the port-file JSON shape via
// `writeChannelInfo` + the startup-time collision lock that defers when
// an existing channel server is alive for the same dataDir.
// HS-8460 — bumped from 8 → 9 for the per-pid registry at
// `<dataDir>/channel-ports.d/<pid>.json`. The single `channel-port`
// file is now a view that always points to the FIFO leader (oldest
// alive by `startedAt`); when the leader exits the next-oldest's
// watcher promotes itself. Fixes the multi-Claude scenario where two
// channel servers fought over the single port file and triggers
// routed to whichever won the duel, not to the Claude the user was
// looking at.
// `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts` bumped in lockstep.
// v10 (HS-8771) — added the `hotsheet_announce` MCP tool (15 tools total).
// v11 (HS-8772) — `hotsheet_announce` gained an optional `diff` input.
// v12 (HS-8862) — added claim/lease tools: `hotsheet_claim_next` /
//   `hotsheet_renew_lease` / `hotsheet_release` (18 tools total).
// v13 (HS-8865) — added `hotsheet_set_blocked_by` (flat dependency gate; 19 tools).
export const CHANNEL_VERSION = 13;

// Parse --data-dir argument
let dataDir = '.hotsheet';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data-dir' && args[i + 1]) {
    dataDir = args[i + 1];
    i++;
  }
}

const portFile = join(dataDir, 'channel-port');
// HS-8349 — derive a per-project slug from the channel server's --data-dir
// so the MCP `Server({name})` matches the per-project `.mcp.json` key
// (`hotsheet-channel-<slug>`). Surfaces the source project in Claude Code's
// tool list when multiple projects are open in the same session.
const serverSlug = slugifyDataDir(dataDir);
const serverName = `hotsheet-channel-${serverSlug}`;
// HS-8454 — captured once at module load so the `/health` echo and the
// `writeChannelInfo` call below report the same value. Used by the main
// server's `isChannelAlive` identity check + by `mcp.log` diagnostics.
const processStartedAt = new Date().toISOString();

// HS-8447 follow-up — append-only diagnostic log at `<dataDir>/mcp.log`
// so unexpected disconnects can be post-mortem'd with `tail` instead of
// having to relaunch Claude Code with stderr-redirect. Every channel-
// server lifecycle event below also gets mirrored here.
const channelLog = createChannelLogger(join(dataDir, 'mcp.log'));
channelLog.log('process-start', `argv=${process.argv.slice(2).join(' ')} dataDir=${dataDir} serverName=${serverName}`);

// Create MCP server with channel capability
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is needed for low-level MCP channel/permission protocol
const mcp = new Server(
  { name: serverName, version: '0.1.0' },
  {
    capabilities: {
      // HS-8346 — declare the `tools` capability so Claude Code knows
      // to send `tools/list` + `tools/call` requests. The handlers are
      // registered below; the tool catalog is defined in
      // `src/channel.tools.ts`.
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'Events from the hotsheet-channel arrive as <channel source="hotsheet-channel">.',
      'When you receive a channel event from hotsheet-channel, follow the instructions in the event content.',
      'Typically this means running /hotsheet to process the current Up Next work items.',
      'Do not ask for confirmation — just execute the requested action.',
      'IMPORTANT: When you finish processing (or if there was nothing to process), you MUST run the curl command provided in the event to signal completion. (Or call the `hotsheet_signal_done` MCP tool — same effect.)',
      'IMPORTANT: Do NOT use the Hot Sheet API (curl commands) to read or list tickets. Always use /hotsheet to read the worklist. The API should only be used for updating ticket status and creating new tickets as documented in the worklist.',
      'HS-8346 / HS-8347: prefer the `hotsheet_*` MCP tools over curl — the tools are schema-validated, project-scoped, and cheaper in tokens. Phase 1 (HS-8346) + Phase 2 (HS-8347) ship 14 tools: hotsheet_update_ticket / hotsheet_create_ticket / hotsheet_get_ticket / hotsheet_delete_ticket / hotsheet_restore_ticket / hotsheet_toggle_up_next / hotsheet_duplicate_tickets / hotsheet_batch / hotsheet_edit_note / hotsheet_delete_note / hotsheet_query_tickets / hotsheet_add_attachment / hotsheet_signal_done / hotsheet_request_feedback.',
    ].join(' '),
  },
);

// HS-8346 — register the MCP tool handlers. `tools/list` returns the
// tool catalog (name + description + JSON Schema); `tools/call`
// dispatches to the per-tool handler defined in `channel.tools.ts`.
mcp.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: listTools() };
});
mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  channelLog.log('tools/call', `name=${name}`);
  const result = await callTool(name, args ?? {}, dataDir);
  // The MCP SDK's `CallToolResult` is a union — one branch requires
  // `task`. Our tools return the standard `{ content, isError? }`
  // branch which is structurally a subset of that union. Cast at the
  // boundary to satisfy the strict union type without leaking the SDK
  // dependency into `channel.tools.ts`.
  return result as unknown as Record<string, unknown>;
});

// HS-8047 — pending permissions live in `channelPermissions.ts` as a queue
// instead of a single nullable slot. Pre-fix a follow-up `permission_request`
// silently overwrote the prior one, vanishing the popup the user was
// looking at and stranding the first request unanswerable from the UI.
// The wire shape on `/permission` is unchanged (returns the head only),
// so no client / main-server changes are needed.

// Connect to Claude Code over stdio
await mcp.connect(new StdioServerTransport());
channelLog.log('mcp-connect', 'StdioServerTransport ready');

// HS-8447 — detect when Claude Code's end of the stdio pipe goes
// away. The MCP SDK's `StdioServerTransport` only listens for 'data'
// + 'error' on stdin and only fires its `onclose` from its explicit
// `close()` method, so on a real disconnect the channel-server keeps
// running with a working HTTP server and a broken stdout pipe — the
// main server's `isChannelAlive` poll returns true (it checks
// `/health`, which is unaffected) and every `/trigger` POST silently
// vanishes into the disconnected stdout. See
// `src/channelStdioWatcher.ts` for the full mechanism.
//
// HS-8447 follow-up — every signal observed by the watcher also gets
// recorded in `<dataDir>/mcp.log` so we can post-mortem the case the
// user reported where the channel-server died while Claude Code's MCP
// client list still thought the channel was connected.
installStdioDisconnectHandler({
  stdin: process.stdin,
  stdout: process.stdout,
  log: (msg) => {
    process.stderr.write(`${serverName}: ${msg}\n`);
    channelLog.log('stdio-watcher', msg);
  },
  onDisconnect: (reason) => {
    channelLog.log('disconnect', `reason=${reason} — invoking cleanup`);
    void cleanup(`stdio-${reason}`);
  },
});

// Handle permission requests from Claude Code
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// HS-8192 — validates the body of `POST /permission/respond`. Pre-fix the
// handler did `JSON.parse(body) as { ... }` with a raw `as` cast — malformed
// JSON or wrong-shape payloads (missing fields, wrong types, unknown
// `behavior` values) propagated silently. Centralising the schema gives the
// handler a clean 400 response on bad input.
const PermissionRespondBodySchema = z.object({
  request_id: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
});

// HS-8567 — schema for `POST /permission/inject`. Mirrors the hand-rolled
// type checks the route previously performed after a raw `as` cast.
const PermissionInjectBodySchema = z.object({
  request_id: z.string().optional(),
  tool_name: z.string().min(1),
  description: z.string(),
  input_preview: z.string(),
}).loose();

mcp.setNotificationHandler(PermissionRequestSchema, ({ params }) => {
  const t0 = Date.now();
  enqueuePermission({
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
    timestamp: t0,
  });
  process.stderr.write(`[perm ${t0}] received: ${params.tool_name} — ${params.description}\n`);
  // Notify main server so the permission long-poll wakes immediately.
  // notifyChange() also wakes permission waiters via notifyPermission().
  void notifyMainServer();
});

// Start HTTP server for Hot Sheet to POST commands
const httpServer = createServer(async (req, res) => {
  // CORS for browser requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // HS-8454 — echo ownership identity so `isChannelAlive` can verify
    // the responder is OUR channel server for this dataDir, not an
    // unrelated process the kernel reassigned the port to, or a
    // different project's channel server on the same port.
    res.end(JSON.stringify({
      ok: true,
      version: CHANNEL_VERSION,
      pid: process.pid,
      slug: serverSlug,
      startedAt: processStartedAt,
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/permission') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // HS-8047 — `peekPending` auto-expires entries older than the TTL.
    // Wire shape stays `{ pending: head | null }` so client + main
    // server are oblivious to the queue beneath.
    res.end(JSON.stringify({ pending: peekPending() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/permission/respond') {
    let body = '';
    let bodySize = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bodySize += chunk.length;
      if (bodySize > 1_048_576) { res.writeHead(413); res.end('Payload too large'); return; }
      body += String(chunk);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid JSON: ${String(err)}` }));
      return;
    }
    const validated = PermissionRespondBodySchema.safeParse(parsed);
    if (!validated.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }));
      return;
    }
    const { request_id, behavior } = validated.data;
    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      });
      // HS-8047 — remove this specific request from the queue. The next
      // `peekPending` will surface whichever entry is now at the head.
      completePermission(request_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/permission/dismiss') {
    clearAllPermissions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // HS-8205 — debug-only injector used by `scripts/simulate-claude-prompts.mjs`
  // to exercise the §47 popup (incl. the HS-8171 v2 live-terminal checkout path)
  // without a real Claude Code session. Same shape as the MCP notification
  // handler at line 82 — `enqueuePermission` + `notifyMainServer` in lockstep.
  // `request_id` is optional; we generate one when absent so callers can fire
  // and forget. Returns the (possibly generated) request_id so the caller can
  // poll `/permission` for completion if they want symmetric blocking.
  if (req.method === 'POST' && req.url === '/permission/inject') {
    let body = '';
    let bodySize = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bodySize += chunk.length;
      if (bodySize > 1_048_576) { res.writeHead(413); res.end('Payload too large'); return; }
      body += String(chunk);
    }
    try {
      // HS-8567 — replace `JSON.parse(...) as { … }` + hand-rolled type
      // checks with a zod parse. The resulting `payload` is fully typed
      // and impossible to construct when validation fails.
      const rawPayload: unknown = JSON.parse(body);
      const payloadResult = PermissionInjectBodySchema.safeParse(rawPayload);
      if (!payloadResult.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tool_name, description, input_preview required' }));
        return;
      }
      const payload = payloadResult.data;
      const t0 = Date.now();
      const requestId = (payload.request_id !== undefined && payload.request_id !== '')
        ? payload.request_id
        : `sim_${t0.toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
      enqueuePermission({
        request_id: requestId,
        tool_name: payload.tool_name,
        description: payload.description,
        input_preview: payload.input_preview,
        timestamp: t0,
      });
      process.stderr.write(`[perm-inject ${t0}] ${payload.tool_name} — ${payload.description}\n`);
      void notifyMainServer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, request_id: requestId }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    let body = '';
    let bodySize = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bodySize += chunk.length;
      if (bodySize > 1_048_576) { res.writeHead(413); res.end('Payload too large'); return; }
      body += String(chunk);
    }

    channelLog.log('trigger', `bodyBytes=${body.length}`);
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: body || 'Process the Hot Sheet worklist. Run /hotsheet to work through the current Up Next items.',
          meta: { type: 'worklist' },
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      channelLog.log('trigger-error', String(err));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    // Graceful shutdown after responding
    setTimeout(() => void cleanup(), 100);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

/** Notify the main Hot Sheet server that channel state changed (so long-poll wakes up). */
function notifyMainServer(abortSignal?: AbortSignal): Promise<void> {
  try {
    const settingsPath = join(dataDir, 'settings.json');
    // HS-8567 — zod-validate the settings file at the parse boundary.
    const rawSettings: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const settingsResult = HotsheetSettingsSchema.safeParse(rawSettings);
    if (!settingsResult.success) {
      process.stderr.write(`[notify] settings.json shape invalid\n`);
      return Promise.resolve();
    }
    const settings = settingsResult.data;
    if (settings.port === undefined || settings.port === 0) {
      process.stderr.write(`[notify] no port in settings.json\n`);
      return Promise.resolve();
    }
    const url = `http://localhost:${settings.port}/api/channel/notify`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.secret !== undefined && settings.secret !== '') headers['X-Hotsheet-Secret'] = settings.secret;
    return fetch(url, { method: 'POST', headers, signal: abortSignal })
      .then(res => {
        if (!res.ok) {
          process.stderr.write(`[notify] POST ${url} returned ${res.status}\n`);
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(`[notify] POST ${url} failed: ${String(err)}\n`);
      });
  } catch (err: unknown) {
    process.stderr.write(`[notify] error reading settings: ${String(err)}\n`);
    return Promise.resolve();
  }
}

// HS-8452 — captured into module scope so `cleanup()` + the `exit` handler
// can pass it to `maybeUnlinkPortFile`. The port-aware unlink only deletes
// the port file when its on-disk contents match THIS process's port, so a
// sibling channel-server's cleanup never wipes a still-live owner's
// registration. Null until the http server has bound and reported its port.
let myPort: number | null = null;

// HS-8455 — dispose handle for the self-heal port-file watcher. Captured
// at install time in the `httpServer.listen` callback below; cleared in
// `cleanup()` so the timer doesn't keep the event loop alive after exit.
let disposePortFileWatcher: (() => void) | null = null;

// HS-8454 (revised after 2026-05-19 incident) — earlier drafts of this ticket
// added a startup-time collision lock: if `isExistingChannelAlive(dataDir)`
// returned true, the new channel-server process would exit cleanly so its
// writes wouldn't clobber the existing live process's registration. That
// design works for the captured HS-8452 parallel-server case (two channel
// servers running for the same dataDir) but is FATAL for the normal
// `/mcp` reconnect case, where Claude Code intentionally tears down the
// old process's stdio while spawning the new one. The brief probe window
// catches the old process still answering `/health`, the new process
// defers and exits, then the old process's stdio-disconnect watcher fires
// and exits too — leaving NO channel server and NO port file behind.
//
// Correct semantics: the new process always takes over. `writeChannelInfo`
// below writes our pid into the port file (HS-8454 — JSON shape), so the
// pid-aware `maybeUnlinkPortFile` (HS-8452 + HS-8454) keeps the old
// process's cleanup from wiping our registration. The parallel-server
// recovery case is owned by HS-8455's self-heal watcher.

// Find an available port
httpServer.listen(0, '127.0.0.1', () => {
  const addr = httpServer.address();
  if (addr !== null && typeof addr !== 'string') {
    const port = addr.port;
    myPort = port;
    // HS-8454 — JSON shape carrying full ownership identity. The
    // `readChannelInfo` reader accepts BOTH this shape and the legacy
    // bare-number format that older clusters wrote, so a downgrade is
    // safe in either direction during a single upgrade window.
    const myInfo = {
      port,
      pid: process.pid,
      slug: serverSlug,
      startedAt: processStartedAt,
    };
    // HS-8460 — register our per-pid entry in `<dataDir>/channel-ports.d/`
    // FIRST so the leader-selection below sees us. Then determine the
    // leader: if it's us, write `channel-port` with our identity; if
    // it's an older sibling channel-server, leave `channel-port`
    // alone (its watcher owns it). The HS-8455 watcher installed
    // below will promote us automatically the moment the older
    // leader exits.
    try {
      registerSelf(dataDir, myInfo);
    } catch (err) {
      channelLog.log('registry-register-error', String(err));
    }
    try {
      const alive = listAliveEntries(dataDir);
      const leader = pickLeader(alive);
      if (leader === null || leader.pid === process.pid) {
        writeChannelInfo(portFile, myInfo);
      } else {
        channelLog.log('startup-follower', `leader-pid=${String(leader.pid)} aliveCount=${String(alive.length)}`);
      }
    } catch {
      // data dir may not exist yet
    }
    disposePortFileWatcher = installPortFileWatcher({
      portFile,
      dataDir,
      info: myInfo,
      intervalMs: 5_000,
      log: (event, details) => channelLog.log(event, details),
      notify: () => { void notifyMainServer(); },
    });
    // Log to stderr (stdout is reserved for MCP stdio transport)
    process.stderr.write(`${serverName} listening on port ${port}\n`);
    channelLog.log('http-listen', `port=${port}`);
    // Notify main server that channel is now connected
    void notifyMainServer();
  }
});

// HS-8447 follow-up — periodic heartbeat so a `tail -f mcp.log`
// session can confirm the channel-server is still running. 60 s
// strikes a balance between log noise and useful "process was alive
// at HH:MM:SS then went dark" evidence on the next crash.
const heartbeatInterval = setInterval(() => {
  const mem = process.memoryUsage();
  channelLog.log('heartbeat', `uptime=${process.uptime().toFixed(1)}s rss=${(mem.rss / 1024 / 1024).toFixed(1)}MiB`);
}, 60_000);
// `unref` so the heartbeat timer never keeps the process alive on its
// own — if every other event-loop hook drains, we should still exit.
heartbeatInterval.unref();

// HS-8455 — re-entrancy guard. SIGTERM + the stdio-disconnect watcher
// can fire near-simultaneously; without this, both call `cleanup()` and
// we race two near-simultaneous `process.exit(0)` calls + double
// notifications. The first caller wins; subsequent callers no-op.
let cleanupInFlight = false;

// Cleanup on exit
async function cleanup(reason: string = 'unspecified') {
  if (cleanupInFlight) return;
  cleanupInFlight = true;
  channelLog.log('cleanup-start', `reason=${reason}`);
  clearInterval(heartbeatInterval);
  // HS-8455 — stop the self-heal watcher before we unlink the port file,
  // otherwise the watcher's next tick could rewrite the file we just
  // deleted (cleanup unlinks → 5s later watcher sees missing → rewrites).
  if (disposePortFileWatcher !== null) {
    disposePortFileWatcher();
    disposePortFileWatcher = null;
  }
  // HS-8452 — only delete the port file if it still points at THIS
  // process. Pre-fix the unconditional `unlinkSync` would wipe a sibling
  // process's registration whenever a transient second channel server
  // exited (e.g. on the `/mcp` reconnect race captured in `mcp.log`).
  // HS-8460 — also remove our per-pid registry entry so the surviving
  // siblings' next watcher tick re-picks the leader without us.
  if (myPort !== null) maybeUnlinkPortFile(portFile, myPort);
  unregisterSelf(dataDir, process.pid);
  // Notify main server synchronously before exiting — use a short timeout
  // so we don't hang if the server is down
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    await notifyMainServer(controller.signal);
  } catch { /* ignore */ }
  channelLog.log('cleanup-end', `reason=${reason} — exiting`);
  process.exit(0);
}
process.on('SIGTERM', () => { channelLog.log('signal', 'SIGTERM'); void cleanup('SIGTERM'); });
process.on('SIGINT', () => { channelLog.log('signal', 'SIGINT'); void cleanup('SIGINT'); });
// HS-8447 — also handle SIGHUP, which is what the OS sends when the
// controlling terminal of the parent (Claude Code) goes away. Without
// this, killing the terminal that hosts Claude Code would leave the
// channel-server process orphaned with a working HTTP server and a
// disconnected stdio — exactly the silent-disconnect mode the
// stdio watcher exists to close. Belt-and-braces alongside the
// watcher: the OS signal path catches the kill-the-terminal flavour;
// the watcher path catches the close-the-pipe-without-killing
// flavour (e.g. `/mcp` reconnect that closes the pipe but spawns a
// fresh process).
process.on('SIGHUP', () => { channelLog.log('signal', 'SIGHUP'); void cleanup('SIGHUP'); });
process.on('exit', (code) => {
  channelLog.log('exit', `code=${code}`);
  // HS-8452 — same port-aware unlink as `cleanup()`. The `exit` handler
  // is a defense-in-depth path that runs even if the async `cleanup()`
  // was bypassed (e.g. `process.exit` called from elsewhere); it must
  // not wipe a sibling owner's registration.
  if (myPort !== null) maybeUnlinkPortFile(portFile, myPort);
});
