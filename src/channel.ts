#!/usr/bin/env node
/**
 * Hot Sheet Channel Server for Claude Code.
 * MCP server that bridges Hot Sheet UI → Claude Code session.
 * Spawned by Claude Code as a subprocess via .mcp.json.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { z } from 'zod';

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

// Create MCP server with channel capability
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is needed for low-level MCP channel/permission protocol
const mcp = new Server(
  { name: 'hotsheet-channel', version: '0.1.0' },
  {
    capabilities: {
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
      'IMPORTANT: When you finish processing (or if there was nothing to process), you MUST run the curl command provided in the event to signal completion.',
    ].join(' '),
  },
);

// Track pending permission requests
interface PendingPermission {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  timestamp: number;
}
let pendingPermission: PendingPermission | null = null;

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

mcp.setNotificationHandler(PermissionRequestSchema, ({ params }) => {
  pendingPermission = {
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
    timestamp: Date.now(),
  };
  process.stderr.write(`Permission request: ${params.tool_name} — ${params.description}\n`);
  // Notify main server so the permission long-poll wakes immediately
  notifyMainServer('permission').catch(() => {});
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
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/permission') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Auto-expire after 120 seconds
    if (pendingPermission && Date.now() - pendingPermission.timestamp > 120000) {
      pendingPermission = null;
    }
    res.end(JSON.stringify({ pending: pendingPermission }));
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
    try {
      const { request_id, behavior } = JSON.parse(body) as { request_id: string; behavior: 'allow' | 'deny' };
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      });
      if (pendingPermission?.request_id === request_id) {
        pendingPermission = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/permission/dismiss') {
    pendingPermission = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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

  res.writeHead(404);
  res.end('not found');
});

/** Notify the main Hot Sheet server that channel state changed (so long-poll wakes up). */
function notifyMainServer(type?: 'permission' | AbortSignal, signal?: AbortSignal): Promise<void> {
  // Support old signature: notifyMainServer(abortSignal) and new: notifyMainServer('permission', abortSignal?)
  let actualSignal = signal;
  let endpoint = '/api/channel/notify';
  if (type instanceof AbortSignal) {
    actualSignal = type;
  } else if (type === 'permission') {
    endpoint = '/api/channel/permission/notify';
  }
  try {
    const settingsPath = join(dataDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { port?: number; secret?: string };
    if (settings.port !== undefined && settings.port !== 0) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.secret !== undefined && settings.secret !== '') headers['X-Hotsheet-Secret'] = settings.secret;
      return fetch(`http://localhost:${settings.port}${endpoint}`, { method: 'POST', headers, signal: actualSignal }).then(() => {}).catch(() => {});
    }
  } catch { /* ignore */ }
  return Promise.resolve();
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
    process.stderr.write(`hotsheet-channel listening on port ${port}\n`);
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
