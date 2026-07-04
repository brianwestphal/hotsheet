// HS-9320 — make Antigravity (`agy`) Hot-Sheet-aware by registering the channel
// MCP server in agy's config, so a launched `agy` sees the `hotsheet_*` tools
// (docs/113 §113.2; the HS-9310 spike proved the wiring end-to-end).
//
// Antigravity's MCP config is GLOBAL — `~/.gemini/config/mcp_config.json`, relative
// to its `GeminiDir` — not per-project like Claude's repo `.mcp.json`. Rather than
// fight that with per-launch merge/unmerge, we register ONE cwd-resolving entry:
// the channel server is launched WITHOUT `--data-dir`, so `channel.ts` resolves
// `.hotsheet` from agy's launch directory (its `dataDir` defaults to the relative
// `.hotsheet`, plus the HS-8934 cwd pointer). So a single global entry serves EVERY
// project — agy run in project A's dir drives A's Hot Sheet, in B's dir drives B's.
// (Validated live in the HS-9310 spike: `agy --print` listed + mutated real tickets
// via `hotsheet_query_tickets` with no `--data-dir`.)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import { getChannelServerPath } from './channel-config.js';

/** The single, cwd-resolving key we own in agy's global MCP config. */
export const ANTIGRAVITY_MCP_KEY = 'hotsheet-channel';

/** agy's global MCP config path (`~/.gemini/config/mcp_config.json`). agy hardcodes
 *  `.gemini` under the home dir as its GeminiDir on every platform. */
export function antigravityMcpConfigPath(): string {
  return join(homedir(), '.gemini', 'config', 'mcp_config.json');
}

/** The server entry we want present: the channel command with NO `--data-dir`. */
function desiredEntry(): { command: string; args: string[] } {
  const { command, args } = getChannelServerPath();
  return { command, args };
}

function sameEntry(a: unknown, b: { command: string; args: string[] }): boolean {
  if (typeof a !== 'object' || a === null) return false;
  const o = a as Record<string, unknown>; // guarded above
  return o.command === b.command
    && Array.isArray(o.args)
    && o.args.length === b.args.length
    && o.args.every((v, i) => v === b.args[i]);
}

/**
 * Read the config as a plain object, preserving EVERY key so a re-serialize can't
 * drop the user's other settings/servers. Returns `{}` for missing/empty, or `null`
 * for corrupt/non-object JSON (signal to leave the file untouched — it's the user's
 * global config, we don't clobber it). Deliberately no zod: a schema `.parse` would
 * strip the unknown keys we must keep.
 */
function readConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf-8').trim();
  if (raw === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>; // guarded above
}

/** Extract the `mcpServers` object as a mutable copy (empty when absent/malformed). */
function serversOf(config: Record<string, unknown>): Record<string, unknown> {
  const s = config.mcpServers;
  return typeof s === 'object' && s !== null && !Array.isArray(s)
    ? { ...(s as Record<string, unknown>) } // guarded above
    : {};
}

function writeConfig(configPath: string, config: Record<string, unknown>): boolean {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // best-effort — a launch still works, just without the tools
  }
}

/**
 * Ensure the cwd-resolving `hotsheet-channel` server is registered in agy's global
 * MCP config. Idempotent (no write when already correct), merge-only (never touches
 * the user's other servers/keys), best-effort (a corrupt config is left intact).
 * `configPath` is overridable for tests. Returns true when a write happened.
 */
export function ensureAntigravityMcpConfig(configPath: string = antigravityMcpConfigPath()): boolean {
  const config = readConfig(configPath);
  if (config === null) return false; // corrupt/unexpected — don't clobber

  const want = desiredEntry();
  const servers = serversOf(config);
  if (sameEntry(servers[ANTIGRAVITY_MCP_KEY], want)) return false; // already correct

  servers[ANTIGRAVITY_MCP_KEY] = want;
  config.mcpServers = servers;
  return writeConfig(configPath, config);
}

/**
 * Remove our `hotsheet-channel` key from agy's global MCP config, leaving every
 * other server/key intact. Best-effort; returns true when a write happened.
 */
export function removeAntigravityMcpConfig(configPath: string = antigravityMcpConfigPath()): boolean {
  if (!existsSync(configPath)) return false;
  const config = readConfig(configPath);
  if (config === null) return false;
  const servers = serversOf(config);
  if (servers[ANTIGRAVITY_MCP_KEY] === undefined) return false;

  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete servers[ANTIGRAVITY_MCP_KEY];
  config.mcpServers = servers;
  return writeConfig(configPath, config);
}
