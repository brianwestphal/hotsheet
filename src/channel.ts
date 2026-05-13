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
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { z } from 'zod';

import { callTool, listTools } from './channel.tools.js';
import { slugifyDataDir } from './channel-config.js';
import {
  clearAllPermissions,
  completePermission,
  enqueuePermission,
  peekPending,
} from './channelPermissions.js';

// HS-8346 — bumped from 4 → 5 for the new MCP tool surface (tools/list +
// tools/call handlers exposing hotsheet_update_ticket / hotsheet_create_ticket /
// hotsheet_signal_done / hotsheet_add_attachment / hotsheet_request_feedback).
// HS-8347 — bumped from 5 → 6 for the Phase 2 expansion (9 more tools:
// hotsheet_get_ticket / delete_ticket / restore_ticket / toggle_up_next /
// duplicate_tickets / batch / edit_note / delete_note / query_tickets).
// HS-8349 — bumped from 6 → 7 for the Phase 4 multi-project tool naming
// (`.mcp.json` key + Server({name}) are now per-project `hotsheet-channel-<slug>`).
// `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts` bumped in lockstep.
export const CHANNEL_VERSION = 7;

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
    res.end(JSON.stringify({ ok: true, version: CHANNEL_VERSION }));
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
      const payload = JSON.parse(body) as {
        request_id?: string;
        tool_name: string;
        description: string;
        input_preview: string;
      };
      if (typeof payload.tool_name !== 'string' || payload.tool_name === ''
          || typeof payload.description !== 'string'
          || typeof payload.input_preview !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tool_name, description, input_preview required' }));
        return;
      }
      const t0 = Date.now();
      const requestId = (typeof payload.request_id === 'string' && payload.request_id !== '')
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
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { port?: number; secret?: string };
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

// Find an available port
httpServer.listen(0, '127.0.0.1', () => {
  const addr = httpServer.address();
  if (addr !== null && typeof addr !== 'string') {
    const port = addr.port;
    try {
      writeFileSync(portFile, String(port), 'utf-8');
    } catch {
      // data dir may not exist yet
    }
    // Log to stderr (stdout is reserved for MCP stdio transport)
    process.stderr.write(`${serverName} listening on port ${port}\n`);
    // Notify main server that channel is now connected
    void notifyMainServer();
  }
});

// Cleanup on exit
async function cleanup() {
  try { unlinkSync(portFile); } catch { /* ignore */ }
  // Notify main server synchronously before exiting — use a short timeout
  // so we don't hang if the server is down
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    await notifyMainServer(controller.signal);
  } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => void cleanup());
process.on('SIGINT', () => void cleanup());
process.on('exit', () => { try { unlinkSync(portFile); } catch { /* ignore */ } });
