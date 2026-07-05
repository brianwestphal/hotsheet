// HS-9330 — pure, spike-validated helpers for the ACP drive transport (docs/114).
// The connection/lifecycle client (`src/acp/client.ts`, still to build) will
// consume these; they live apart so the deterministic pieces are unit-testable
// without the `@zed-industries/agent-client-protocol` SDK or a live agent —
// mirroring how `acpMapping.ts` landed the message-mapping core ahead of the client.
//
// Validated LIVE against opencode 1.17.9 (the HS-9330 spike): `opencode acp` is a
// genuine ACP v1 agent — `initialize` → `{protocolVersion:1, agentInfo:{name:"OpenCode"}}`
// over newline-delimited JSON-RPC on stdio, and `session/new` with a STDIO
// `mcpServers` entry returned a real `sessionId` + streamed a `session/update`.

import { getChannelServerPath } from '../channel-config.js';

/** ACP protocol version Hot Sheet's client speaks — ACP v1, confirmed by
 *  opencode's `initialize` result (`protocolVersion: 1`). */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The subprocess entrypoint that puts an ACP-native agent into ACP-server mode.
 * For OpenCode that's `opencode acp` (validated live). Returns `null` for a tool
 * with no known ACP entrypoint — the caller then falls back to a different
 * transport (the MCP+hooks path, docs/115) or leaves the play button on the
 * plain REPL. Other ACP-native agents (Goose, Kiro, Codex-via-Zed-adapter) get
 * their entrypoints added here as their per-agent enablement lands (HS-9330
 * follow-ups) — each pinned by a spike, never guessed.
 */
export function resolveAcpAgentCommand(
  aiTool: string | undefined,
): { command: string; args: string[] } | null {
  switch ((aiTool ?? '').trim().toLowerCase()) {
    case 'opencode':
      return { command: 'opencode', args: ['acp'] };
    default:
      return null;
  }
}

/** True when the given `ai_tool` is driven over the ACP transport (docs/113
 *  §113.2 A2) — i.e. `resolveAcpAgentCommand` knows its ACP entrypoint. */
export function isAcpDrivenTool(aiTool: string | undefined): boolean {
  return resolveAcpAgentCommand(aiTool) !== null;
}

/**
 * One ACP `session/new.mcpServers` STDIO entry. OpenCode's schema (surfaced by
 * the spike's validation error) is a union of stdio `{name, command, args, env}`
 * | sse `{type:'sse', url, headers}`; we use **stdio** so the SAME cwd-resolving
 * channel server Claude (`.mcp.json`) and Antigravity (`mcp_config.json`) already
 * use rides ACP unchanged — the `hotsheet_*` tools need no per-transport variant
 * (docs/114 §114.4). `env` is an ARRAY (OpenCode rejects an object here), of
 * ACP `EnvVariable` `{name, value}` pairs — empty for the channel server, which
 * resolves its `.hotsheet` from the agent's launch cwd (no `--data-dir`).
 */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export function buildHotsheetMcpServerEntry(name = 'hotsheet'): AcpStdioMcpServer {
  const { command, args } = getChannelServerPath();
  return { name, command, args, env: [] };
}
