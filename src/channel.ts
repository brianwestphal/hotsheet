#!/usr/bin/env node
/**
 * Hot Sheet Channel Server for Claude Code.
 * MCP server that bridges Hot Sheet UI → Claude Code session.
 * Spawned by Claude Code as a subprocess via .mcp.json.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'http';
import { writeFileSync, unlinkSync } from 'fs';
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
      experimental: { 'claude/channel': {} },
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

// Connect to Claude Code over stdio
await mcp.connect(new StdioServerTransport());

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
