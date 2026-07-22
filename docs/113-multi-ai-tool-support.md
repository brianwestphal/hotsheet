# 113 — Multi-AI-Tool Support (beyond Claude Code)

> **Status:** Design / epic umbrella (HS-8932). Hot Sheet is Claude-Code-specific across its "agent layer" (the play button, permission popup, busy-tracking, channel-done) and its command resolution; only skills/instructions generation is already multi-tool. Some users want to drive **other** AI coding tools — the maintainer's priority order: **Codex, Gemini CLI, OpenCode are critical; Goose next; Cursor / Windsurf / Copilot evaluated for feasibility.** This doc frames the epic, ties together the scattered tickets, and decomposes the work. Cross-refs: [12-claude-channel.md](12-claude-channel.md) (the current Claude channel), [47-richer-permission-overlay.md](47-richer-permission-overlay.md) (permission popup), [86-ai-assistant-setup.md](86-ai-assistant-setup.md) (managed instructions), and the two drive-transport docs — [114-acp-channel.md](114-acp-channel.md) (ACP, for ACP-native agents) + [115-mcp-hooks-agent-channel.md](115-mcp-hooks-agent-channel.md) (MCP+hooks, for MCP-native agents like Antigravity) — plus the ACP investigation (HS-8007, closed).

## 113.1 Problem

Every "drive the agent" surface is Claude-proprietary:

- **Launch** — `src/terminals/resolveCommand.ts` knows only `{{claudeCommand}}` → `claude --dangerously-load-development-channels server:hotsheet-channel-<slug>`.
- **Trigger / play button** — `src/channel.ts POST /trigger` fires a Claude-only MCP notification `notifications/claude/channel`.
- **Permission popup** — fed by the channel's Claude-only `/permission` long-poll.
- **Busy tracking** — `POST /channel/heartbeat` driven by **Claude Code hooks** (`src/claude-hooks.ts`).
- **Channel-done** — a curl-back (`hotsheet_signal_done` / `POST /api/channel/done`).

What's already tool-agnostic: **skills/rules generation** for Claude/Cursor/Copilot/Windsurf (`src/skills.ts::ensureSkillsForDir`), and (HS-8916) the **managed instruction sections** for Claude/Cursor/Windsurf/Copilot (`src/aiInstructionsTools.ts`). The MCP **tool surface** (`hotsheet_*`, `src/channel.tools.ts`) is protocol-agnostic — any agent that speaks MCP can call it; it's the CHANNEL transport that's Claude-only.

## 113.2 Two kinds of "AI tool" — the taxonomy that drives the design

Not every tool integrates the same way. Splitting them is the key architectural decision:

- **A. CLI agents Hot Sheet DRIVES (the play/permission/busy loop).** Terminal agents that Hot Sheet launches + prompts + gets permission requests from. **Codex CLI, Antigravity (`agy`), OpenCode, Goose, Copilot CLI.** **⚠ REVISED (2026-07-04, HS-9310 spike + maintainer decision):** the HS-8007 investigation assumed all of these speak **ACP** (Gemini CLI the reference). The spike changed that: Gemini CLI is decommissioned, and its replacement **Antigravity** speaks **MCP + Claude-style hooks, NOT ACP** — proven driving Hot Sheet on the same rails as Claude. The maintainer's call: **use ACP when appropriate and MCP when appropriate — pick the transport per agent by the protocol it actually speaks.** So Tier-A splits into **two co-equal drive transports**, selected by the `ai_tool` capability table (neither is "primary"):
  - **A1 — MCP + hooks** ([115-mcp-hooks-agent-channel.md](115-mcp-hooks-agent-channel.md)): MCP-native agents driven on the Claude rails — register `hotsheet_*` in the agent's `mcp_config.json`, launch/prompt from a terminal, busy/done via process lifecycle (`--print`) or Claude-style hooks. **Claude** (its existing channel, docs/12) and **Antigravity (`agy`)** are here.
  - **A2 — ACP** ([114-acp-channel.md](114-acp-channel.md)): ACP-native agents driven via the Agent Client Protocol client — `session/prompt` = play, `session/update` = busy, `stopReason` = done, `session/request_permission` = the §47 overlay. **OpenCode, Goose, Kiro** (native ACP), and **Codex** via the Zed adapter are here.

  Per-agent binary may differ from the id (Antigravity → `agy`). Note MCP composes with *both* transports — the `hotsheet_*` tools ride ACP unchanged (docs/114 §114.2) and are the *whole* transport for A1.
- **B. Editor-integrated tools Hot Sheet only SUPPLIES CONTEXT to.** **Cursor, Windsurf, GitHub Copilot (in-editor).** Hot Sheet doesn't launch/drive them; it writes their rules/instructions files so they follow the ticket-driven conventions. This is **already shipped** — skills (`skills.ts`) + instructions (HS-8916). No agent-drive loop applies.

The per-project **`ai_tool` setting** selects which tool a project uses; the setting then routes: which launch command, which skills to seed, **which drive transport (A1 MCP+hooks vs A2 ACP) to use**, and the Commands Log label.

## 113.3 Architecture

1. **Per-project `ai_tool` setting** (HS-8009) — `ai_tool` in `<dataDir>/settings.json`, enum `claude | codex | gemini | opencode | goose | cursor | copilot | windsurf | auto` (default `auto` = today's detect-everything). Surfaced in Settings → General. Drives:
   - **Command resolution** — **SHIPPED (HS-8009):** `resolveCommand.ts` `pickAiCommand` reads `ai_tool`; an explicit CLI agent (`codex`/`gemini`/`opencode`/`goose`) makes `{{aiCommand}}` (+ the back-compat `{{claudeCommand}}`) launch that tool's bare binary (or the shell if absent); `auto`/`claude`/editor-tools keep today's Claude behavior. (The channel/play loop for non-Claude agents is still ACP — until then the terminal just runs the tool's REPL.)
   - **Skills selectivity** — **SHIPPED (HS-9311):** `ensureSkillsForDir` (`skills.ts`) gates each tool's block on `wantsTool(dataDir)` — an explicit `ai_tool` seeds only that tool's dirs; `auto` keeps detect-all. Non-destructive (narrowing never deletes already-seeded files). Tested incl. the auto→explicit narrowing case.
   - **Drive-transport selection** — a per-agent capability table maps `ai_tool` → the transport it speaks (A1 MCP+hooks: claude, antigravity; A2 ACP: opencode, goose, kiro, codex-via-adapter). The channel uses that transport: MCP-config write + terminal drive (docs/115) or the ACP client (docs/114). *(HS-9310.)* Note the enum must gain **`antigravity`** (docs/115 §115.6).
   - **Busy labels** — **SHIPPED (HS-9313):** `ai_tool` threaded into the client `AppSettings` (hydrated from the resolved file-settings in `settingsLoader.tsx`); `agentDisplayName(ai_tool)` (`agentName.ts`) drives the channel busy indicator ("Codex working"/"Codex idle" vs "Claude working"); `auto`/`claude`/unknown → "Claude". (The Claude-channel *connection* instruction stays Claude-specific until ACP lands.)
2. **Two drive transports, selected per agent** (HS-9310):
   - **A1 — MCP + hooks** (`docs/115`) — for MCP-native agents (Claude, Antigravity). Write `hotsheet_*` into the agent's `mcp_config.json` (a per-agent variant of `registerChannelAt`), launch/prompt from a terminal, busy/done via process lifecycle (`agy --print`: exit = done) or Claude-style hooks (persistent mode). Reuses the Claude channel machinery (docs/12).
   - **A2 — ACP client** (HS-8008 spike → `docs/114`) — for ACP-native agents (OpenCode, Goose, Kiro, Codex-via-adapter). `src/acp/client.ts`: spawn the agent, JSON-RPC/stdio, `initialize` → `session/new` → `session/prompt` (= play), render `session/update` (= busy), map `session/request_permission` → the §47 overlay (its `allow_once`/`allow_always`/`reject_once`/`reject_always` map **1:1** onto `permission_allow_rules`), map `stopReason` → done + busy-clear.
   - A **Settings → Channel "Agent backend" picker** (`claude-channel-mcp` / `mcp-hooks:<command>` / `acp:<command>`) selects the transport, defaulting from the `ai_tool` capability table.
3. **Skills + instructions** — already multi-tool (`skills.ts`, `aiInstructionsTools.ts` / HS-8916). Extend `skills.ts` detection to the Tier-A CLI agents (Codex/Gemini/OpenCode/Goose) if they warrant their own rule files.

## 113.4 Decomposition (sub-tickets)

Per the maintainer's "make sub-tickets for all the aspects." Grouped:

**Foundations**
- **`ai_tool` setting + command resolution + skills selectivity** (HS-8009, exists as a ticket). The channel-command + skills halves ship independently of ACP.
- **ACP client spike** (HS-8008, exists) — drive Gemini CLI end-to-end (play + permission), validate the design.

**Drive-transport rollout (post-spike; two transports per the maintainer decision)**
- Requirements docs: **`docs/114`** (ACP transport) + **`docs/115`** (MCP+hooks transport) — both landed.
- **Transport-selection layer** — the per-agent `ai_tool` → transport capability table + the three-way "Agent backend" picker (`claude-channel-mcp` / `mcp-hooks:<command>` / `acp:<command>`). Shared by both transports.
- **A1 MCP+hooks (docs/115): SHIPPED for Antigravity (HS-9319→9328)** — `ai_tool: 'antigravity'` resolution + the global cwd-resolving `mcp_config.json` writer (`antigravity.ts`) + the `agy --print` drive with busy heartbeats (`antigravityDrive.ts`) + the opt-in PreToolUse→§47 permission hook (`antigravityPermissionHook*.ts`) + AGENTS.md instructions + `.agents/skills` worklist routine. Remaining: generalizing to other MCP-native agents + persistent mode.
- **A2 ACP (docs/114):** the ACP client (`src/acp/client.ts`, atop the shipped `acpMapping.ts` core) → the option-driven §47 overlay → per-agent ACP command templates.
- Per-agent command templates + Commands Log labels (the `{{aiCommand}}` resolution, HS-8009) for both transports.

**Per-tool enablement** (one ticket per Tier-A agent): each = command template + the agent's transport wiring (A1 or A2) + skills + Commands Log label + smoke test. **Antigravity (A1) and OpenCode (A2) are the two lead agents** (one per transport, per the maintainer's OpenCode-critical + Antigravity-is-the-real-reference calls).

**Editor tools (Tier B — largely done)**
- Instructions: Cursor / Windsurf / Copilot — **SHIPPED (HS-8916)**.
- Skills/rules: Cursor / Copilot / Windsurf — already in `skills.ts`.

## 113.5 Open decisions (maintainer)

- **O1 — Tier-A transport per agent. ✅ RESOLVED (2026-07-04):** two co-equal transports, chosen by the protocol each agent speaks — MCP+hooks (A1: Claude, Antigravity) + ACP (A2: OpenCode, Goose, Kiro, Codex-via-adapter). Lead agents: **Antigravity (A1)** + **OpenCode (A2)**. *(Was: "Gemini first" — Gemini CLI is decommissioned.)*
- **O2 — Claude on ACP?** Keep Claude on the current MCP-notification channel (it's the canonical A1 case now); evaluate the Zed Claude-ACP adapter as a *unification* follow-up (not a rewrite). Unchanged.
- **O3 — `ai_tool` default.** `auto` (detect-everything, today's behavior) vs. a first-launch picker. Recommend `auto` default + a Settings dropdown (no onboarding dialog — polish, per HS-8009).
- **O4 — Cursor/Windsurf/Copilot as "drivable"?** They're editor-integrated, not CLI agents — recommend **context-only** (skills+instructions, done), NOT part of either drive transport. Confirm.
- **O5 — new: does the `ai_tool` enum gain `antigravity`?** Yes (docs/115 §115.6) — needed for command resolution + display name + transport selection. Filed as a follow-up.

## 113.6 Per-tool compatibility matrix (status)

Which integration aspect each `ai_tool` supports today. **Keep this current** when a tool's support changes (a new drive transport enabled, a skill generator added, etc.). Evidence for each cell lives in the code cited in the surrounding sections.

Legend: ✅ Full · ◐ Partial · ⏳ Planned (design-only) · — None · N/A (not applicable by design). `auto` behaves as **claude**; `gemini` is in the UI picker but its CLI is decommissioned; `kiro` is docs-only (not in the picker).

| Integration aspect | claude | antigravity | opencode | codex | goose | gemini | cursor | copilot | windsurf |
|---|---|---|---|---|---|---|---|---|---|
| **1. Launch command** (`{{aiCommand}}`, `resolveCommand.ts`) | ✅ | ✅ (`agy`) | ✅ | ✅ | ✅ | ✅ | N/A | N/A | N/A |
| **2. Drive transport** (`agentTransport.ts`) | claude-channel | mcp-hooks | acp | fallback→ch | fallback→ch | fallback→ch | N/A | N/A | N/A |
| **3. Play button** (real drive, `triggerChannel`) | ✅ | ✅ | ◐ (needs `opencode auth`) | ⏳ MCP+hooks⁵ | ⏳ ACP | —⁶ | N/A⁷ | N/A⁷ | N/A⁷ |
| **4. Permission overlay** (§47) | ✅ | ◐ opt-in¹ | ✅ | ⏳ | ⏳ | — | N/A | N/A | N/A |
| **5. Busy indicator** ("X working") | ✅ | ✅ | ✅ | ⏳ (label ready²) | ⏳ (label ready²) | — | N/A | N/A | N/A |
| **6. Done signaling** ("X finished") | ✅ | ✅ | ✅ | ⏳ | ⏳ | — | N/A | N/A | N/A |
| **7. MCP tools** (`hotsheet_*`) + registration | ✅ `.mcp.json` | ✅ global `mcp_config.json` | ✅ ACP session | ⏳ | ⏳ | — | N/A | N/A | N/A |
| **8. Instruction file** (`aiInstructionsTools.ts`) | ✅ `CLAUDE.md` | ✅ `AGENTS.md` | ✅ `AGENTS.md` | ◐ no own entry³ | — | — | ✅ `.cursor/rules` | ✅ `.github/copilot-instructions.md` | ✅ `.windsurf/rules` |
| **9. Skills generation** (`skills.ts`) | ✅ `.claude/skills` | ✅ `.agents/skills` | — | — | — | — | ✅ `.cursor/rules` | ✅ `.github/prompts` | ✅ `.windsurf/rules` |
| **10. Auto-allow / perms config** | ✅ | ✅ (inverse⁴) | ✅ (`permission:ask`) | — | — | — | N/A | N/A | N/A |
| **11. Worker pool / distributed** (`hotsheet-worker`) | ✅ | ✅ | — | — | — | — | — | — | — |
| **12. Telemetry + usage UIs + mid-task narration** (docs/67, docs/82) | ✅ | — | — | — | — | — | — | — | — |
| **13. Persistent (`-i`) drive** | ✅ | ◐ planned | ✅ (ACP session) | N/A | N/A | N/A | N/A | N/A | N/A |

**Footnotes:** ¹ `agy` defaults to auto-approve (`--dangerously-skip-permissions`); the §47 prompt is an opt-in PreToolUse hook (`antigravity_interactive_permissions`). ² display name exists (`agentDisplayName.ts`); it emits busy once a drive transport is wired. ³ ~~codex isn't in the `TOOLS` table~~ **closed (HS-9366, [118-adapter-mode-tool-config.md](118-adapter-mode-tool-config.md)):** codex is now in the `TOOLS` table (→ `AGENTS.md`) and seeds `.agents/skills` — as thin adapters referencing the canonical `.claude` files when the project has them. ⁴ `agy` is auto-approve by default; the opt-in hook flips it to prompt. ⁵ **Codex drive SHIPPED (HS-9369, [115-mcp-hooks-agent-channel.md](115-mcp-hooks-agent-channel.md) §115.6a)** — `codex exec --json` one-shot via the A1 MCP+hooks registry (`codexDrive.ts` + `codex.ts` config write via `codex mcp add`), live-validated end-to-end. **Permission overlay also SHIPPED (HS-9359):** the opt-in `codex_interactive_permissions` setting installs `.codex/hooks.json` PreToolUse + PermissionRequest hooks routing tool calls/approvals through the §47 overlay (hotsheet's own MCP calls auto-allowed); default stays auto-approve like agy. ⁶ gemini's DRIVE remains unwired (the earlier "decommissioned" claim applied to its ACP story; HS-9374 verified the CLI itself is alive — 0.49.0 installed, with agent skills), and Tier-B context config now IS generated: `GEMINI.md` managed sections/adapter + `.gemini/skills` seeding ([118-adapter-mode-tool-config.md](118-adapter-mode-tool-config.md) §118.4a). A future drive would need its transport surface investigated (no ACP; MCP-hooks path unexplored). ⁷ editor tools are the ONLY genuine "can't play-drive" case — Hot Sheet never launches them (they run inside the IDE), so there's no process to prompt; they can still consume `hotsheet_*` MCP tools *user-initiated* from the IDE.

**Reading it:** **Claude, Antigravity, OpenCode, and Codex (HS-9369)** are DRIVEN today. The play button is **buildable for every remaining CLI agent** via one of the two transports — **goose → A2 ACP** (native). The only rows that are genuinely un-drivable are **gemini** (decommissioned) and the **editor tools** (no process to launch — Tier B, context-only by design). So a "⏳" in a drive row means "a clear path exists, not yet wired," not "impossible." **Telemetry / usage-cost UIs / mid-task narration are Claude-only** (they ride the Claude-Code OTLP stream — docs/67 §67.1). **Worker pool = Claude + Antigravity only** (needs the MCP claim/lease tools). The `agent_backend` override (Local setting) can force a transport per project but no-ops on an unregistered tool.

## 113.7 Superseded / subsumed tickets

This epic subsumes the earlier exploratory tickets: **HS-8006** ("per project select preferred ai tool?") = the §113.3 `ai_tool` setting (HS-8009); **HS-8003** ("Support OpenCode") + **HS-8943** ("Support codex") = per-tool enablement (§113.4); **HS-8007** ("acp support?") = investigated + closed, its recommendation is §113.3's ACP client. **HS-8916** (instructions) is the shipped Tier-B half.
