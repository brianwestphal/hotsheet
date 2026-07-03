# 113 — Multi-AI-Tool Support (beyond Claude Code)

> **Status:** Design / epic umbrella (HS-8932). Hot Sheet is Claude-Code-specific across its "agent layer" (the play button, permission popup, busy-tracking, channel-done) and its command resolution; only skills/instructions generation is already multi-tool. Some users want to drive **other** AI coding tools — the maintainer's priority order: **Codex, Gemini CLI, OpenCode are critical; Goose next; Cursor / Windsurf / Copilot evaluated for feasibility.** This doc frames the epic, ties together the scattered tickets, and decomposes the work. Cross-refs: [12-claude-channel.md](12-claude-channel.md) (the current Claude channel), [47-richer-permission-overlay.md](47-richer-permission-overlay.md) (permission popup), [86-ai-assistant-setup.md](86-ai-assistant-setup.md) (managed instructions), and the ACP investigation (HS-8007, closed) + the proposed ACP doc `114-acp-channel.md`.

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

- **A. CLI agents Hot Sheet DRIVES (the play/permission/busy loop).** Terminal agents that Hot Sheet launches + prompts + gets permission requests from. **Codex CLI, Gemini CLI, OpenCode, Goose, Copilot CLI.** Per the HS-8007 investigation these speak (or have adapters for) **ACP (Agent Client Protocol)** — the realistic path to replicate the channel's play button + permission popup + busy-tracking without writing N bespoke adapters. Claude Code stays on its current MCP-notification channel (and could later move to the Zed Claude-ACP adapter for unification).
- **B. Editor-integrated tools Hot Sheet only SUPPLIES CONTEXT to.** **Cursor, Windsurf, GitHub Copilot (in-editor).** Hot Sheet doesn't launch/drive them; it writes their rules/instructions files so they follow the ticket-driven conventions. This is **already shipped** — skills (`skills.ts`) + instructions (HS-8916). No agent-drive loop applies.

The per-project **`ai_tool` setting** selects which tool a project uses; the setting then routes: which launch command, which skills to seed, which ACP agent to spawn, and the Commands Log label.

## 113.3 Architecture

1. **Per-project `ai_tool` setting** (HS-8009) — `ai_tool` in `<dataDir>/settings.json`, enum `claude | codex | gemini | opencode | goose | cursor | copilot | windsurf | auto` (default `auto` = today's detect-everything). Surfaced in Settings → General. Drives:
   - **Command resolution** — **SHIPPED (HS-8009):** `resolveCommand.ts` `pickAiCommand` reads `ai_tool`; an explicit CLI agent (`codex`/`gemini`/`opencode`/`goose`) makes `{{aiCommand}}` (+ the back-compat `{{claudeCommand}}`) launch that tool's bare binary (or the shell if absent); `auto`/`claude`/editor-tools keep today's Claude behavior. (The channel/play loop for non-Claude agents is still ACP — until then the terminal just runs the tool's REPL.)
   - **Skills selectivity** — `skills.ts` seeds only the selected tool's dirs when explicit (falls back to detect-all for `auto`). *Follow-up (touches the shipped `ensureSkillsForDir` hot path).*
   - **ACP agent selection** — the ACP client (below) spawns the matching subprocess. *(HS-9310.)*
   - **Commands Log labels** — `→ Codex` / `→ Claude` etc. *Follow-up.*
2. **ACP client for the drive layer** (HS-8008 spike → `docs/114`) — `src/acp/client.ts`: spawn the CLI agent, JSON-RPC/stdio, `initialize` → `session/new` → `session/prompt` (= play button / channel trigger), render `session/update` (= busy), map `session/request_permission` → the §47 permission overlay (its `allow_once`/`allow_always`/`reject_once`/`reject_always` map **1:1** onto `permission_allow_rules`), map `StopReason` → channel-done + busy-clear. Claude stays on the MCP channel; a **Settings → Channel "Agent backend" picker** (`claude-channel-mcp` vs `acp:<command>`) selects the transport.
3. **Skills + instructions** — already multi-tool (`skills.ts`, `aiInstructionsTools.ts` / HS-8916). Extend `skills.ts` detection to the Tier-A CLI agents (Codex/Gemini/OpenCode/Goose) if they warrant their own rule files.

## 113.4 Decomposition (sub-tickets)

Per the maintainer's "make sub-tickets for all the aspects." Grouped:

**Foundations**
- **`ai_tool` setting + command resolution + skills selectivity** (HS-8009, exists as a ticket). The channel-command + skills halves ship independently of ACP.
- **ACP client spike** (HS-8008, exists) — drive Gemini CLI end-to-end (play + permission), validate the design.

**ACP rollout (after the spike, → docs/114)**
- ACP requirements doc (`docs/114-acp-channel.md`).
- Settings → Channel "Agent backend" picker (`claude-channel-mcp` vs `acp:<command>`).
- Per-agent command templates (gemini / codex / opencode / goose / copilot-cli).
- Busy/done via ACP `session/update` + `StopReason` (replaces the Claude-hook heartbeat for non-Claude agents).
- Permission overlay: accept ACP's option set (not just the Claude tool/desc/input shape).

**Per-tool enablement** (one ticket per Tier-A agent, gated on the spike): Codex, Gemini, OpenCode, Goose, Copilot CLI — each = command template + ACP wiring + skills + Commands Log label + smoke test.

**Editor tools (Tier B — largely done)**
- Instructions: Cursor / Windsurf / Copilot — **SHIPPED (HS-8916)**.
- Skills/rules: Cursor / Copilot / Windsurf — already in `skills.ts`.

## 113.5 Open decisions (maintainer)

- **O1 — Tier-A tool priority + which to enable first.** Recommend: **Gemini CLI first** (the ACP reference impl → cleanest spike), then Codex + OpenCode, then Goose; Copilot CLI last (public-preview ACP). Confirm.
- **O2 — Claude on ACP?** Keep Claude on the current MCP-notification channel for now (it works + the hook-based busy is solid), and evaluate the Zed Claude-ACP adapter as a *unification* follow-up (not a rewrite). Confirm.
- **O3 — `ai_tool` default.** `auto` (detect-everything, today's behavior) vs. a first-launch picker. Recommend `auto` default + a Settings dropdown (no onboarding dialog — polish, per HS-8009).
- **O4 — Cursor/Windsurf/Copilot as "drivable"?** They're editor-integrated, not CLI agents — recommend **context-only** (skills+instructions, done), NOT part of the ACP drive loop. Confirm.

## 113.6 Superseded / subsumed tickets

This epic subsumes the earlier exploratory tickets: **HS-8006** ("per project select preferred ai tool?") = the §113.3 `ai_tool` setting (HS-8009); **HS-8003** ("Support OpenCode") + **HS-8943** ("Support codex") = per-tool enablement (§113.4); **HS-8007** ("acp support?") = investigated + closed, its recommendation is §113.3's ACP client. **HS-8916** (instructions) is the shipped Tier-B half.
