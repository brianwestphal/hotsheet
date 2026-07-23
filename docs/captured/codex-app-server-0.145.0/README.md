# Captured codex app-server contract — codex-cli 0.145.0 (HS-9382, 2026-07-23)

Version-pinned reference for the docs/121 drive. Regenerate the schema with
`codex app-server generate-json-schema --out <dir>` (this dir keeps only the
combined `codex_app_server_protocol.schemas.json`; the generator also emits
~38 per-type files and a v2 variant). Transcripts are from live probes
(`$HOME` sanitized to `~`); each line is `{dir: send|recv, t, msg}`.

## Files

- `codex_app_server_protocol.schemas.json` — the full protocol JSON Schema.
- `initialize-response.json` — handshake response (`userAgent`, `codexHome`, platform).
- `thread-start-response.json` — `thread/start` response (thread object incl. `id`).
- `transcript-phase-a.jsonl` — initialize → `thread/start` → trivial `turn/start` → streamed items → `turn/completed`.
- `transcript-phase-c.jsonl` — process kill → respawn → `thread/resume` → memory-probe turn (context retained).
- `transcript-approval.jsonl` — sandbox-escaping command turn with the approval round-trip.
- `server-request-item_commandExecution_requestApproval-1.json` — the captured approval request shape.
- `transcript-interrupt2.jsonl` — `turn/interrupt` probe (turn ends `status: "interrupted"`).
- `mcp-server-status-summary.json` — `mcpServerStatus/list` summary: `hotsheet-channel` visible with 24 tools.
- `transcript-daemon-watcher-B.jsonl` / `daemon-dual-client-results.json` — HS-9386 dual-client daemon probe: the WATCHER connection's transcript over the daemon's UDS WebSocket (client A drove the turn; B, subscribed via `thread/resume`, received `turn/started` / `item/agentMessage/delta` / `item/completed` / `turn/completed` live).

## Verified findings (all live, 2026-07-23)

1. **Framing:** newline-delimited JSON-RPC 2.0 over stdio. Client sends
   `initialize` (requires `clientInfo {name, version}`) then the `initialized`
   notification.
2. **Session:** `thread/start {cwd, sandbox, approvalPolicy, …}` → thread `id`;
   `turn/start {threadId, input: [{type: 'text', text}]}`. The `turn/start`
   RESPONSE returns immediately with the turn object (`status: "inProgress"`) —
   completion arrives only via notifications.
3. **Streaming:** `turn/started` → `item/completed` per item (`userMessage`,
   `agentMessage` with `phase: commentary|final_answer`, `commandExecution`,
   `reasoning`) + `item/agentMessage/delta` for token streaming →
   `turn/completed {turn.status}`. `thread/status/changed
   {status: {type: 'active'|'idle'}}` is a clean busy/idle signal.
4. **Approvals:** with `approvalPolicy: 'untrusted'` + `sandbox:
   'workspace-write'`, a safe command (`echo`) runs WITHOUT an approval; a
   sandbox-escaping command (write outside the workspace) fires the
   server→client request `item/commandExecution/requestApproval` (params carry
   the exact command, cwd, reason) — respond `{decision: 'accept'}`
   (`acceptForSession` / rejection variants per the schema) and the turn
   proceeds. Maps directly onto the §47 overlay.
5. **Continuity:** after killing and respawning the app-server process,
   `thread/resume {threadId}` restores the conversation — a turn asking "which
   word did I ask for earlier" answered correctly.
6. **Interrupt:** `turn/interrupt {threadId, turnId}` (turnId REQUIRED —
   capture it from `turn/started`) → `{}` response, then `turn/completed` with
   `turn.status: "interrupted"` (~6 s including the in-flight command teardown).
7. **MCP pickup:** the driven session sees the §115.5/§115.6a global
   cwd-resolving `hotsheet-channel` MCP entry — `mcpServerStatus/list` reports
   it with all 24 `hotsheet_*` tools. No extra config needed for the drive.
8. **Daemon multi-client watch (HS-9386):** the daemon's UDS
   (`~/.codex/app-server-control/app-server-control.sock`) speaks the SAME
   protocol over **WebSocket** (HTTP Upgrade + frames; `app-server proxy` only
   bridges bytes — a raw-JSONL client gets no reply). Node `ws` connects via
   `ws+unix://<sock>:/` with `perMessageDeflate: false` + a plain `host`
   header (deflate negotiation → the daemon hangs up). `thread/started`
   broadcasts to all connections; turn/item events are per-connection
   subscriptions created by `thread/start`/`thread/resume`. `thread/resume`
   requires the persisted rollout (fails "no rollout found" before the first
   turn). A watcher client subscribed this way receives another client's
   turns LIVE — delta streaming included.
