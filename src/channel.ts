#!/usr/bin/env node
/**
 * Hot Sheet Channel Server for Claude Code.
 * MCP server that bridges Hot Sheet UI → Claude Code session.
 * Spawned by Claude Code as a subprocess via .mcp.json.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createServer } from 'http';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';

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

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  pendingPermission = {
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
    timestamp: Date.now(),
  };
  process.stderr.write(`Permission request: ${params.tool_name} — ${params.description}\n`);
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
    for await (const chunk of req) body += chunk;
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
    for await (const chunk of req) body += chunk;

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

// Find an available port
httpServer.listen(0, '127.0.0.1', () => {
  const addr = httpServer.address();
  if (addr && typeof addr !== 'string') {
    const port = addr.port;
    try {
      writeFileSync(portFile, String(port), 'utf-8');
    } catch {
      // data dir may not exist yet
    }
    // Log to stderr (stdout is reserved for MCP stdio transport)
    process.stderr.write(`hotsheet-channel listening on port ${port}\n`);
  }
});

// Cleanup on exit
function cleanup() {
  try { unlinkSync(portFile); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('exit', () => { try { unlinkSync(portFile); } catch { /* ignore */ } });
