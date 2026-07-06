// HS-9331 (docs/113 §113.4, docs/114 §114.7, docs/115 §115.7) — the per-agent
// capability table: which DRIVE TRANSPORT a project's `ai_tool` speaks. This is the
// single source of truth the play-button path (`channel-config.ts::triggerChannel`)
// consults, replacing the two hard-coded `isAntigravityDriven` / `isAcpDriven` gates.
//
// Tier-A drive is TWO co-equal transports chosen per agent by the protocol it speaks
// (maintainer decision, HS-9310):
//   - 'mcp-hooks'      docs/115 — MCP-native agents on the Claude rails. SHIPPED for
//                      Antigravity (`agy`, spawn-per-play); a second MCP-native agent
//                      plugs in by adding it to MCP_HOOKS_AGENTS + a spawn handler.
//   - 'acp'            docs/114 — ACP-native agents (OpenCode lead; Goose/Kiro/Codex-
//                      via-adapter as they enable). Membership is derived from
//                      `isAcpDrivenTool` (acpAgents.ts), so a new ACP entrypoint added
//                      there is automatically routed here — no second gate.
//   - 'claude-channel' Claude + `auto` + editor-only tools (Cursor/Copilot/Windsurf,
//                      which aren't terminal-driven) use the persistent Claude channel
//                      (the port-based `/trigger` path, unchanged).
//
// Pure + tiny so the mapping is unit-testable in isolation; `resolveProjectTransport`
// is the thin dataDir-reading wrapper.

import { isAcpDrivenTool } from './acp/acpAgents.js';
import { readFileSettings } from './file-settings.js';

export type AgentTransport = 'claude-channel' | 'mcp-hooks' | 'acp';

/** MCP-native agents driven on the Claude rails (docs/115). Antigravity (`agy`) is the
 *  shipped one; a second MCP+hooks agent is added here (plus its spawn handler). */
const MCP_HOOKS_AGENTS: ReadonlySet<string> = new Set(['antigravity']);

/**
 * Pure: the drive transport for an `ai_tool` value. Precedence — an explicit MCP-hooks
 * agent, then an ACP-native agent (via `isAcpDrivenTool`), else the Claude channel
 * (the default for `claude`/`auto`/unset and the editor-only tools). Case-insensitive.
 */
export function resolveAgentTransport(aiTool: string | undefined): AgentTransport {
  const tool = (aiTool ?? '').trim().toLowerCase();
  if (MCP_HOOKS_AGENTS.has(tool)) return 'mcp-hooks';
  if (isAcpDrivenTool(tool)) return 'acp';
  return 'claude-channel';
}

/** Resolve the drive transport for a project from its `ai_tool` file setting. */
export function resolveProjectTransport(dataDir: string): AgentTransport {
  const tool = readFileSettings(dataDir).ai_tool;
  return resolveAgentTransport(typeof tool === 'string' ? tool : undefined);
}
