# 117. Agent-backend transport selection — the per-agent capability table

Status: **Capability table + auto-routing SHIPPED (HS-9331); Settings picker + `agent_backend`
override SHIPPED (HS-9338); MCP-hooks registry generalization core SHIPPED (HS-9339 — a
second spawn agent = one descriptor; skills/hooks + the advanced `<command>` remain).**

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

## 117.4 Generalizing the MCP-hooks transport (HS-9339 — core SHIPPED)

The MCP-hooks drive is now **registry-driven** (`src/mcpHooksAgents.ts`). A spawn-based
MCP+hooks agent is one `McpHooksAgent` descriptor `{ aiTool, binary, spawnRun,
ensureMcpConfig }`; the registry `AGENTS` holds **Antigravity** as the first entry
(referencing the EXISTING, on-device-validated `spawnAgyRun` + `ensureAntigravityMcpConfig`,
so agy behavior is byte-identical — a pure re-routing). The ticket's three named targets
are generalized:

- **Spawner + routing** — `channel-config.ts::triggerChannel`'s `mcp-hooks` branch
  dispatches via `getMcpHooksAgent(ai_tool)?.spawnRun` (was a hard-coded `spawnAgyRun`).
- **Config writer** — `skills.ts` iterates `listMcpHooksAgents()` and calls each
  `ensureMcpConfig()` when its `binary` is on PATH (was a hard-coded agy `if`).
- **Capability table** — `agentTransport.ts::resolveAgentTransport` uses
  `isMcpHooksAiTool` (runtime lookup, keeps the `channel-config`↔`mcpHooksAgents` cycle
  init-safe) instead of a hard-coded `{antigravity}` set.

So **adding a second spawn agent = one descriptor** (no changes to `triggerChannel`, the
capability table, or the config loop). **NOT yet generalized:** the agent's worklist
SKILLS + interactive-permission HOOK stay agy-specific in `skills.ts` (their on-disk
format is agent-specific — generalize against a real second agent), and the advanced
`agent_backend` `<command>` override is still inert (it would let the override name the
binary; wire it when the second agent lands). **Claude is NOT in this registry** — it uses
the persistent `claude-channel` transport (docs/12), not a spawn, so it can't share this
handler.

**Future-agent candidates (per docs/113 §113.2).** The maintainer's intent (HS-9339) was
"build agy support so other tools plug in going forward" — this registry (for spawn-based
MCP agents) plus the ACP client (docs/114) and the capability table together serve that.
Note where the named candidates land: **Cursor** is **Tier B** (editor, context-only — Hot
Sheet doesn't drive it; already handled by skills/instructions, HS-8916), so it is NOT an
MCP-hooks registry candidate. **Codex** is **Tier A** but slated for the **ACP** transport
(Codex-via-Zed-adapter, docs/114 — tracked under HS-9330's per-agent follow-ups), so it
goes through the ACP client, not this spawn registry — unless a spike shows it's better
driven spawn-style, in which case it's a one-descriptor add here.

## 117.5 Design decisions (RESOLVED by the maintainer, 2026-07-06)

- **Override storage** — a new `agent_backend` setting that OVERRIDES the `ai_tool`-derived
  transport (`auto`/absent = derive). ✅ HS-9338.
- **`<command>` capture** — derive the binary from `ai_tool` for the common case; free-text
  `mcp-hooks:<command>` / `acp:<command>` only in an advanced expander. ✅ (parse/format
  shipped; the advanced input + honoring the command deferred to HS-9339.)
- **§95 classification** — **Local** (per-machine). ✅ HS-9338.
