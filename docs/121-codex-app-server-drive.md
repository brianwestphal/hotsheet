# 121 — Codex App-Server Persistent Drive

> **Status: CORE DRIVE (HS-9383) + TOGGLE/GATING (HS-9384) SHIPPED, 2026-07-23; Commands Log transcript (HS-9385) + daemon transport (HS-9388) pending.** Follow-up to HS-9380 — the user-visible half of "clicking play with codex does the work invisibly in a background one-shot." **Maintainer decisions (2026-07-23):** (1) drive codex through its **`app-server` protocol** (a persistent, programmatic session that play/custom commands send user turns into) rather than terminal-PTY models; (2) treat it like the Claude Channel — an **Experimental-tab toggle, enabled by default**; (3) when disabled, **hide the play button and custom codex prompt-command buttons** (no silent fallback to the one-shot drive). §121.10 decisions (2026-07-23): **O1 queue+coalesce**, **O3 manual-only thread reset**, **O4 overlay approvals ON by default**.
>
> Shipped shape: `src/codexAppServerMapping.ts` (pure protocol core) + `src/codexAppServer.ts` (per-project session manager — lazy spawn, `thread/resume` from `<dataDir>/codex-app-server.json`, queue+coalesce, busy/done, §47 approval bridge via `acpPermissionBridge`, allow-rules auto-allow, `turn/interrupt`, crash/shutdown teardown); the `mcpHooksAgents.ts` codex descriptor now points at it and the §115.6a one-shot exec drive (`codexDrive.ts`) is retired.
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

## 121.3 The app-server protocol (captured + LIVE-VALIDATED, codex-cli 0.145.0)

**Spike complete (HS-9382, 2026-07-23)** — the full contract is captured under
[`docs/captured/codex-app-server-0.145.0/`](captured/codex-app-server-0.145.0/README.md)
(schema + golden transcripts + the approval-request shape), and every §121.9
step-1 question was live-verified: JSONL JSON-RPC framing; `turn/start`
responds immediately (completion is notification-only);
`thread/status/changed {active|idle}` as a clean busy signal; approvals fire
only for genuinely escalating actions under `approvalPolicy: 'untrusted'`
(safe commands auto-run — good default §47 UX) and answer with
`{decision: 'accept'}`; `thread/resume` retains context across process
restarts; `turn/interrupt` requires `{threadId, turnId}` (capture turnId from
`turn/started`) and ends the turn `status: "interrupted"`; the driven session
sees the global cwd-resolving `hotsheet-channel` MCP entry (24 tools) with no
extra config. The relevant surface:

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
- **Daemon attach — INVESTIGATED, works (HS-9386, 2026-07-23):** the daemon
  (`codex app-server daemon start`) exposes the same protocol over a UDS at
  `~/.codex/app-server-control/app-server-control.sock` as **WebSocket** (HTTP
  Upgrade + frames — NOT raw JSONL; `app-server proxy` just bridges bytes).
  Multiple clients connect concurrently; `thread/started` broadcasts to every
  connection, and `thread/start`/`thread/resume` auto-subscribes a connection
  to that thread's turn/item events. **Live-verified dual-client:** a watcher
  connection that `thread/resume`d the driven thread received the next turn's
  `turn/started` → `item/agentMessage/delta` → `item/completed` →
  `turn/completed` in real time (transcript:
  `docs/captured/codex-app-server-0.145.0/transcript-daemon-watcher-B.jsonl`).
  Caveats: `thread/resume` needs the on-disk rollout, which exists only after
  the first turn persists (resume-before-first-turn → "no rollout found");
  Node `ws` needs `perMessageDeflate: false` (+ a plain `host` header) or the
  daemon hangs up the upgrade. The codex TUI runs its own core (not
  daemon-attached) — live watching is for app-server clients (VS Code
  extension / desktop app / a Hot Sheet transcript pane); `codex resume
  <threadId>` in a terminal opens the shared HISTORY but as its own session.
  Follow-up: offer the daemon UDS transport in the drive so external
  app-server UIs can watch the driven thread.

## 121.7 Settings + UI gating (SHIPPED, HS-9384)

Treated like the Claude Channel (§12):

- **Experimental tab toggle** — "Codex app-server drive"
  (`#settings-codex-app-server-enabled`), stored machine-global as
  `codexAppServerEnabled` in `~/.hotsheet/config.json` (like `channelEnabled`),
  **default ON** (absent ⇒ enabled). Flipping it POSTs
  `/api/channel/codex-app-server {enabled}` — disable kills every live driven
  session (`shutdownCodexAppServers`); enable clears handshake-failure flags so
  the next play retries fresh.
- **Disabled ⇒ hide the drive surface** for codex-driven projects: `initChannel`
  applies the pure `shouldHideCodexDriveSurface(status, ai_tool)`
  (`src/client/codexDriveGate.ts`) and hides the play section, which also hides
  custom **prompt** command buttons via `isCommandVisible` (shell-command
  buttons are unaffected). The drive is gated server-side too
  (`spawnCodexAppServerRun` refuses when disabled). No silent fallback to the
  one-shot exec drive.
- **Handshake-failure degradation:** a failed `initialize`/thread setup marks
  the project (`hasCodexAppServerHandshakeFailed`), `GET /channel/status`
  surfaces `codexAppServerEnabled` + `codexAppServerFailed`, the client hides
  the surface, and the status route writes ONE Commands Log warning (with the
  retry hint: toggle off/on). A healthy boot clears the flag.
- **Supersession:** shipped — the `mcpHooksAgents.ts` descriptor's `spawnRun`
  is `spawnCodexAppServerRun` and the exec drive code is retired (HS-9383).

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
