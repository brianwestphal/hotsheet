# 114 — ACP Channel (driving non-Claude agents via the Agent Client Protocol)

> **⚠ REVISED — the spike + the maintainer decision reframed this (2026-07-04, HS-9310).** ACP is **one of two co-equal drive transports**, not the sole Tier-A path. The HS-8008 spike found the *new* reference agent doesn't speak ACP: Gemini CLI (the impl this doc was built around) is **decommissioned**, and its replacement **Antigravity CLI (`agy`)** is Codeium-based and speaks **MCP + Claude-style hooks** — verified live driving Hot Sheet on the same rails as Claude (that path is now its own doc, [115-mcp-hooks-agent-channel.md](115-mcp-hooks-agent-channel.md)). The maintainer's call: *"use ACP when appropriate and MCP when appropriate — pick per agent."* So **this ACP transport is the live path for genuinely-ACP-native agents — OpenCode, Goose, Kiro, and Codex via the Zed adapter** (docs/113 §113.2 A2), selected by the `ai_tool` capability table. It is NOT deprecated — it is co-equal with docs/115. The lead ACP agent is now **OpenCode** (not Gemini). The pure `src/acp/acpMapping.ts` core still holds. **Do not build `src/acp/client.ts` for Antigravity** — that agent uses docs/115.
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

### 114.5.1 — Maintainer unblock + build status (HS-9330, 2026-07-12)

Maintainer decision: *"we can generalize the permissions support and not worry about backwards compatibility — the current impl isn't great and is seldom used."* That lifts the "must not regress the shipped Claude permission path" constraint that had deferred this.

**Shipped (client foundation + option-capable overlay):**
- **`src/client/permissionOptions.ts`** (pure, shared vocabulary) — `PermissionOption { optionId, name, kind }` (mirrors `acpMapping.ts::AcpPermissionOption`), `standardClaudeOptions()` (the synthesized allow/allow-always/deny triple the Claude/MCP-hooks path uses), `optionKindToBehavior(kind)` (allow_* → `allow`, else fail-closed `deny` — the map onto the legacy `PermissionRespondSchema` wire), `isAllowKind`/`firstAllowOption`/`firstRejectOption`. Unit-tested.
- **`src/client/permissionOverlay.tsx`** — `PermissionData` gained `options?: PermissionOption[]`; when present, the overlay renders ONE button per option (class `.permission-popup-option`, `data-option-id`/`data-kind`), skipping the fixed Allow/Deny icons + the always-allow affordance, and maps the chosen option's `kind` → behavior for the current wire. **Additive: the legacy Claude layout is untouched when no options are supplied.** Styling in `styles.scss` (`.permission-popup-options`). Unit-tested (render + click).

**Shipped (server relay — item 1, HS-9330):** the ACP permission round-trip goes through a **main-server bridge** (`src/acp/acpPermissionBridge.ts`), NOT the channel-server store — because `acpDrive` runs in the main server and the agent's `session/request_permission` reaches `acpClient` in-process (no channel-server hop). `injectAcpPermission({ secret, tool_name, description, input_preview?, options })` registers a pending request + returns a Promise that resolves when the user picks an option; `resolveAcpPermission(request_id, { optionId } | { cancelled })` / `dismissAcpPermission` resolve it; `pendingAcpPermissionForSecret` surfaces it. Wiring:
- **Surface** — `GET /api/projects/permissions` (`routes/projects.ts`) checks the bridge first per project secret and, when an ACP request is pending, returns it (with `options`) through the SAME per-secret poll the Claude popup uses → one overlay, both transports. `PendingPermissionEntrySchema` (`schemas.ts`) gained `options?`.
- **Respond** — `POST /channel/permission/respond` (`routes/channel.ts`) routes an ACP `request_id` (via `hasAcpPermission`) to `resolveAcpPermission` with the client's chosen `option_id` (no channel-server hop); `PermissionRespondSchema` (`validation.ts`) gained `option_id?`, and the client (`permissionOverlay.tsx::respondToPermission`) sends it from the clicked option's `data-option-id`.
- Bumping/resolving calls `notifyPermission()` so the long-poll surfaces/clears promptly. Unit-tested: `acpPermissionBridge.test.ts` (5) + `channelPermissionMultiServer.test.ts` ACP branch (2). Inert in production until `acpDrive` calls `injectAcpPermission` (below).

**Item 2 SHIPPED + live-validated (§114.12):** `acpDrive.ts::requestPermission` (`makeBridgeResolver`) now maps the ACP `toolCall` (via `acpToolCall.ts::extractToolCallDisplay`) + injects it into the bridge, with turn-end/dismiss cleanup — validated against a REAL OpenCode turn (the `toolCall`/`options`/`stopReason` shapes are captured, the permission callback fired, the turn completed).

**Remaining:** the auto-allow gate (map ACP `kind` → `permission_allow_rules` + `pickAllowOptionId`); OpenCode `ai_tool` label/skills wiring; and a full in-app end-to-end — gated on **HS-9340** (implement `fs/read_text_file`/`fs/write_text_file` so edits actually land — opencode delegates them) + **HS-9341** (ensure opencode `permission: ask` so the overlay is used at all). See §114.12.

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
5. **Per-tool enablement** — one ticket per ACP-native Tier-A agent (**OpenCode first** — the lead ACP agent now that Gemini CLI is decommissioned; then Goose + Kiro; Codex via the Zed adapter; Copilot CLI last — public-preview ACP): command template + ACP wiring + skills + smoke test. *(Antigravity is NOT here — it's MCP+hooks, docs/115.)*

## 114.9 Open decisions

- **O1 — first agent / order. ✅ RESOLVED (2026-07-04):** **OpenCode first** (the lead ACP-native agent; Gemini CLI is decommissioned), then Goose + Kiro, Codex via the Zed adapter, Copilot CLI last. *(docs/113 §113.5 O1.)*
- **O2 — Claude on ACP?** Keep Claude on the MCP-notification channel; evaluate the Zed `claude-agent-acp` adapter as a later *unification* (not a rewrite). *(docs/113 §113.5 O2.)*
- **O3 — permission overlay: adapt in place vs. a parallel renderer?** Recommend adapting `permissionOverlay.tsx` to a supplied-option-list model (Claude's fixed triple becomes one hard-coded option set), so both channels share one overlay.
- **O4 — which client capabilities to grant** (`fs/*`, `terminal/*`)? Recommend v1 grants NONE beyond `requestPermission` (the agent uses its own fs/terminal); revisit `terminal/*`→§22 PTYs later.

## 114.10 Testing

- **Unit** — the ACP message → Hot Sheet mapping (update→busy, stopReason→done, option-list→overlay→optionId) as pure functions over mocked ACP messages; the per-agent command-template resolution.
- **Integration / spike** — drive a real Gemini CLI (`src/acp/client.ts`) through initialize → session/new (with the Hot Sheet MCP server) → session/prompt → a `session/request_permission` → a `stopReason`; assert each seam. This is the HS-8008 spike, run against real tools (a manual/paired step, like the mTLS Phase-A validation).
- **Double coverage** — as the per-agent enablement lands, each Tier-A agent gets a smoke test.

## 114.11 OpenCode spike — the ACP design VALIDATED against a real agent (HS-9330, 2026-07-05)

The lead ACP agent, **OpenCode 1.17.9** (`opencode acp` — "start ACP (Agent Client Protocol) server"), was probed live. Unlike Antigravity, it **is** genuinely ACP-native, so the design above holds. Confirmed by real handshakes (no LLM turn triggered — stopped at `session/new`):

- **ACP v1 over newline-delimited JSON-RPC on stdio.** `initialize` → `{ protocolVersion: 1, agentInfo: { name: "OpenCode", version: "1.17.9" }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { embeddedContext: true, image: true }, sessionCapabilities: { close, fork, list, resume } }, authMethods: [{ id: "opencode-login", … }] }`. Framing is `\n`-delimited (not Content-Length).
- **`session/new` with a STDIO `mcpServers` entry works** — returns a real `sessionId` (e.g. `ses_…`), so **the `hotsheet_*` channel MCP server rides ACP unchanged** (§114.4 confirmed). The entry schema (surfaced by a validation error) is a union: **stdio `{ name, command, args, env }`** | **sse `{ type: "sse", url, headers }`**. `env` MUST be an **array** of `{ name, value }` (an object is rejected). We reuse the SAME cwd-resolving `getChannelServerPath()` command Claude/Antigravity use, with `env: []`.
- **The `session/update` stream fires** — right after `session/new` an `available_commands_update` notification arrived (the busy-signal channel, §114.6, confirmed).
- **Extensions to note:** `session/new` returns `configOptions` (a model selector + a `build`/`plan` session-mode selector) — an OpenCode-specific result field; and `authMethods` means the client may need to surface an auth step (`opencode auth login`).
- **Protocol core landed + fully unit-tested (HS-9330)** — everything buildable without a live agent or UI change:
  - `src/acp/acpAgents.ts` — `resolveAcpAgentCommand` (`opencode` → `opencode acp`), `isAcpDrivenTool`, `buildHotsheetMcpServerEntry` (the validated stdio entry), `ACP_PROTOCOL_VERSION = 1`.
  - `src/acp/acpFraming.ts` — newline-delimited JSON-RPC framing: `encodeMessage`, streaming `createNdjsonDecoder` (partial-line buffering, blank/non-JSON skip), request/response/notification discriminators, an id counter.
  - `src/acp/acpClient.ts` — `createAcpClient(transport, callbacks)`: a **transport-injected** session driver that runs `initialize → session/new (+ the hotsheet MCP entry) → session/prompt`, routes `session/update`→`onBusy` (via `classifyUpdate`), the terminal `stopReason`→`onTurnEnd` (via `turnEndOutcome`), and `session/request_permission`→a caller-supplied resolver (deny-by-default when none; method-not-found for other agent→client requests). Built on `acpMapping.ts`.
  - **32 unit tests** across the four `acp/` modules, exercised against the REAL captured OpenCode message shapes (a scripted mock transport — no spawn/auth/LLM turn).
- **Real-IO drive edge + play-button routing landed + unit-tested (HS-9330):**
  - `src/acp/acpDrive.ts` — `isAcpDriven(dataDir)` + `spawnAcpRun(dataDir, serverPort, content, deps)`: spawns the ACP agent (`opencode acp`, `stdio: ['pipe','pipe','ignore']` so its stderr logs can't block it), pipes child `stdout`→`createAcpClient.receive` and `transport.send`→child `stdin`, and wires `onBusy`→`/channel/heartbeat` (activity beats + a 15s timer backstop) and `onTurnEnd`/`error`/`exit`→`/channel/done` + `idle`, fired exactly once so busy can never stick. Parallels `antigravityDrive.ts`; the child process + spawn/heartbeat/done are all **injected**, so the whole wiring is unit-tested against a scripted fake agent (**9 tests**, real OpenCode message shapes — no spawn/auth/LLM turn).
  - Play-button routing wired in `channel-config.ts::triggerChannel` (after the Antigravity branch): `isAcpDriven(dataDir)` → `spawnAcpRun`, bypassing the channel-port path like Antigravity. Dormant until a project sets `ai_tool='opencode'` (already a selectable option).
- **Remaining for the client (HS-9330):** the **option-driven §47 overlay UI rewrite** (accept `PermissionOption[]`, return `optionId` — ⚠ touches the shipped Claude permission path) + the auto-allow gate mapping (ACP `toolCall`→`permission_allow_rules`, which needs a **real** `session/request_permission` captured from a live turn to pin the `toolCall` shape — the spike stopped at `session/new`, before any tool call, so `requestPermission` is currently an injected deny-by-default seam); OpenCode `ai_tool` label/skills wiring; and a **live `session/prompt`→`stopReason` smoke test** (needs `opencode auth`, a manual/paired step). The **`--print`/one-shot vs. persistent** question doesn't apply — ACP is inherently a persistent session.

## 114.12 Live turn VALIDATED — permission wiring + captured toolCall/fs shapes (HS-9330 item 2, 2026-07-12)

Ran a **live OpenCode turn** (v1.17.18, OpenAI provider) end-to-end through the REAL `acpClient` module (not a mock): `initialize` → `session/new` (with the `hotsheet_*` MCP entry) → `session/prompt` → **`stopReason: end_turn`** (`onTurnEnd('completed','end_turn')`), and a real `session/request_permission` routed through the `requestPermission` callback. Item 2 (permission wiring) is now built + validated.

**Captured `session/request_permission` shape** (an `edit` tool):
```
{ sessionId, toolCall: { toolCallId, title: "<file path>", kind: "edit", status: "pending",
    locations: [{ path }], rawInput: { filepath, diff }, content: [{ type: "diff", oldText, newText }] },
  options: [ {optionId:"once",kind:"allow_once",name:"Allow once"},
             {optionId:"always",kind:"allow_always",name:"Always allow"},
             {optionId:"reject",kind:"reject_once",name:"Reject"} ] }
```
`options` is **exactly** our `{ optionId, name, kind }` — pass straight through to the overlay. Shipped:
- **`src/acp/acpToolCall.ts`** — `extractToolCallDisplay(toolCall)` → `{ tool_name (=kind), description (=title), input_preview (=the diff, else rawInput JSON, capped 2000) }`. Pure, tested against the captured fixture.
- **`src/acp/acpDrive.ts`** — the default `requestPermission` (`makeBridgeResolver`) maps the toolCall via `extractToolCallDisplay` + injects it into `acpPermissionBridge` (§114.5.1 item 1) → the §47 overlay → the user's `optionId` flows back as the ACP reply. A pending request is **dismissed (→ cancelled) if the turn ends first** (tracked in a per-run set, cleared in `finish()`), so an abandoned prompt can't hang the agent. Unit-tested (permission-relay + turn-end-dismiss) against the captured shape.

**Two live findings → follow-ups:**
- **HS-9340 (edits don't land):** after granting permission, OpenCode DELEGATES the write via an `fs/write_text_file` REQUEST (`{ sessionId, path, content }`) — **regardless of our `clientCapabilities.fs.writeTextFile:false`**. `acpClient` replies method-not-found, so the file write FAILS (turn still completes). Need to implement `fs/write_text_file` (reply `{}`) + `fs/read_text_file` (`{sessionId,path}`→`{content}`) in `acpClient.route()`. Verified: replying `{}` makes the turn complete cleanly.
- **HS-9341 (overlay inert by default):** OpenCode AUTO-APPROVES tools unless its config sets `permission: { edit:"ask", bash:"ask" }` — so the overlay is never used until Hot Sheet ensures that config (per-project `opencode.json`, or ideally the per-session `session/set_config_option`/`session/set_mode` methods the spike surfaced).

**Still remaining on HS-9330:** the auto-allow gate (map ACP `kind` → `permission_allow_rules` + `pickAllowOptionId`); OpenCode `ai_tool` label/skills wiring; and a full in-app end-to-end (play button → overlay → choice → agent) once HS-9340/9341 land so a real edit actually applies.
