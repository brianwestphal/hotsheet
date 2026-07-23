// HS-9380 — pure text for the multi-connection warning banner + the "Disconnect
// all" toasts, aware of the project's `ai_tool`. Pre-fix the strings hardcoded
// "Claude" (wrong for a Codex/Antigravity/OpenCode project) and always claimed
// "triggers route to the oldest one" — true only for the `claude-channel`
// transport (spawn-drive tools launch a fresh one-shot run per trigger, so
// multiple connections never misroute a trigger there). Kept pure (no DOM) so
// the wording is unit-testable; `channelUI.tsx` renders the strings.

import { deriveDefaultTransport } from './agentBackend.js';
import { agentDisplayName } from './agentName.js';

export interface MultiConnectionMessages {
  /** Banner text for the `#channel-multi-warning` strip (count \> 1). */
  warning: (count: number) => string;
  /** Toast after "Disconnect all" killed `killed` (\> 0) connections. */
  disconnectedToast: (killed: number) => string;
  /** Toast after "Disconnect all" found nothing to kill. */
  noneToast: string;
}

/** The warning/toast wording for a project's `ai_tool`. */
export function multiConnectionMessages(aiTool: string | undefined): MultiConnectionMessages {
  const agent = agentDisplayName(aiTool);
  if (deriveDefaultTransport(aiTool) === 'claude-channel') {
    // Claude-channel transport: triggers really do route to the FIFO leader, and
    // `/mcp` in the wanted Claude is the reconnect path.
    return {
      warning: (count) => `${String(count)} ${agent} connections active — triggers route to the oldest one. Disconnect all, then /mcp to reconnect the one you want.`,
      disconnectedToast: (killed) => `Disconnected ${String(killed)} ${agent} connection${killed === 1 ? '' : 's'} — run /mcp in the ${agent} you want to use to reconnect`,
      noneToast: `No ${agent} connections to disconnect`,
    };
  }
  // Spawn-drive transports (mcp-hooks / acp): the play button launches a fresh
  // one-shot run each time (its own MCP connection is tagged `drive` and not
  // counted here), so >1 mains = extra interactive agent sessions holding a Hot
  // Sheet MCP connection. No trigger misrouting, and `/mcp` is Claude-specific —
  // drop both claims.
  return {
    warning: (count) => `${String(count)} ${agent} sessions hold a Hot Sheet connection for this project. Play runs are unaffected; Disconnect all to clear stale sessions.`,
    disconnectedToast: (killed) => `Disconnected ${String(killed)} ${agent} connection${killed === 1 ? '' : 's'}`,
    noneToast: `No ${agent} connections to disconnect`,
  };
}
