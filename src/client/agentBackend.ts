// HS-9338 (docs/117 §117.3) — client helpers for the Settings "Agent backend" picker.
// Reuses the shared pure parse (`src/agentBackendParse.ts`) so the select round-trips
// with what the server stores/reads. The transport labels + the derived-default helper
// live here (client-only display concerns).

import { type AgentTransport, parseAgentBackend } from '../agentBackendParse.js';
import { transportFor } from '../aiTools/registry.js';

export { parseAgentBackend };
export type { AgentTransport };

/** Human labels for the three transports (docs/117 §117.2). */
export const TRANSPORT_LABEL: Record<AgentTransport, string> = {
  'claude-channel': 'Claude channel (MCP)',
  'mcp-hooks': 'MCP + hooks',
  acp: 'ACP',
};

/**
 * The transport the capability table auto-derives for an `ai_tool` — shown next to the
 * "Auto" option. The real routing decision is still made server-side.
 *
 * HS-9508 — this used to be a hand-synced ⚠ MIRROR of the server's table (two `Set`s of
 * tool ids, with a comment asking future readers to keep them in step). Nothing pinned
 * it, so adding a tool server-side silently made this hint wrong. Transport now lives on
 * the plugin as identity data (docs/132 §132.11.7), and the pure registry is client-safe,
 * so both sides read ONE definition.
 */
export function deriveDefaultTransport(aiTool: string | undefined): AgentTransport {
  return transportFor(aiTool);
}

/** The select value ('auto' | transport) for a stored `agent_backend` string. */
export function agentBackendSelectValue(stored: unknown): string {
  const ov = parseAgentBackend(stored);
  return ov.mode === 'auto' ? 'auto' : ov.transport;
}
