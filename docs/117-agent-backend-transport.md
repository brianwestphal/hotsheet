# 117. Agent-backend transport selection — the per-agent capability table

Status: **Capability table + auto-routing SHIPPED (HS-9331); Settings picker + full
MCP-hooks generalization = follow-ups.**

## 117.1 Problem

Tier-A drive (Hot Sheet driving a CLI agent through the play button) is **two co-equal
transports** chosen per agent by the protocol it speaks (maintainer decision, HS-9310):
**MCP+hooks** (docs/115 — Antigravity) and **ACP** (docs/114 — OpenCode et al.). Before
HS-9331 the play-button path (`channel-config.ts::triggerChannel`) chose the transport
with **two hard-coded per-agent gates** — `isAntigravityDriven(dataDir)` then
`isAcpDriven(dataDir)` — so every new agent needed a new one-off `if`. HS-9331
generalizes that into a single capability table.

## 117.2 The capability table (`src/agentTransport.ts`)

`resolveAgentTransport(aiTool)` → one of three transports:

| Transport | Doc | Agents | Play-button handler |
|-----------|-----|--------|---------------------|
| `mcp-hooks` | docs/115 | `antigravity` (membership set `MCP_HOOKS_AGENTS`) | `spawnAgyRun` (one-shot `agy --print`) |
| `acp` | docs/114 | any tool with an ACP entrypoint — derived from `isAcpDrivenTool` (`opencode`; Goose/Kiro/Codex-via-adapter as they enable) | `spawnAcpRun` (spawn `opencode acp`, drive one turn) |
| `claude-channel` | docs/12 | `claude` / `auto` / unset + editor-only tools (Cursor/Copilot/Windsurf) | the persistent channel-port `/trigger` path |

Precedence: MCP-hooks agent → ACP agent → Claude channel (the default). Case-insensitive.
`resolveProjectTransport(dataDir)` is the thin wrapper that reads `ai_tool` and maps it.

`triggerChannel` now consults the table (one `resolveProjectTransport` + a switch)
instead of the two gates. **Adding an agent no longer touches `triggerChannel`:**
- a new **ACP** agent → add its entrypoint in `acpAgents.ts::resolveAcpAgentCommand`
  (it's automatically routed via `isAcpDrivenTool`);
- a new **MCP-hooks** agent → add it to `MCP_HOOKS_AGENTS` **and** give it a spawn
  handler (today `spawnAgyRun` is agy-specific — see §117.4).

## 117.3 Settings "Agent backend" picker (follow-up — not built)

docs/114 §114.7 envisions a per-project **override** of the auto-derived transport
(`claude-channel-mcp` / `mcp-hooks:<command>` / `acp:<command>`), defaulting from the
capability table. Deferred because it carries real design questions (§117.5) and the
auto-derivation covers the common case (one transport per agent today). Tracked as a
follow-up; the capability table already exposes the default the picker would seed from.

## 117.4 Generalizing the MCP-hooks transport (follow-up — premature)

The MCP-hooks handler (`antigravity.ts` config-writer + `antigravityDrive.ts` spawn) is
still agy-specific (`agy --print`, `~/.gemini/config/mcp_config.json`). Generalizing it
to an arbitrary `mcp-hooks:<command>` agent (parameterized binary + config location +
hook install) is only worthwhile once a **second** MCP-native agent lands — until then
it would be speculative. The capability table is the seam that makes that future change
local (add to `MCP_HOOKS_AGENTS` + a handler). Tracked as a follow-up.

## 117.5 Open design questions (for the picker follow-up)

- **Override storage** — a new `agent_backend` setting, or derive-only with an explicit
  override key? Interaction with `ai_tool` (does the picker override the ai_tool-derived
  transport, or is it read-only display of the derived value + an "advanced" override?).
- **`<command>` capture** — how the `mcp-hooks:<command>` / `acp:<command>` forms specify
  the agent binary/entrypoint (free-text vs. derived from `ai_tool`).
- **§95 classification** — personal/Local vs. team/Shared for the override.

These are the maintainer's call (case-by-case per the §95 standing rule).
