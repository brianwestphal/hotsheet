# 115 — MCP + Hooks Channel (driving non-Claude MCP-native agents on the Claude rails)

> **Status: Shipped for Antigravity (HS-9319 → HS-9328); the transport-selection layer + other MCP-native agents remain.** This is the *MCP-transport* half of the multi-AI-tool agent-drive layer — the **counterpart to the ACP transport** ([114-acp-channel.md](114-acp-channel.md)). It exists because the HS-8008 spike found the reference Tier-A agent (**Antigravity CLI, `agy`**) speaks **MCP + Claude-style hooks, not ACP**, and drives Hot Sheet end-to-end on the **same rails Claude already uses** ([12-claude-channel.md](12-claude-channel.md)) — no new client protocol.
>
> **Maintainer decision (2026-07-04, HS-9310):** *"use ACP when appropriate and MCP when appropriate. If Antigravity wants MCP instead of ACP then use MCP."* Tier-A drive is **two co-equal transports selected per agent by the protocol the agent actually speaks** — MCP+hooks (this doc: Claude, Antigravity, …) and ACP (docs/114: OpenCode, Goose, Kiro, …). Neither is "primary"; the `ai_tool` setting picks the right one per project.
>
> Cross-refs: [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md) (the epic + the `ai_tool` setting + the per-agent transport table §113.2), [114-acp-channel.md](114-acp-channel.md) (the sibling ACP transport), [12-claude-channel.md](12-claude-channel.md) (the Claude MCP-notification channel this generalizes), [47-richer-permission-overlay.md](47-richer-permission-overlay.md) (the permission overlay the hook feeds), [63-mcp-tools.md](63-mcp-tools.md) (the `hotsheet_*` MCP tools every agent calls), [86-ai-assistant-setup.md](86-ai-assistant-setup.md) (managed instructions / skills).

## 115.1 Problem + scope

The play / permission / busy / done loop is Claude-Code-proprietary (docs/113 §113.1). But the two things that make it work — an **MCP server** exposing `hotsheet_*` (docs/63) and **lifecycle hooks** (`src/claude-hooks.ts` → `/channel/heartbeat`) — are not unique to Claude: **any MCP-native CLI agent with Claude-compatible hooks can ride the same rails.** Antigravity is exactly that agent, and the spike proved it (§115.2).

**In scope:** driving a non-Claude, MCP-native Tier-A CLI agent (Antigravity, shipped) via (a) writing Hot Sheet's `hotsheet_*` MCP server into the agent's config, (b) launching/prompting it from a terminal (the play button), (c) tracking busy/done, (d) routing its permission requests to the §47 overlay. **Out of scope:** the ACP transport (docs/114, for ACP-native agents), the editor-only Tier-B tools (context-only, docs/113 §113.2), and the `hotsheet_*` tool surface itself (unchanged — the agent calls it exactly as Claude does).

## 115.2 What the spike proved (Antigravity `agy`, live — HS-9310)

The HS-8008 spike ran `agy` (v1.0.16, Codeium/`jetski`-based) against a real config and cleaned up after:

- **No ACP** anywhere in the binary (no `agent-client-protocol` / `session/prompt` / `session/update`); it runs a local gRPC language server, not stdio JSON-RPC/ACP. Its `StopReason` is `codeium_common_go_proto.StopReason`, not ACP's.
- **MCP for tools** — `mcp.Session`/`mcp.ClientSession`/`mcp.Tool`; config at **`~/.gemini/config/mcp_config.json`** (standard stdio `command`/`args`/`env`, **identical shape to Claude's `.mcp.json`**). `agy plugin import claude` imports Claude marketplace *extensions* (not standalone `.claude/skills`).
- **Claude-style hooks** — `PreToolHooks` / `GetStopHooks` / `runStopHooks` / `HookRegistry` (analog of `src/claude-hooks.ts`), installed via `.agents/hooks.json`.
- **Drive surface** — `agy --print "<prompt>"` (non-interactive, `--print-timeout` 5m) or `-i` interactive; `--continue` / `--conversation <id>` resume; `--dangerously-skip-permissions`; `--model` / `--project` / `--add-dir`.
- **Proven end-to-end:** registered the `hotsheet-channel` MCP server, then `agy --print` **read** the real Up Next list AND **created** a ticket (HS-9318, since deleted) via the `hotsheet_*` tools — exit 0 both times.

## 115.3 Drive model — `--print` one-shot (shipped) + persistent hooks

**`--print` one-shot (shipped, HS-9321 — `src/antigravityDrive.ts`).** The play button spawns `agy --print "<worklist prompt>"` in the project directory. agy processes the worklist via the `hotsheet_*` MCP tools + the `.agents/skills` routine (HS-9326) and **calls `hotsheet_signal_done` from the prompt** — so "done" clears busy through the SAME path as Claude. As a backstop, a process exit that didn't signal done fires a fallback `/channel/done` so busy can't stick. `isAntigravityDriven(dataDir)` gates the path on `ai_tool === 'antigravity'`.

- **Busy heartbeats (HS-9327).** Long `agy` runs emit periodic heartbeats so the busy indicator doesn't lapse mid-run (agy, unlike Claude's interactive session, has no per-turn hook heartbeat in `--print` mode).
- **Interactive permissions (opt-in, HS-9327/9328).** With the `antigravity_interactive_permissions` setting on, Hot Sheet drops `--dangerously-skip-permissions` and installs a `.agents/hooks.json` **PreToolUse** hook (§115.5) so tool calls route through the §47 overlay; off = the batch run auto-approves.

## 115.4 The five Hot Sheet seams → MCP+hooks (Antigravity, shipped)

| Hot Sheet surface (Claude, today) | Antigravity MCP+hooks equivalent |
|---|---|
| Play button / channel trigger (`notifications/claude/channel`) | **spawn `agy --print "<worklist>"`** (`antigravityDrive.ts`) — the prompt is the trigger |
| Busy tracking (`/channel/heartbeat` ← Claude hooks) | **process alive** = busy, with periodic heartbeats for long runs (HS-9327) |
| Channel-done (`hotsheet_signal_done` curl-back) | the agent calls **`hotsheet_signal_done`** from the prompt (same path as Claude); process-exit fallback `/channel/done` as a backstop |
| Permission popup (§47, `/permission` long-poll) | opt-in **PreToolUse hook** (`antigravityPermissionHook.ts`) → surfaces to the §47 overlay, **polls `/permission/decision`** (no push back-channel), emits agy's allow/deny; default off = `--dangerously-skip-permissions` |
| `hotsheet_*` MCP tools (§63) | **UNCHANGED** — registered in `mcp_config.json`; the agent calls them exactly as Claude does |

## 115.5 Config write — the one real new surface (shipped, `src/antigravity.ts`)

Making an MCP-native agent Hot-Sheet-aware means **writing our MCP server into the agent's MCP config**. agy's config is **GLOBAL** (`~/.gemini/config/mcp_config.json`, relative to its `GeminiDir`) — not per-project like Claude's repo `.mcp.json`. Rather than merge/unmerge per launch, `ensureAntigravityMcpConfig` registers **ONE cwd-resolving entry** (key `hotsheet-channel`): the channel server is launched **without `--data-dir`**, so `channel.ts` resolves `.hotsheet` from agy's launch directory (its `dataDir` defaults to the relative `.hotsheet` + the HS-8934 cwd pointer). So a single global entry serves EVERY project — `agy` run in project A's dir drives A's Hot Sheet, in B's dir drives B's. Merge-not-clobber (the user's other MCP servers survive); `removeAntigravityMcpConfig` unregisters. Wired from `ensureSkillsForDir` when `ai_tool === 'antigravity'` and `agy` is on PATH.

The permission hook installs via a `.agents/hooks.json` PreToolUse entry that shells out to `<cli> __agy-permission-hook` (`antigravityPermissionHookCli.ts` → the IO-injected `runPermissionHook`).

## 115.6 Wiring into the `ai_tool` / transport model (shipped)

- **`ai_tool` accepts `antigravity`** (HS-9319) — `resolveCommand.ts` `CLI_AGENTS` includes it; `AGENT_BINARIES` maps `antigravity → agy`; `{{aiCommand}}` resolves to `agy`; `agentDisplayName` (`agentName.ts`, HS-9313) → "Antigravity working"/"idle".
- **Skills selectivity** — `ensureSkillsForDir` (`skills.ts`) seeds agy's `.agents/skills` worklist routine (HS-9326) when `ai_tool === 'antigravity'`.
- **Managed instructions (HS-9322)** — `aiInstructionsTools.ts` targets `AGENTS.md` for `antigravity` (agy reads AGENTS.md/GEMINI.md/.agents/rules — the AGENTS.md standard; also benefits Codex).
- **Commands Log labels** already reflect `ai_tool` via `agentDisplayName` (HS-9313).

## 115.6a Codex — the second MCP+hooks agent (SHIPPED, HS-9369)

Codex (`codex-cli`) is MCP-native (no ACP mode — `app-server` is its own
protocol), so per the HS-9310 pick-by-protocol principle it rides these rails.
Registered as the second `mcpHooksAgents.ts` descriptor (`aiTool: 'codex'`,
`binary: 'codex'`) — the registry generalization (HS-9339) held: no changes to
`triggerChannel`, `agentTransport.ts`, or the `skills.ts` config-write loop.

- **Drive (`src/codexDrive.ts`)** — `codex exec --json
  --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "<content>"`
  spawned in the project dir (the `agy --print` analog; the bypass flag is the
  `--dangerously-skip-permissions` analog — `exec` can't prompt, and the sandbox
  would block the channel server's localhost HTTP). Busy is asserted on spawn,
  re-asserted on the same 15s interval floor as agy **and event-driven** on every
  structured JSONL line (`parseCodexEventType`); exit posts `idle` + the
  fallback `/channel/done`. Captured event contract (codex-cli 0.145.0, live):
  `thread.started` / `turn.started` / `item.started` / `item.completed`
  (`item.type`: `mcp_tool_call`, `agent_message`, …) / `turn.completed`.
- **Config write (`src/codex.ts`)** — Codex's global config is TOML
  (`$CODEX_HOME`-aware `~/.codex/config.toml`, `[mcp_servers.<name>]`), so unlike
  agy's JSON we never hand-edit it: the shipped `codex mcp add hotsheet-channel
  -- <channel command…>` CLI owns the TOML (same-name add replaces in place), and
  a cheap text precheck (`codexConfigHasEntry`) keeps the ensure idempotent +
  stale-command-healing (a dev-registered path is replaced by the prod path on
  the next ensure). Same cwd-resolving single-global-entry model as §115.5.
- **Live-validated (2026-07-22):** `codex exec --json` with the registered
  channel server made real `hotsheet_*` `mcp_tool_call`s against the running
  instance end-to-end.
- **Permission overlay for codex is NOT yet built** — the drive defaults to
  auto-approve (the accepted Tier-A default); the PreToolUse-style hook → §47
  overlay needs Codex's hooks surface researched first (codex has hooks —
  `--dangerously-bypass-hook-trust` — but the config format is undocumented in
  `--help`). Tracked as HS-9359.

## 115.7 Remaining (not yet built)

- **Transport-selection layer / three-way "Agent backend" picker** — today the transport is wired directly off `ai_tool` (`isAntigravityDriven`); a general per-agent capability table (`ai_tool` → A1 MCP+hooks vs A2 ACP) + the Settings "Agent backend" picker (`claude-channel-mcp` / `mcp-hooks:<command>` / `acp:<command>`) is the shared generalization once a *second* MCP+hooks agent or the ACP transport lands. See docs/113 §113.4.
- ~~**Other MCP-native agents** — if another MCP+hooks CLI agent appears, generalize `antigravity.ts`'s config-writer + `antigravityDrive.ts`'s drive into a per-agent abstraction rather than agy-specific modules.~~ **Done:** the HS-9339 registry + Codex as the second agent (§115.6a) prove the abstraction.
- **Codex permission hook** — the §47 overlay for codex tool calls (HS-9359; see §115.6a).
- **Persistent-mode (`-i` / `--continue`) drive** — the `--print` one-shot is the shipped default; a long-lived session driven by `Stop`/`PreToolUse` hooks per-turn (like Claude's interactive channel) is a possible richer follow-up (the permission hook already exists; the session lifecycle does not).

## 115.8 Open decisions

- **O1 — config location.** Shipped as GLOBAL cwd-resolving (§115.5) — one entry serves all projects. Revisit only if a future agy version drops relative-cwd MCP resolution.
- **O2 — `.gemini` path stability.** `agy` reads Gemini-branded paths (`~/.gemini/`); if a future version changes this, detect the path from `agy` rather than hard-coding.
- **O3 — persistent mode.** Whether to build the `-i`/hooks session path at all, or keep `--print` one-shot as the only drive model. Deferred until there's a concrete need (`--print` covers the worklist-processing use case).

## 115.9 Testing

- **Unit (shipped):** `antigravity.test.ts` (MCP-config create / merge / no-clobber / remove), `antigravityDrive.test.ts` (`isAntigravityDriven`, `buildAgyRunArgs`, `spawnAgyRun`), `antigravityPermissionHook.test.ts` (the IO-injected allow/deny/timeout/poll flow), `aiInstructionsTools.test.ts` (AGENTS.md target), `resolveCommand` (antigravity → agy binary). **Codex (HS-9369):** `codexDrive.test.ts` (`buildCodexExecArgs`, `parseCodexEventType` against the captured 0.145.0 event shapes incl. chunk-split lines + plain-text warnings, spawn/heartbeat/idle/once-only-done lifecycle), `codex.test.ts` (`codexConfigHasEntry` section-scoped precheck, `ensureCodexMcpConfig` add/no-op/stale-re-add/unreadable/best-effort), plus codex rows in `mcpHooksAgents.test.ts` / `agentTransport.test.ts` / client `agentBackend.test.ts` / `channelUI.test.ts` (the HS-9364 "codex play still gated" regression pin).
- **Manual (HS-9326):** `docs/manual-test-plan.md` — the real `agy` end-to-end (CLI present + trusted workspace + play → `--print` → `hotsheet_*` tool calls → done), since a live `agy` isn't headlessly available (like the mTLS Phase-A validation).
- **Double coverage** — each drive path has a unit test (pure logic: config merge, command resolution, hook decision) plus the manual/smoke real-run entry, per the CLAUDE.md testing philosophy.
