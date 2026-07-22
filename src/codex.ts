// HS-9369 — make Codex Hot-Sheet-aware by registering the channel MCP server in
// Codex's config, so a spawned `codex exec` sees the `hotsheet_*` tools (docs/115;
// the Antigravity analog is `src/antigravity.ts`).
//
// Codex's MCP config is GLOBAL — `[mcp_servers.<name>]` tables in
// `~/.codex/config.toml` — and, like agy's, we register ONE cwd-resolving entry:
// the channel server is launched WITHOUT `--data-dir`, so `channel.ts` resolves
// `.hotsheet` from codex's launch directory. A single global entry serves EVERY
// project.
//
// Unlike agy's JSON config we do NOT hand-edit the file: config.toml is TOML and
// carries the user's whole Codex setup, so a lossy round-trip would be worse than
// the agy JSON case. Instead the shipped `codex mcp add <name> -- <command…>` CLI
// owns the TOML edit (add overwrites a same-name entry in place). A cheap text
// precheck on the file keeps the ensure idempotent (no exec when already correct).
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { getChannelServerPath } from './channel-config.js';

/** The single, cwd-resolving server name we own in Codex's global MCP config. */
export const CODEX_MCP_KEY = 'hotsheet-channel';

/** Codex's global config path (`~/.codex/config.toml`; `$CODEX_HOME` overrides the
 *  dir — respected so a relocated Codex home still gets the entry). */
export function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME;
  const dir = codexHome !== undefined && codexHome !== '' ? codexHome : join(homedir(), '.codex');
  return join(dir, 'config.toml');
}

/**
 * Pure: does this config.toml text already register our entry with the desired
 * command? A deliberately cheap TEXT check (not a TOML parse): the section header
 * must be present and the command path must appear after it. False negatives just
 * cause a harmless re-`add` (idempotent overwrite); false positives are avoided by
 * requiring the exact command string. Exported for testing.
 */
export function codexConfigHasEntry(configText: string, command: string): boolean {
  const header = `[mcp_servers.${CODEX_MCP_KEY}]`;
  const quotedHeader = `[mcp_servers."${CODEX_MCP_KEY}"]`;
  const at = configText.indexOf(header) !== -1 ? configText.indexOf(header) : configText.indexOf(quotedHeader);
  if (at === -1) return false;
  // Scope the command check to this server's table (up to the next section header).
  const rest = configText.slice(at + 1);
  const nextSection = rest.search(/\n\s*\[/);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
  return section.includes(command);
}

export interface EnsureCodexDeps {
  /** Injectable for tests. Defaults to `execFileSync('codex', …)`. */
  runCodex?: (args: string[]) => void;
  /** Injectable for tests. Defaults to reading `codexConfigPath()`. */
  readConfig?: () => string | null;
}

/**
 * Ensure the cwd-resolving `hotsheet-channel` server is registered in Codex's
 * global MCP config via `codex mcp add` (which owns the TOML edit; a same-name
 * add replaces the entry). Idempotent via the text precheck; best-effort (a
 * failing `codex` invocation is swallowed — the drive still runs, just without
 * the `hotsheet_*` tools). Returns true when an add was executed.
 */
export function ensureCodexMcpConfig(deps: EnsureCodexDeps = {}): boolean {
  const run = deps.runCodex ?? ((args: string[]) => {
    execFileSync('codex', args, { stdio: 'ignore', timeout: 15_000 });
  });
  const read = deps.readConfig ?? defaultReadConfig;
  const { command, args } = getChannelServerPath();

  const text = read();
  if (text !== null && codexConfigHasEntry(text, command)) return false; // already correct

  try {
    run(['mcp', 'add', CODEX_MCP_KEY, '--', command, ...args]);
    return true;
  } catch {
    return false; // best-effort — a launch still works, just without the tools
  }
}

function defaultReadConfig(): string | null {
  const path = codexConfigPath();
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null; // unreadable → precheck inconclusive; the add still runs
  }
}
