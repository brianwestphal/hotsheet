// HS-9338 (docs/117 §117.3) — client helpers for the Settings "Agent backend" picker.
// Reuses the shared pure parse (`src/agentBackendParse.ts`) so the select round-trips
// with what the server stores/reads. The transport labels + the derived-default helper
// live here (client-only display concerns).

import { type AgentTransport, parseAgentBackend } from '../agentBackendParse.js';

export { parseAgentBackend };
export type { AgentTransport };

/** Human labels for the three transports (docs/117 §117.2). */
export const TRANSPORT_LABEL: Record<AgentTransport, string> = {
  'claude-channel': 'Claude channel (MCP)',
  'mcp-hooks': 'MCP + hooks',
  acp: 'ACP',
};

// ⚠ MIRROR of the server capability table (`src/agentTransport.ts::resolveAgentTransport`
// + `MCP_HOOKS_AGENTS` + `acpAgents.ts::isAcpDrivenTool`). Used ONLY to show the derived
// default next to the "Auto" option — the real routing decision is always made
// server-side. Keep in sync when enabling an agent: an MCP-hooks agent → add to
// `MCP_HOOKS_AI_TOOLS` here AND `MCP_HOOKS_AGENTS`; an ACP agent → add to `ACP_AI_TOOLS`
// here AND give it an `acpAgents.ts` entrypoint.
const MCP_HOOKS_AI_TOOLS = new Set(['antigravity']);
const ACP_AI_TOOLS = new Set(['opencode']);

/** The transport the capability table would auto-derive for an `ai_tool` (display only). */
export function deriveDefaultTransport(aiTool: string | undefined): AgentTransport {
  const t = (aiTool ?? '').trim().toLowerCase();
  if (MCP_HOOKS_AI_TOOLS.has(t)) return 'mcp-hooks';
  if (ACP_AI_TOOLS.has(t)) return 'acp';
  return 'claude-channel';
}

/** The select value ('auto' | transport) for a stored `agent_backend` string. */
export function agentBackendSelectValue(stored: unknown): string {
  const ov = parseAgentBackend(stored);
  return ov.mode === 'auto' ? 'auto' : ov.transport;
}
