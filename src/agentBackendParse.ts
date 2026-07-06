// HS-9338 (docs/117 §117.3) — PURE parse/format for the `agent_backend` per-project
// drive-transport override. Kept in its own dependency-free module (no node, no DB, no
// client-only imports) so BOTH the server (`agentTransport.ts::resolveEffectiveTransport`)
// and the client Settings picker (`client/agentBackend.ts`) share one implementation.

/** The three co-equal Tier-A drive transports (docs/117 §117.2). */
export type AgentTransport = 'claude-channel' | 'mcp-hooks' | 'acp';

/**
 * The parsed `agent_backend` setting. `auto` = defer to the `ai_tool`-derived capability
 * table. `transport` = force a specific transport; the optional `command` (from the
 * advanced `mcp-hooks:<cmd>` / `acp:<cmd>` forms) names the agent binary/entrypoint
 * (plumbed for HS-9339 — not yet consumed by the spawners).
 */
export type AgentBackendOverride =
  | { mode: 'auto' }
  | { mode: 'transport'; transport: AgentTransport; command: string | null };

/**
 * Parse the `agent_backend` value. Tolerant — `auto`/empty/unknown → `auto` (safe
 * fallback to the capability table). Accepts `claude-channel` (alias `claude-channel-mcp`),
 * `mcp-hooks`, `acp`, and their `<transport>:<command>` advanced forms. Case-insensitive.
 */
export function parseAgentBackend(value: unknown): AgentBackendOverride {
  if (typeof value !== 'string') return { mode: 'auto' };
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'auto') return { mode: 'auto' };
  const colon = v.indexOf(':');
  const head = (colon >= 0 ? v.slice(0, colon) : v).trim().toLowerCase();
  const command = colon >= 0 ? (v.slice(colon + 1).trim() || null) : null;
  if (head === 'claude-channel' || head === 'claude-channel-mcp') return { mode: 'transport', transport: 'claude-channel', command };
  if (head === 'mcp-hooks') return { mode: 'transport', transport: 'mcp-hooks', command };
  if (head === 'acp') return { mode: 'transport', transport: 'acp', command };
  return { mode: 'auto' }; // unknown token → safe fallback
}

/**
 * Inverse of `parseAgentBackend`: build the stored string for a chosen transport (+
 * optional command). `auto` → `'auto'`. A command only attaches to `mcp-hooks`/`acp`
 * (claude-channel takes no command). Round-trips with `parseAgentBackend`.
 */
export function formatAgentBackend(override: AgentBackendOverride): string {
  if (override.mode === 'auto') return 'auto';
  const { transport, command } = override;
  const cmd = command !== null && command.trim() !== '' ? command.trim() : null;
  if (cmd !== null && (transport === 'mcp-hooks' || transport === 'acp')) return `${transport}:${cmd}`;
  return transport;
}
