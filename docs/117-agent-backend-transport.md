# 117. Agent-backend transport selection — the per-agent capability table

Status: **Capability table + auto-routing SHIPPED (HS-9331); Settings picker + `agent_backend`
override SHIPPED (HS-9338); the advanced `<command>` input + MCP-hooks generalization =
HS-9339.**

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

## 117.3 Settings "Agent backend" picker (HS-9338, SHIPPED)

A per-project **override** of the auto-derived transport. Maintainer decisions (2026-07-06):

- **Storage** — a new `agent_backend` file setting (`file-settings.ts`). `auto`/absent =
  defer to the capability table; else force `claude-channel` / `mcp-hooks` / `acp`. The
  advanced `mcp-hooks:<cmd>` / `acp:<cmd>` forms carry a command (parsed + stored, but
  not yet consumed by the spawners — that's HS-9339). Pure parse/format in the shared
  **`src/agentBackendParse.ts`** (`parseAgentBackend` / `formatAgentBackend`), used by
  both server and client. `resolveEffectiveTransport(dataDir)` (`agentTransport.ts`) =
  the override when set, else `resolveProjectTransport`; `triggerChannel` now consults it.
- **§95 classification — Local** (per-machine; which agent/binary is installed varies by
  device). Added to `LOCAL_SCOPE_KEYS` + a `local-only` scoped control in `settingsScope.tsx`.
- **UI** — Settings → General "Agent backend" `<select>` (Auto / Claude channel / MCP +
  hooks / ACP). The "Auto" hint shows the **derived** transport for the current `ai_tool`
  via a client mirror (`src/client/agentBackend.ts::deriveDefaultTransport`).

**Deferred to HS-9339:** the advanced free-text `<command>` input (and honoring it in the
spawners) — the command does nothing until the MCP-hooks handler is generalized, so the
picker exposes the transport choice only for now. Tests: `agentBackendParse.test.ts`
(parse/format round-trip), `agentTransport.test.ts` (`resolveEffectiveTransport` override
precedence), `client/agentBackend.test.ts` (derive/select-value).

## 117.4 Generalizing the MCP-hooks transport (follow-up — premature)

The MCP-hooks handler (`antigravity.ts` config-writer + `antigravityDrive.ts` spawn) is
still agy-specific (`agy --print`, `~/.gemini/config/mcp_config.json`). Generalizing it
to an arbitrary `mcp-hooks:<command>` agent (parameterized binary + config location +
hook install) is only worthwhile once a **second** MCP-native agent lands — until then
it would be speculative. The capability table is the seam that makes that future change
local (add to `MCP_HOOKS_AGENTS` + a handler). Tracked as a follow-up.

## 117.5 Design decisions (RESOLVED by the maintainer, 2026-07-06)

- **Override storage** — a new `agent_backend` setting that OVERRIDES the `ai_tool`-derived
  transport (`auto`/absent = derive). ✅ HS-9338.
- **`<command>` capture** — derive the binary from `ai_tool` for the common case; free-text
  `mcp-hooks:<command>` / `acp:<command>` only in an advanced expander. ✅ (parse/format
  shipped; the advanced input + honoring the command deferred to HS-9339.)
- **§95 classification** — **Local** (per-machine). ✅ HS-9338.
