import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
}).loose();

const MCP_SERVER_KEY = 'hotsheet-channel';

/** Get the path to the channel server and the command to run it.
 *  channel-config.ts and channel.ts are siblings in src/ (dev) and dist/ (production).
 *  Uses process.execPath for the node binary so it works even when launched from Tauri
 *  (where node may not be on the PATH). */
function getChannelServerPath(): { command: string; args: string[] } {
  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Production: this file is dist/channel-config.js, sibling is dist/channel.js
  const distPath = resolve(thisDir, 'channel.js');
  if (existsSync(distPath)) {
    return { command: process.execPath, args: [distPath] };
  }

  // Dev mode: this file is src/channel-config.ts, sibling is src/channel.ts
  const srcPath = resolve(thisDir, 'channel.ts');
  if (existsSync(srcPath)) {
    return { command: 'npx', args: ['tsx', srcPath] };
  }

  // Fallback
  return { command: process.execPath, args: [distPath] };
}

/** Get the project root directory (parent of .hotsheet/) */
function projectRoot(dataDir: string): string {
  return dataDir.replace(/\/.hotsheet\/?$/, '');
}

/** Register the channel server in .mcp.json for a specific project */
export function registerChannel(dataDir: string): void {
  const root = projectRoot(dataDir);
  const mcpPath = join(root, '.mcp.json');
  const { command, args } = getChannelServerPath();

  let config: z.infer<typeof McpConfigSchema> = {};
  if (existsSync(mcpPath)) {
    try {
      const parsed = McpConfigSchema.safeParse(JSON.parse(readFileSync(mcpPath, 'utf-8')));
      if (parsed.success) config = parsed.data;
    } catch { /* corrupt, overwrite */ }
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[MCP_SERVER_KEY] = {
    command,
    args: [...args, '--data-dir', dataDir],
  };

  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Register the channel for multiple projects at once */
export function registerChannelForAll(dataDirs: string[]): void {
  for (const dataDir of dataDirs) {
    registerChannel(dataDir);
  }
}

/** Remove the channel server from .mcp.json for a specific project */
export function unregisterChannel(dataDir?: string): void {
  const root = dataDir !== undefined ? projectRoot(dataDir) : process.cwd();
  const mcpPath = join(root, '.mcp.json');

  if (!existsSync(mcpPath)) return;

  try {
    const config = McpConfigSchema.parse(JSON.parse(readFileSync(mcpPath, 'utf-8')));
    if (config.mcpServers?.[MCP_SERVER_KEY] !== undefined) {
      const servers = { ...config.mcpServers };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete servers[MCP_SERVER_KEY];
      config.mcpServers = servers;
      writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    }
  } catch { /* ignore */ }
}

/** Unregister the channel from multiple projects at once */
export function unregisterChannelForAll(dataDirs: string[]): void {
  for (const dataDir of dataDirs) {
    unregisterChannel(dataDir);
  }
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

/** Clean up stale channel port files (dead servers only).
 *  Does NOT shut down alive channel servers — they're connected to Claude Code via stdio
 *  and killing them would break the MCP connection, requiring manual reconnect.
 *  Called on app startup. */
export async function cleanupStaleChannel(dataDir: string): Promise<void> {
  const port = getChannelPort(dataDir);
  if (port === null) return;

  const alive = await isChannelAlive(dataDir);
  if (!alive) {
    // Port file exists but server is dead — clean up the stale port file
    try { unlinkSync(join(dataDir, 'channel-port')); } catch { /* ignore */ }
  }
  // If alive, leave it alone — it's connected to Claude Code
}

/** Expected channel server version — must match CHANNEL_VERSION in channel.ts.
 *  Duplicated here to avoid importing channel.ts (which has side effects). */
const EXPECTED_CHANNEL_VERSION = 3;

/** Check if the running channel server's version matches the expected version.
 *  Returns null if no channel, true if matching, false if mismatched. */
export async function checkChannelVersion(dataDir: string): Promise<{ match: boolean; running: number; expected: number } | null> {
  const port = getChannelPort(dataDir);
  if (port === null) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await res.json() as { ok: boolean; version?: number };
    const running = data.version ?? 0;
    return { match: running === EXPECTED_CHANNEL_VERSION, running, expected: EXPECTED_CHANNEL_VERSION };
  } catch {
    return null;
  }
}

/** Shut down a channel server via its /shutdown endpoint.
 *  Used when the user explicitly disables the channel. */
export async function shutdownChannel(dataDir: string): Promise<void> {
  const port = getChannelPort(dataDir);
  if (port === null) return;
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
  } catch { /* ignore */ }
  try { unlinkSync(join(dataDir, 'channel-port')); } catch { /* ignore */ }
}

/** Check if the channel server is reachable */
export async function isChannelAlive(dataDir: string): Promise<boolean> {
  const port = getChannelPort(dataDir);
  if (port === null) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await res.json() as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

/** Send a trigger to the channel server */
export async function triggerChannel(dataDir: string, serverPort: number, message?: string): Promise<boolean> {
  const port = getChannelPort(dataDir);
  if (port === null) return false;
  // Include secret in the done signal so it passes the API middleware
  let secretHeader = '';
  try {
    const { readFileSettings } = await import('./file-settings.js');
    const settings = readFileSettings(dataDir);
    if (settings.secret !== undefined && settings.secret !== '') secretHeader = ` -H "X-Hotsheet-Secret: ${settings.secret}"`;
  } catch { /* ignore */ }
  const doneSignal = `\n\nWhen you are completely finished (or if there was nothing to do), signal completion by running:\ncurl -s -X POST http://localhost:${serverPort}/api/channel/done${secretHeader}`;
  const content = message !== undefined && message !== ''
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
