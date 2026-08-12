/**
 * HS-9629 — decide whether an MCP client that connected to a channel-server is
 * a "warm-pool" client whose connection is held open structurally rather than
 * per interactive session.
 *
 * Codex runs in model-B (docs/129): a single, machine-global, persistent
 * `codex app-server` daemon spawns one `hotsheet-channel` MCP connection per
 * codex session as its OWN child and keeps it warm for the daemon's lifetime —
 * across Hot Sheet restarts and after individual codex TUI sessions end. Those
 * connections are genuinely alive (not OS orphans, not stale registry entries),
 * so they cannot be liveness-GC'd (`process.kill(pid,0)` reports them alive),
 * and the standing "never kill codex" rule forbids reaping them.
 *
 * Marking them (registry `warm: true`) excludes them from the multi-connection
 * warning count (and, via the shared `mainConnections` filter, from leader
 * preference + "Disconnect all") so the daemon's warm pool stops reading as N
 * duplicate MAIN connections — the confusing banner the user reported. The
 * warning still fires for genuine duplicate INTERACTIVE mains (the multi-Claude
 * misroute case it was built for). See `mainConnections` in `channelRegistry.ts`.
 *
 * Detection is by the MCP `clientInfo.name` from the `initialize` handshake —
 * the protocol's own identity signal, robust across platforms and not dependent
 * on fragile process-tree walking. Codex's rmcp client identifies with a name
 * containing `codex` (logged as `client-init` in `mcp.log` when it connects); we
 * match a case-insensitive `codex` substring so a version suffix / renamed
 * variant (`codex-cli`, `codex-mcp-client`) still matches. Claude Code
 * (`claude-code`) does not.
 */

/**
 * True when `clientName` identifies a codex MCP client (docs/129 model-B warm
 * pool). Case-insensitive substring match on `codex`; empty / undefined / null
 * → false (an unknown client is treated as a normal MAIN connection).
 */
export function isWarmPoolClient(clientName: string | undefined | null): boolean {
  if (clientName === undefined || clientName === null || clientName === '') return false;
  return clientName.toLowerCase().includes('codex');
}
