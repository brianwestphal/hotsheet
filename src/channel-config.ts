import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
}).loose();

// HS-8349 — the legacy single-key MCP server name used before per-project
// slug-suffixed keys landed. Kept here so `registerChannel` / `unregisterChannel`
// can opportunistically remove a stale legacy entry on the same `.mcp.json`
// during the one-time migration. New writes use `getMcpServerKey(dataDir)`.
const LEGACY_MCP_SERVER_KEY = 'hotsheet-channel';

/** HS-8349 — derive a stable per-project slug from the channel server's
 *  `--data-dir`. The basename of the project root (parent of `.hotsheet/`)
 *  is lowercased and non-alphanumeric runs collapse to a single `-`.
 *  Leading / trailing `-` are trimmed. An empty result falls back to
 *  `project` so the slug is always non-empty. */
export function slugifyDataDir(dataDir: string): string {
  const root = dataDir.replace(/[\\/]\.hotsheet[\\/]?$/, '');
  const base = basename(root) || 'project';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug !== '' ? slug : 'project';
}

/** HS-8349 — the per-project MCP server key written into `.mcp.json`.
 *  Claude Code namespaces tools by the `.mcp.json` key, so each project's
 *  channel server now registers under `hotsheet-channel-<slug>` instead of
 *  the shared `hotsheet-channel`, surfacing the source project in the tool
 *  list (e.g. `mcp__hotsheet-channel-kerf__hotsheet_update_ticket`). */
export function getMcpServerKey(dataDir: string): string {
  return `${LEGACY_MCP_SERVER_KEY}-${slugifyDataDir(dataDir)}`;
}

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

/** Register the channel server in .mcp.json for a specific project.
 *  HS-8349 — the key is per-project (`hotsheet-channel-<slug>` from
 *  `getMcpServerKey(dataDir)`). Any pre-existing legacy `hotsheet-channel`
 *  entry on the same `.mcp.json` is dropped in the same write so the upgrade
 *  doesn't leave a stale duplicate behind. */
export function registerChannel(dataDir: string): void {
  const root = projectRoot(dataDir);
  const mcpPath = join(root, '.mcp.json');
  const { command, args } = getChannelServerPath();
  const serverKey = getMcpServerKey(dataDir);

  let config: z.infer<typeof McpConfigSchema> = {};
  if (existsSync(mcpPath)) {
    try {
      const parsed = McpConfigSchema.safeParse(JSON.parse(readFileSync(mcpPath, 'utf-8')));
      if (parsed.success) config = parsed.data;
    } catch { /* corrupt, overwrite */ }
  }

  if (!config.mcpServers) config.mcpServers = {};
  // HS-8349 migration: drop the legacy single-key entry if present.
  // The slug-suffixed key supersedes it.
  if (
    serverKey !== LEGACY_MCP_SERVER_KEY
    && config.mcpServers[LEGACY_MCP_SERVER_KEY] !== undefined
  ) {
    const servers = { ...config.mcpServers };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete servers[LEGACY_MCP_SERVER_KEY];
    config.mcpServers = servers;
  }
  config.mcpServers[serverKey] = {
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

/** Remove the channel server from .mcp.json for a specific project.
 *  HS-8349 — removes BOTH the per-project slug-suffixed key AND the legacy
 *  `hotsheet-channel` key (in case the user is rolling back from a build
 *  that registered it). */
export function unregisterChannel(dataDir?: string): void {
  const root = dataDir !== undefined ? projectRoot(dataDir) : process.cwd();
  const mcpPath = join(root, '.mcp.json');

  if (!existsSync(mcpPath)) return;

  try {
    const config = McpConfigSchema.parse(JSON.parse(readFileSync(mcpPath, 'utf-8')));
    const servers = config.mcpServers !== undefined ? { ...config.mcpServers } : {};
    let changed = false;
    // Drop the per-project key (only resolvable when dataDir is provided).
    if (dataDir !== undefined) {
      const serverKey = getMcpServerKey(dataDir);
      if (servers[serverKey] !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete servers[serverKey];
        changed = true;
      }
    }
    // Drop the legacy single-key entry if present.
    if (servers[LEGACY_MCP_SERVER_KEY] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete servers[LEGACY_MCP_SERVER_KEY];
      changed = true;
    }
    if (changed) {
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
 *  Duplicated here to avoid importing channel.ts (which has side effects).
 *
 *  HS-8346 — bumped from 4 → 5 for the new MCP tool surface (tools/list +
 *  tools/call handlers exposing hotsheet_update_ticket / hotsheet_create_ticket /
 *  hotsheet_signal_done / hotsheet_add_attachment / hotsheet_request_feedback).
 *  HS-8347 — bumped from 5 → 6 for the Phase 2 expansion (9 more tools:
 *  hotsheet_get_ticket / delete_ticket / restore_ticket / toggle_up_next /
 *  duplicate_tickets / batch / edit_note / delete_note / query_tickets).
 *  HS-8349 — bumped from 6 → 7 for the Phase 4 multi-project tool naming
 *  (`.mcp.json` key + `Server({name})` are now per-project `hotsheet-channel-<slug>`).
 *  Users who have the channel registered will see a "reconnect via `/mcp`"
 *  prompt when the main server boots with the newer version. */
const EXPECTED_CHANNEL_VERSION = 7;

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
  // HS-8348 — Phase 3 two-form layout. Mention the `hotsheet_signal_done`
  // MCP tool first (preferred when the channel is connected), with the
  // curl fallback right below for non-Claude AI agents and any caller
  // whose tool surface doesn't include the channel-server tools.
  const doneSignal = `\n\nWhen you are completely finished (or if there was nothing to do), signal completion by calling the \`hotsheet_signal_done\` MCP tool (or, as a fallback, running:\ncurl -s -X POST http://localhost:${serverPort}/api/channel/done${secretHeader}\n)`;
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
