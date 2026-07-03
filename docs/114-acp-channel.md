# 114 — ACP Channel (driving non-Claude agents via the Agent Client Protocol)

> **⚠ REVISED — the spike changed the answer (2026-07-04, HS-9310).** The HS-8008 spike ran against the actual reference agent and found it does **NOT** speak ACP. Gemini CLI (the ACP reference impl this doc was built around) is **decommissioned**; its replacement, **Antigravity CLI (`agy`)**, is Codeium-based and speaks **MCP + Claude-style hooks**, not ACP. Verified live: `agy` drives Hot Sheet via the `hotsheet_*` MCP tools end-to-end (read + write) with the standard `mcp_config.json` — i.e. **the same rails as Claude, no ACP client needed.** So the **primary Tier-A drive path is now MCP+hooks** (see [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md) §113.2 + the Antigravity integration tickets, HS-9319 →). The ACP design below is **retained as-is** for a genuinely-ACP agent should one appear (and the pure `src/acp/acpMapping.ts` core still holds), but it is no longer the default. Do not build `src/acp/client.ts` for Antigravity.
>
> **Status:** Design (HS-9310), gated on the HS-8008 spike validating the client shape against a real agent — **spike done; see the revision banner above.** The **design** here is grounded in the ACP v1 protocol (agentclientprotocol.com) + the HS-8007 investigation + the HS-8008 client-design spike; what's **pending the spike** is flagged inline (exact SDK API surface, per-agent entrypoints). This is the *agent-drive* layer of the multi-AI-tool epic ([113-multi-ai-tool-support.md](113-multi-ai-tool-support.md)) — the counterpart to the shipped *context* layer (skills + instructions). It does NOT touch the Claude channel ([12-claude-channel.md](12-claude-channel.md)), which stays as-is.
>
> Cross-refs: [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md) (the epic + the `ai_tool` setting), [12-claude-channel.md](12-claude-channel.md) (the current Claude MCP-notification channel this parallels), [47-richer-permission-overlay.md](47-richer-permission-overlay.md) (the permission popup ACP feeds), [63-mcp-tools.md](63-mcp-tools.md) (the `hotsheet_*` MCP tools that ride ACP unchanged).

## 114.1 Problem + scope

Every "drive the agent" surface in Hot Sheet is Claude-Code-proprietary (docs/113 §113.1): the play button fires a `notifications/claude/channel` MCP notification, busy-tracking is Claude-hook-based (`src/claude-hooks.ts` → `/channel/heartbeat`), channel-done is a curl-back, and the launch command is `claude --dangerously-load-development-channels`. To give the SAME play / permission / busy / done loop to **non-Claude Tier-A CLI agents** — **Codex, Gemini CLI, OpenCode, Goose, Copilot CLI** (docs/113 §113.2) — we add an **ACP client**.

**In scope:** an ACP client that spawns a Tier-A agent, sends prompts (the play button), renders progress (busy), routes permission requests to the §47 overlay, and detects turn-end (done). **Out of scope:** the Claude channel (unchanged), the editor-only Tier-B tools (Cursor/Windsurf/Copilot — context-only, docs/113 §113.2), and the `hotsheet_*` MCP tool surface (rides ACP untouched — §114.4).

## 114.2 What ACP is (and how it relates to MCP)

**Agent Client Protocol** — an open JSON-RPC-over-stdio protocol (HTTP transport in draft), Apache-licensed, from Zed Industries (co-stewarded with JetBrains). It standardizes the **editor ↔ agent** boundary the same way MCP standardizes the **agent ↔ tools** boundary. **They compose, they don't compete:** in a session the editor (Hot Sheet, the ACP *client*) hands the agent a list of MCP servers and the agent calls those MCP tools while streaming progress back over ACP. So Hot Sheet keeps its MCP server (the `hotsheet_*` ticket tools) AND adds an ACP client for the channel transport — ACP replaces the bidirectional *channel* (trigger + busy + permission + done), not the tool surface.

**Tool support (early 2026, per HS-8007):** native ACP — Gemini CLI (reference impl), Goose, OpenCode, Kiro CLI. Via the Zed adapter SDK — Claude Code, OpenAI Codex CLI. Public preview — GitHub Copilot CLI.

## 114.3 Client architecture

Hot Sheet is the **ACP client**: it CALLS the agent methods and IMPLEMENTS the client-side handlers. Using `@zed-industries/agent-client-protocol` (the TS SDK — **exact API surface to be pinned by the HS-8008 spike**):

1. **Spawn** the agent subprocess (per-agent entrypoint — Gemini's ACP mode, or the Zed adapter for Codex/Claude); its stdin/stdout are the JSON-RPC transport (the SDK handles framing).
2. **Connect**: construct the SDK's client-side connection with the subprocess stdio + a **client handler** object implementing `requestPermission` (and optionally `fs/read_text_file`·`fs/write_text_file`·`terminal/*` if we grant them).
3. **Lifecycle**: `initialize` (`protocolVersion`, `clientCapabilities`, `clientInfo`) → `session/new` (`cwd` = project root [abs], **`mcpServers`** = Hot Sheet's own MCP server, `additionalDirectories`) → `session/prompt` (`sessionId`, `prompt: ContentBlock[]`).

Proposed module: `src/acp/client.ts` (the connection + lifecycle) — greenfield (`src/acp/` doesn't exist; the SDK isn't yet a dependency).

## 114.4 The five Hot Sheet seams → ACP

| Hot Sheet surface (Claude, today) | ACP equivalent |
|---|---|
| Play button / channel trigger (`POST /trigger` → `notifications/claude/channel`) | **`session/prompt`** with the worklist text as a text `ContentBlock` |
| Busy tracking (`/channel/heartbeat` ← Claude hooks) | any **`session/update`** (`plan` / `agent_message_chunk` / `tool_call` / `tool_call_update` / `usage_update`) ⇒ busy — **replaces the Claude-hook heartbeat natively** for non-Claude agents |
| Channel-done (`hotsheet_signal_done` curl-back) | the `session/prompt` result's **`stopReason`** (`end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`) ⇒ done + busy-clear — **replaces the curl-back** |
| Permission popup (§47, `/permission` long-poll) | agent calls **`session/request_permission`** `{ sessionId, toolCall, options: PermissionOption[] }`; we render + reply `{ outcome }` (§114.5) |
| `hotsheet_*` MCP tools (§63) | **UNCHANGED** — passed via `session/new.mcpServers`; the agent calls them exactly as Claude does today |

Also available (not required v1): `session/cancel` (stop button), `session/set_mode`, `fs/*`, `terminal/*` (could drive §22 PTYs).

## 114.5 The permission overlay becomes option-driven (the one real surface change)

This is the HS-8008 spike's key finding. ACP's `session/request_permission` supplies the agent's OWN `options: PermissionOption[]` — each `{ optionId, name, kind }`, where `kind ∈ allow_once | allow_always | reject_once | reject_always`. The client must **render those options** (by `name`/`kind`) and reply with the chosen **`optionId`** — NOT the current fixed allow / allow-always / deny triple (`src/client/permissionOverlay.tsx`).

The `permission_allow_rules` auto-allow gate (`src/routes/channel.ts`, §47.4) still works: on a rule match, auto-pick the `allow_always` (or `allow_once`) option by `kind`. The `kind` set maps **1:1** onto our rule semantics — so this is a render/plumbing change (accept a supplied option list + return an id), not a permission-model change.

## 114.6 Busy / done via the update stream

The Claude path infers busy from PTY spinners + hook heartbeats (fragile, docs/12). ACP gives it natively: any `session/update` notification during a turn ⇒ busy; the turn's terminal `stopReason` ⇒ idle + channel-done. This is strictly cleaner and per-agent-uniform. The Claude channel keeps its hook mechanism (unchanged); only the ACP-backed agents use this path.

## 114.7 Agent-backend selection + command templates

Driven by the per-project **`ai_tool` setting** (docs/113 §113.3, shipped):
- A **Settings → Channel "Agent backend" picker** — `claude-channel-mcp` (current) vs `acp:<command>` — selects the transport per project (defaults derived from `ai_tool`).
- **Per-agent command templates** — `gemini` / `codex` / `opencode` / `goose` / `copilot-cli` — resolve the ACP-mode launch (the `{{aiCommand}}` resolution HS-8009 shipped grows the ACP entrypoints).
- **Commands Log labels** already reflect `ai_tool` via `agentDisplayName` (HS-9313).

## 114.8 Rollout (decomposition — all gated on the HS-8008 spike)

1. **Spike (HS-8008, done as design):** drive Gemini CLI end-to-end via the SDK — validate the connection + the five seams against a real agent.
2. **Core client** (`src/acp/client.ts`): connection + lifecycle + the `session/update`→busy and `stopReason`→done mapping. **Pure-mapping subset SHIPPED (HS-9310):** `src/acp/acpMapping.ts` — `classifyUpdate` (update→busy), `turnEndOutcome` (stopReason→completed/stopped/error, never leaves the channel stuck busy on a new reason), `pickAllowOptionId`/`pickRejectOptionId` (the §114.5 auto-allow/deny → `optionId` by `kind`). No SDK / no agent (ACP-v1-shape logic only), fully unit-tested; the connection/spawn/overlay-wiring remains spike-gated.
3. **Option-driven permission overlay** (§114.5): the §47 overlay accepts an ACP option list + returns an `optionId`; the auto-allow gate picks by `kind`.
4. **Agent-backend picker + per-agent templates** (§114.7).
5. **Per-tool enablement** — one ticket per Tier-A agent (Gemini first — reference impl; then Codex + OpenCode; then Goose; Copilot CLI last — public-preview ACP): command template + ACP wiring + skills + smoke test.

## 114.9 Open decisions

- **O1 — first agent / order.** Recommend Gemini CLI (the ACP reference impl → cleanest spike), then Codex + OpenCode, then Goose, Copilot CLI last. *(docs/113 §113.5 O1.)*
- **O2 — Claude on ACP?** Keep Claude on the MCP-notification channel; evaluate the Zed `claude-agent-acp` adapter as a later *unification* (not a rewrite). *(docs/113 §113.5 O2.)*
- **O3 — permission overlay: adapt in place vs. a parallel renderer?** Recommend adapting `permissionOverlay.tsx` to a supplied-option-list model (Claude's fixed triple becomes one hard-coded option set), so both channels share one overlay.
- **O4 — which client capabilities to grant** (`fs/*`, `terminal/*`)? Recommend v1 grants NONE beyond `requestPermission` (the agent uses its own fs/terminal); revisit `terminal/*`→§22 PTYs later.

## 114.10 Testing

- **Unit** — the ACP message → Hot Sheet mapping (update→busy, stopReason→done, option-list→overlay→optionId) as pure functions over mocked ACP messages; the per-agent command-template resolution.
- **Integration / spike** — drive a real Gemini CLI (`src/acp/client.ts`) through initialize → session/new (with the Hot Sheet MCP server) → session/prompt → a `session/request_permission` → a `stopReason`; assert each seam. This is the HS-8008 spike, run against real tools (a manual/paired step, like the mTLS Phase-A validation).
- **Double coverage** — as the per-agent enablement lands, each Tier-A agent gets a smoke test.
