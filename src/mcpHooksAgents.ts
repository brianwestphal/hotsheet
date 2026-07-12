// HS-9339 (docs/117 §117.4) — the per-agent registry for the MCP+hooks drive transport
// (docs/115). Generalizes the previously agy-specific wiring so a SECOND spawn-based
// MCP-native agent plugs in by adding ONE descriptor here — with no changes to
// `channel-config.ts::triggerChannel`, `agentTransport.ts` (the capability table), or
// the config-write loop in `skills.ts`.
//
// A descriptor is intentionally thin — it references the agent's EXISTING functions
// (Antigravity's `spawnAgyRun` + `ensureAntigravityMcpConfig`), so this is a pure
// re-routing: the shipped, on-device-validated agy behavior (HS-9319→9328) is unchanged.
//
// SCOPE: this generalizes the ticket's three named targets — the one-shot SPAWNER, the
// global-MCP-config WRITER, and the `mcp-hooks` ROUTING (by agent id). An agent's
// worklist SKILLS + interactive-permission HOOK stay per-agent in `skills.ts` (their
// on-disk format is agent-specific; generalize them against a real second agent when one
// lands — see the HS-9339 note). NOTE: Claude is NOT here — it uses the persistent
// `claude-channel` transport (docs/12), not a spawn, so it can't share this handler.

import { ensureAntigravityMcpConfig } from './antigravity.js';
import { spawnAgyRun } from './antigravityDrive.js';

/**
 * One spawn-based MCP+hooks agent. `aiTool` is the `ai_tool` id (lowercase). `binary`
 * is the executable that must be on PATH for the agent to be active (its config/hooks
 * are only wired, and the play button only spawns it, when the binary is present).
 */
export interface McpHooksAgent {
  aiTool: string;
  binary: string;
  /** Spawn a one-shot worklist run (= the play button). Returns whether it started. */
  spawnRun: (dataDir: string, serverPort: number, content: string) => boolean;
  /** Register the cwd-resolving `hotsheet-channel` MCP server in the agent's config. */
  ensureMcpConfig: () => void;
}

/** Antigravity (`agy`) — the first (currently only) spawn-based MCP+hooks agent. */
const ANTIGRAVITY: McpHooksAgent = {
  aiTool: 'antigravity',
  binary: 'agy',
  spawnRun: spawnAgyRun,
  ensureMcpConfig: () => { ensureAntigravityMcpConfig(); },
};

/** The registry. Add a second spawn-based MCP agent by appending one descriptor. */
const AGENTS: readonly McpHooksAgent[] = [ANTIGRAVITY];

/** The descriptor for an `ai_tool`, or null when it isn't a registered MCP-hooks agent. */
export function getMcpHooksAgent(aiTool: string | undefined): McpHooksAgent | null {
  const t = (aiTool ?? '').trim().toLowerCase();
  return AGENTS.find(a => a.aiTool === t) ?? null;
}

/** True when `ai_tool` names a registered MCP-hooks (spawn) agent. */
export function isMcpHooksAiTool(aiTool: string | undefined): boolean {
  return getMcpHooksAgent(aiTool) !== null;
}

/** Every registered MCP-hooks agent (for the `skills.ts` config-write loop). */
export function listMcpHooksAgents(): readonly McpHooksAgent[] {
  return AGENTS;
}
