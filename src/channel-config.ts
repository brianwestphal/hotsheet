import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const MCP_SERVER_KEY = 'hotsheet-channel';

/** Get the path to the channel server and the command to run it.
 *  channel-config.ts and channel.ts are siblings in src/ (dev) and dist/ (production). */
function getChannelServerPath(): { command: string; args: string[] } {
  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Production: this file is dist/channel-config.js, sibling is dist/channel.js
  const distPath = resolve(thisDir, 'channel.js');
  if (existsSync(distPath)) {
    return { command: 'node', args: [distPath] };
  }

  // Dev mode: this file is src/channel-config.ts, sibling is src/channel.ts
  const srcPath = resolve(thisDir, 'channel.ts');
  if (existsSync(srcPath)) {
    return { command: 'npx', args: ['tsx', srcPath] };
  }

  // Fallback
  return { command: 'node', args: [distPath] };
}

/** Register the channel server in .mcp.json */
export function registerChannel(dataDir: string): void {
  const cwd = process.cwd();
  const mcpPath = join(cwd, '.mcp.json');
  const { command, args } = getChannelServerPath();

  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    } catch { /* corrupt, overwrite */ }
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[MCP_SERVER_KEY] = {
    command,
    args: [...args, '--data-dir', dataDir],
  };

  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Remove the channel server from .mcp.json */
export function unregisterChannel(): void {
  const cwd = process.cwd();
  const mcpPath = join(cwd, '.mcp.json');

  if (!existsSync(mcpPath)) return;

  try {
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    if (config.mcpServers?.[MCP_SERVER_KEY]) {
      delete config.mcpServers[MCP_SERVER_KEY];
      writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    }
  } catch { /* ignore */ }
}

/** Read the channel port from the port file */
export function getChannelPort(dataDir: string): number | null {
  try {
    const portStr = readFileSync(join(dataDir, 'channel-port'), 'utf-8').trim();
    const port = parseInt(portStr, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Check if the channel server is reachable */
export async function isChannelAlive(dataDir: string): Promise<boolean> {
  const port = getChannelPort(dataDir);
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/** Send a trigger to the channel server */
export async function triggerChannel(dataDir: string, serverPort: number, message?: string): Promise<boolean> {
  const port = getChannelPort(dataDir);
  if (!port) return false;
  const doneSignal = `\n\nWhen you are completely finished (or if there was nothing to do), signal completion by running:\ncurl -s -X POST http://localhost:${serverPort}/api/channel/done`;
  const content = message
    ? message + doneSignal
    : 'Process the Hot Sheet worklist. Run /hotsheet to work through the current Up Next items.' + doneSignal;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      body: content,
    });
    return res.ok;
  } catch {
    return false;
  }
}
