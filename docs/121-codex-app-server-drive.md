# 121 — Codex App-Server Persistent Drive

> **Status: Design only (HS-9381).** Follow-up to HS-9380 — the user-visible half of "clicking play with codex does the work invisibly in a background one-shot." **Maintainer decisions (2026-07-23):** (1) drive codex through its **`app-server` protocol** (a persistent, programmatic session that play/custom commands send user turns into) rather than terminal-PTY models; (2) treat it like the Claude Channel — an **Experimental-tab toggle, enabled by default**; (3) when disabled, **hide the play button and custom codex prompt-command buttons** (no silent fallback to the one-shot drive).
>
> Cross-refs: [115-mcp-hooks-agent-channel.md](115-mcp-hooks-agent-channel.md) (the shipped one-shot `codex exec` drive this supersedes for codex, §115.6a/§115.7), [12-claude-channel.md](12-claude-channel.md) (the Claude analog whose UX this matches), [47-richer-permission-overlay.md](47-richer-permission-overlay.md) (the overlay the approval requests feed), [114-acp-channel.md](114-acp-channel.md) (the sibling persistent-session transport whose permission-bridge pattern this reuses), [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md) (the epic), [14-commands-log.md](14-commands-log.md) (phase-1 transcript surface).

## 121.1 Problem

The shipped codex drive (docs/115 §115.6a) is one-shot: each play spawns a fresh
`codex exec --json` in the background. It works — but the user watching an
interactive codex terminal sees *nothing happening* while work runs invisibly,
and each play starts a fresh conversation with no memory of the last run.
HS-9380 fixed the misleading multi-connection warning this caused; this doc
fixes the model itself.

## 121.2 Why not "just send it a signal over MCP" (the Claude model)

MCP has no server→client "run this prompt" direction — agents call tool
servers, never the reverse. Claude's play button works because Claude Code
implements a **proprietary extension**: our channel server emits a custom
`notifications/claude/channel` notification and Claude Code itself injects it
as a user prompt into the running session (docs/113 §113.1). The driven session
and the watched session are the same *because the agent cooperates*.

Codex has no such listener — an MCP server registered with codex cannot push a
turn into a running codex TUI. What codex has instead (captured from codex-cli
0.145.0):

| Surface | What it gives | Verdict |
|---|---|---|
| **`codex app-server`** | JSON-RPC protocol for building UIs on codex (their Desktop app runs on it): `thread/start`/`thread/resume`, `turn/start`, streaming events, approval requests | **Chosen** — the real "send it a prompt" surface |
| `codex mcp-server` | codex exposed *as* an MCP tool server | Persistent + programmatic, but a coarser tool-call surface; no streaming/approval richness |
| `codex exec resume <id> "<prompt>"` | chained one-shots sharing one conversation | Stable fallback; still background processes |
| Injecting into a user-launched TUI | — | Not possible (no IPC into a foreign TTY) |

The one caveat of every programmatic surface: the session it drives is one
**Hot Sheet owns**, not a TUI the user launched themselves. Visibility is
therefore a design axis of its own (§121.6).

## 121.3 The app-server protocol (captured, codex-cli 0.145.0)

`codex app-server generate-json-schema --out <dir>` emits the full JSON Schema
contract — the spike (§121.9) commits a captured copy as the version-pinned
reference, the same pattern as the §115.6a captured JSONL event contract. The
relevant surface:

- **Client → server requests:** `initialize`, `thread/start`, `thread/resume`,
  `thread/list`, `thread/read`, `turn/start`, `turn/steer`, `turn/interrupt`.
- **Server → client notifications:** `thread/started`, `turn/started`,
  `item/started`, `item/agentMessage/delta`, `item/completed`,
  `turn/completed`, `thread/status/changed`, `error`.
- **Server → client requests (approvals):**
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `item/tool/requestUserInput`.
- **Daemon variants:** `codex app-server daemon start/stop`, `codex
  remote-control` (pairing), `app-server proxy` (stdio ↔ control socket) —
  the §121.6 attach investigation's territory.

The protocol is marked **experimental** by codex — mitigation: pin the captured
schema, version-detect at spawn (`initialize` response), and degrade to hiding
the play surface with a Commands Log warning if the handshake fails (§121.7).

## 121.4 Architecture

New module `src/codexAppServer.ts` (+ pure protocol core, mirroring the
`acpClient.ts`/`acpMapping.ts` split):

- **Spawn:** one `codex app-server` child per project, stdio JSON-RPC framing,
  cwd = project root (its MCP config still resolves the `hotsheet-channel`
  server per §115.6a — the `hotsheet_*` tools and `HOTSHEET_DRIVE_SPAWNED=1`
  (HS-9380) carry over unchanged).
- **Session:** `initialize` → `thread/resume` (persisted thread id) or
  `thread/start`; the thread id is stored **per-machine** (thread history lives
  in this machine's `~/.codex`) in `.hotsheet/` local state, NOT shared
  settings.
- **Play / custom command:** `turn/start` with the worklist trigger or the
  command's prompt — the direct analog of the Claude channel notification. A
  play while a turn is active queues or steers (`turn/steer`) — open decision
  O3.
- **Busy/done:** `turn/started` → busy; `item/*` notifications → heartbeats
  (event-driven, same shape as the §115.6a JSONL mapping); `turn/completed` →
  idle + fallback `/channel/done`. The agent still calls
  `hotsheet_signal_done` from the prompt — done clears through the same path
  as every other drive.
- **Permissions:** the approval **requests** map onto the §47 overlay the way
  ACP's `session/request_permission` does (docs/114 §114.5.1) — reuse the
  `acpPermissionBridge.ts` request-id bridge pattern; the overlay's response
  answers the JSON-RPC request directly. No hooks, no bypass flags: this mode
  replaces both the `--dangerously-bypass-approvals-and-sandbox` default AND
  the HS-9359 `.codex/hooks.json` machinery for the driven session. The
  existing `codex_interactive_permissions` setting maps to: on = surface
  approvals to the overlay; off = auto-approve them in the bridge.
- **Crash/restart:** child exit while enabled → clear busy, log to Commands
  Log, respawn lazily on next play (not eagerly — no respawn loops).

## 121.5 Session lifecycle

- **Lazy start:** the app-server child spawns on the first play/custom command,
  not at server boot.
- **Keep-alive:** stays up between plays (that's the point — turn N+1 shares
  the thread's context). Killed on Hot Sheet shutdown and on toggle-off.
- **Thread continuity:** thread id persisted per (project, machine); a missing/
  invalid thread on `thread/resume` falls back to `thread/start` and
  re-persists. A "New session" affordance (context menu on the play button or
  the §121.6 transcript surface) archives the thread pointer and starts fresh.
- **Interrupt:** the existing stop affordance (§57 spinner/stop pattern) maps
  to `turn/interrupt`.

## 121.6 Visibility

- **Phase 1 — Commands Log transcript:** stream `item/agentMessage/delta` /
  `item/completed` summaries into the Commands Log (§14) as the turn runs —
  the user finally *sees* the work as it happens. Cheap, no new UI surface.
- **Phase 2 — dedicated transcript pane (open decision O2):** a per-project
  session view (drawer tile or panel) rendering the live turn stream with
  markdown.
- **Investigation — daemon attach (Claude-parity):** `codex app-server daemon`
  + `remote-control` suggest codex UIs can attach to a shared daemon. If a
  user-launched codex TUI (or the Codex desktop app) can attach to the SAME
  daemon/thread Hot Sheet drives, the user watches the driven session in
  codex's own UI — the genuine Claude-channel-parity outcome. Separate spike
  ticket; the stdio-child model above works regardless and can switch to the
  daemon transport later (`app-server proxy` suggests the protocol is
  transport-agnostic).

## 121.7 Settings + UI gating (maintainer-decided)

Treated like the Claude Channel (§12):

- **Experimental tab toggle** — "Codex app-server drive", stored machine-global
  in `~/.hotsheet/config.json` (like `channelEnabled`), **default ON**.
- **Disabled ⇒ hide the drive surface** for codex-driven projects: the play
  button and custom **prompt** command buttons are hidden (shell-command
  buttons are unaffected). No silent fallback to the one-shot exec drive —
  mirrors how a disabled Claude Channel hides the play section.
- **Supersession:** when this ships, the app-server drive REPLACES the §115.6a
  one-shot `codex exec` drive as codex's play path (`mcpHooksAgents.ts`
  descriptor swaps `spawnRun`; the exec drive code is retired). A failed
  handshake (version drift, protocol change) hides the surface with a Commands
  Log warning rather than reviving the one-shot path.

## 121.8 Out of scope

- **Antigravity (`agy`)** — no app-server analog; stays on the §115.3 one-shot
  drive. A future persistent path for agy would be its `-i` + Stop-hooks model
  (§115.7) — different design, not this doc.
- **ACP agents (OpenCode)** — already persistent per play (docs/114); making
  their output stream visible is a sibling concern for a follow-up on docs/114.
- **The §115.7 / docs/117 transport picker** — unchanged; `ai_tool = codex`
  simply resolves to this drive when the toggle is on.

## 121.9 Phasing

1. **Spike (investigation):** live-probe the protocol — spawn, `initialize`,
   `thread/start`, `turn/start`, stream events, trigger an approval request;
   commit the captured schema + golden transcripts (the HS-8008 pattern).
2. **Core drive:** `codexAppServer.ts` client + session lifecycle + play/custom
   command routing + busy/done + permission bridge; descriptor swap.
3. **Settings + gating:** the Experimental toggle, button hiding, handshake-
   failure degradation.
4. **Transcript phase 1:** Commands Log streaming.
5. **Investigations:** daemon/TUI attach (Claude-parity visibility); transcript
   pane (phase 2) design.

## 121.10 Open decisions

- **O1 — queue vs steer:** a play while a turn is running — queue the trigger
  for turn-end, `turn/steer` it into the active turn, or ignore with a toast?
  (Claude channel effectively queues via re-trigger on done.)
- **O2 — transcript surface:** where phase-2 rich output lives (drawer tile vs
  panel vs reader-mode overlay).
- **O3 — thread reset cadence:** keep one thread forever (context bloat) vs
  auto-fresh per day/N turns vs manual-only "New session".
- **O4 — `codex_interactive_permissions` default in this mode:** overlay
  approvals become cheap (no hooks); consider defaulting ON for the driven
  session where the one-shot drive defaulted to bypass.

## 121.11 Testing

- **Unit:** pure protocol core (framing, request/response correlation, event →
  busy/done mapping, approval bridge) against the captured schema + golden
  transcripts — the `acpMapping.ts` test pattern. Lifecycle tests with an
  injectable spawn (the `codexDrive.test.ts` pattern): lazy start, resume
  fallback, crash → busy cleared, toggle-off → child killed.
- **Manual (`docs/manual-test-plan.md`):** real end-to-end — play → visible
  turn in the Commands Log → `hotsheet_*` calls → done; approval round-trip
  through the §47 overlay; disabled toggle hides play + prompt buttons.
