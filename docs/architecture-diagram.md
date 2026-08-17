# Hot Sheet — Architecture Diagram

A visual, end-to-end map of how Hot Sheet is put together, covering both the **app side** (the Tauri desktop shell + the browser/WebView client) and the **server side** (the Node/Hono server, PGLite, and every subsystem it hosts), plus the pieces that straddle the two — the Claude Channel MCP bridge, the detached terminal broker, the distributed worker pool, and the AI drive transports.

Everything runs **locally**. The only outbound network is update checks (npm / GitHub) and, when the relevant features are on, AI-provider calls (Anthropic API, Google TTS). Grounded in the code as of 2026-08-17; anchor files are cited per section. For behavior detail see the numbered `docs/*` requirements docs and `docs/ai/code-summary.md`.

> Diagrams are Mermaid — they render on GitHub and in the Hot Sheet reader. **SHIPPED** vs **design/partial** status is called out where it matters (see the status table at the end).

---

## A. System overview

The whole picture: five process groups (desktop shell, client, Node server, terminal broker, and the external AI tools), the data on disk, and the transports between them.

```mermaid
flowchart TB
  subgraph desktop["🖥️ Desktop App — Tauri v2 shell (Rust · src-tauri/src/lib.rs)"]
    direction TB
    shell["Rust shell<br/>window · menus · updater · TTS · quit-confirm"]
    supervisor["Sidecar supervisor<br/>spawn · restart budget · navigate<br/>(HS-9656 / docs/134)"]
    webview["WKWebView<br/>(hosts the client)"]
    shell --> supervisor
    shell --> webview
  end

  subgraph client["🌐 Client — IIFE bundle in the WebView/browser (src/client)"]
    direction TB
    appboot["app.tsx — boot · state · handlers"]
    ui["ticketList · detail · dropdown · sidebar · settings"]
    xterm["xterm terminals + dashboard"]
    channelui["channel UI · permission overlay (§47)"]
    ctransport["api.tsx (REST) · wsSync.ts (WS) · poll.js (long-poll)"]
    appboot --> ui
    appboot --> xterm
    appboot --> channelui
    ui --> ctransport
    channelui --> ctransport
  end

  subgraph server["⚙️ Node Server — Hono @ :4174 (src/cli.ts → src/server.ts)"]
    direction TB
    hono["HTTP edge<br/>requestGuards · rate-limit · auth · static assets · (m)TLS"]
    subgraph routes["Routes (src/routes)"]
      direction TB
      api["/api/* — tickets · settings · shell · attachments · commandLog · git · workers · remotes · announcer · keys"]
      wssync["/ws/sync — live event push"]
      pollr["/api/poll — long-poll fallback"]
      termws["/api/terminal/ws — PTY stream"]
      otlp["/v1/metrics · /logs · /traces — OTLP ingest"]
      chan["/api/channel/* — notify · trigger · permission"]
    end
    subgraph core["Core services"]
      direction TB
      db["DB layer (src/db)<br/>PGLite clusters · queries · claim/lease · LRU eviction"]
      syncsvc["markdown sync · event bus (src/sync)"]
      housekeep["backup · cleanup · gitignore · skills-gen"]
      pool["worker pool (src/workers)<br/>reconciler · launcher · integrate"]
      telw["telemetry writers + retention (src/db/otelWriters)"]
      drivesvc["AI drive (src/agentTransport)<br/>codex app-server · ACP · MCP+hooks"]
    end
    hono --> routes
    api --> db
    api --> syncsvc
    api --> housekeep
    api --> pool
    otlp --> telw
    telw --> db
    chan --> drivesvc
    pool --> drivesvc
  end

  subgraph broker["🧩 PTY Broker — detached process, own process group (src/terminals/broker)"]
    ptys["node-pty children<br/>scrollback · dynamic identity"]
  end

  subgraph data["💾 Data on disk"]
    direction TB
    proj[".hotsheet/ — per project<br/>db/ · attachments/ · backups/ · settings*.json · secret.json<br/>worklist.md · telemetry/ · channel-port(s) · locks · logs"]
    glob["~/.hotsheet/ — global<br/>config.json · projects.json · instance.json<br/>pty-broker.sock · startup/shutdown/stderr logs · diagnostics/"]
  end

  subgraph ext["🔌 External AI tools & services"]
    direction TB
    claude["Claude Code CLI"]
    channelproc["Claude Channel MCP server<br/>SEPARATE process (src/channel.ts)"]
    codex["Codex app-server daemon<br/>(~/.codex control UDS)"]
    otheragents["OpenCode (ACP) · Antigravity (agy)"]
    git["Git worktrees<br/>(hotsheet/worker-N)"]
    cloud["Anthropic API · Google TTS<br/>npm registry · GitHub releases"]
  end

  %% ---- cross-process transports ----
  supervisor -->|"spawn sidecar (stdout handshake)"| hono
  webview -.->|"renders"| appboot
  webview -->|"loads /static, navigates"| hono
  ctransport <-->|"HTTP / WS (localhost)"| hono

  db <-->|"read / write"| proj
  housekeep <-->|"read / write"| proj
  glob <--> hono

  xterm <-->|"/api/terminal/ws"| termws
  termws <-->|"UDS · JSON frames"| ptys
  pool -->|"spawn worker PTY (claude /hotsheet-worker)"| ptys
  pool -->|"worktree create / rebase"| git

  claude <-->|"MCP over stdio"| channelproc
  channelproc -->|"HTTP /api/channel/notify"| chan
  chan -->|"HTTP /trigger (play)"| channelproc
  channelproc -->|"hotsheet_* tools → /api"| api

  drivesvc <-->|"UDS-WS · JSON-RPC"| codex
  drivesvc <-->|"stdio · JSON-RPC (ACP / spawn)"| otheragents
  claude -->|"OTLP (protobuf)"| otlp

  drivesvc -->|"summaries · TTS"| cloud
  shell -->|"update check"| cloud
```

**Reading it:** the desktop shell is only a launcher + host — it spawns the Node server as a sidecar and points the WebView at it. The client is a normal web app talking to `localhost:4174`. Everything with real logic lives in the Node server. The Claude Channel, terminal broker, codex daemon, and worker agents are *separate processes* the server coordinates with over stdio / HTTP / UDS.

---

## B. Processes & IPC

Who spawns whom, and over what transport. This is the "server and app sides" split made concrete.

```mermaid
flowchart LR
  cc["Claude Code CLI<br/>(user's terminal or a worker PTY)"]
  tauri["Tauri shell (Rust)"]
  node["Node server (cli.js @ :4174)"]
  chp["Channel MCP server<br/>(channel.js — 1 per Claude Code)"]
  brk["PTY broker (detached)"]
  cdx["codex app-server daemon"]

  tauri -->|"① sidecar spawn · stdout 'running at'"| node
  cc -->|"② MCP stdio subprocess (.mcp.json)"| chp
  chp -->|"③ HTTP /api/channel/notify (secret-auth)"| node
  node -->|"④ HTTP /trigger, /health, /permission"| chp
  chp -->|"⑤ hotsheet_* tool calls → /api"| node
  node -->|"⑥ UDS (JSON frames) · spawn-if-absent"| brk
  node -->|"⑦ UDS-WS JSON-RPC · start-if-absent"| cdx
```

| # | Edge | Transport | Anchor |
|---|------|-----------|--------|
| ① | Tauri → Node | Tauri shell-plugin **sidecar** spawns `hotsheet-node` running bundled `server/cli.js`; handshake on the stdout "running at" line; bounded auto-restart supervisor | `src-tauri/src/lib.rs` (`build_and_spawn_sidecar`, `spawn_sidecar_and_navigate`), `tauri.conf.json` (`externalBin`) |
| ② | Claude Code → Channel | **MCP over stdio**; Claude Code launches the channel as an MCP subprocess declared in `.mcp.json` (`hotsheet-channel-<slug>`). One channel process per Claude Code instance | `src/channel.ts`, `src/channel-config.ts` |
| ③ | Channel → Node | **HTTP** POST to `/api/channel/notify`, authenticated with the project's `secret.json` sidecar secret | `src/channel.ts` (`notifyMainServer`), `src/routes/channel.ts` |
| ④ | Node → Channel | **HTTP** to the channel's ephemeral port (discovered via `.hotsheet/channel-port` + per-PID registry); play button ⇒ `/trigger` | `src/channel-config.ts`, `src/channelRegistry.ts`, `src/routes/channel.ts` |
| ⑤ | Channel → Node | The `hotsheet_*` **MCP tools** (ticket CRUD, batch, notes, claim/lease, worker pool, announce, signal-done) are HTTP calls back into `/api/*` | `src/channel.tools.ts` |
| ⑥ | Node → Broker | **Unix-domain socket**, newline-delimited JSON (base64 for PTY bytes); broker is a **detached** process (own process group) so it survives an accidental server death and re-adopts sessions on reconnect | `src/terminals/broker/*`, `src/terminals/registry/brokerMode.ts` |
| ⑦ | Node → codex | **WebSocket over UDS** (`ws+unix://`), one JSON-RPC message per frame, to the shared codex `app-server` daemon (started if absent); stdio-child fallback | `src/codexAppServer.ts`, `src/codexDaemonTransport.ts` |

**Dev vs packaged.** In dev the server is `node --import tsx src/cli.ts` (single process, so its PID is the killable server) and the broker/channel run via `tsx` too; the packaged app runs the tsup-built `cli.js` / `channel.js` / `ptyBrokerEntry.js` (`src-tauri/src/lib.rs::build_dev_server_args`).

---

## C. Client ↔ server transport

Three cooperating channels on the one Hono port, plus a separate PTY stream.

```mermaid
flowchart TB
  subgraph cl["Client (src/client)"]
    apic["api.tsx — typed REST callers (src/api/*)"]
    wsc["wsSync.ts — WS client + backoff reconnect"]
    pollc["poll.js — long-poll fallback"]
    xt["xterm terminals"]
  end
  subgraph sv["Server (:4174)"]
    rest["/api/* handlers → src/db"]
    bus["event bus (src/sync/eventBus)"]
    wsr["/ws/sync (src/routes/wsSync)"]
    plr["/api/poll (src/routes/dashboard)"]
    twr["/api/terminal/ws (src/terminals/websocket)"]
  end

  apic -->|"mutations / reads (HTTP)"| rest
  rest -->|"change-version bump"| bus
  bus --> wsr
  bus --> plr
  wsr -->|"push events"| wsc
  plr -->|"catch-up on WS loss"| pollc
  wsc -. "auto-fallback if WS drops" .-> pollc
  xt <-->|"PTY bytes (WS)"| twr
```

- **REST** — every client call goes through a typed caller in `src/api/*` (single source of truth for wire shapes; docs/9). Mutations bump a change-version.
- **WebSocket `/ws/sync`** — the live path (docs/93): the server's event bus pushes changes to all tabs; the client reducer applies them, with `?since` catch-up + exponential-backoff reconnect.
- **Long-poll `/api/poll`** — additive fallback that stays working if the WS drops.
- **Terminal `/api/terminal/ws`** — a *separate* WS carrying raw PTY bytes; on the server side it relays to the broker over the UDS (§B ⑥). On checkout/reconnect it replays scrollback history (docs/54).

---

## D. Claude Channel & AI drive

How Hot Sheet drives an AI agent. The default is the **Claude Channel** (a persistent MCP process); other tools use their own drive transport, selected per tool by `src/agentTransport.ts` / `src/aiTools/registry.ts` (docs/117).

```mermaid
flowchart TB
  user["User clicks ▶ Play / auto-mode fires"]
  trig["POST /api/channel/trigger (src/routes/channel)"]
  user --> trig

  subgraph claudepath["Default — Claude Channel (docs/12)"]
    direction TB
    chp["Channel MCP process (src/channel.ts)"]
    ccli["Claude Code CLI"]
    trig -->|"HTTP /trigger"| chp
    chp -->|"emits channel event (MCP)"| ccli
    ccli -->|"runs /hotsheet · hotsheet_* tools → /api"| back["Main server /api"]
    ccli -->|"session/tool → permission"| overlay["§47 permission overlay"]
    ccli -->|"hotsheet_signal_done"| back
  end

  subgraph others["Other tools — drive selected by src/agentTransport"]
    direction TB
    codex["codex app-server (UDS-WS JSON-RPC)<br/>docs/121 — SHIPPED"]
    acp["OpenCode via ACP (stdio JSON-RPC)<br/>docs/114 — driver present"]
    mh["Antigravity 'agy' via MCP+hooks<br/>docs/115 — SHIPPED"]
    trig -.-> codex
    trig -.-> acp
    trig -.-> mh
    codex --> overlay
    mh --> overlay
    acp --> overlay
  end

  overlay -->|"allow / deny"| back
```

- **`claude-channel`** (default): persistent MCP process; `session/request_permission`-style prompts surface in the in-app §47 overlay; MCP tool calls route back into `/api`.
- **`codex` app-server** (docs/121, SHIPPED): drive over the codex daemon's control UDS so external codex UIs can watch the same driven thread (model-B, docs/129); approvals + MCP elicitations bridge to the §47 overlay.
- **`acp`** (docs/114): OpenCode et al. over the Agent Client Protocol (stdio JSON-RPC); pure mapping core shipped, driver present.
- **`mcp-hooks`** (docs/115, SHIPPED for Antigravity): MCP-native agents on Claude's rails; a PreToolUse hook polls the channel's `/permission/decision`.

---

## E. Distributed worker pool

Parallel AI agents, each in its own git worktree, all feeding one Hot Sheet (docs/89–92, 100). The owner (running on `main`) is the single integrator.

```mermaid
flowchart TB
  owner["Owner agent on main<br/>(single integrator)"]
  settarget["hotsheet_set_worker_target / dispatch (MCP)"]
  recon["reconcilePool (src/workers/reconcilePool)<br/>headless: drives live count → target N"]
  owner --> settarget --> recon

  subgraph slot["Per worker slot — worker-N"]
    direction TB
    prep["prepareWorker (launchWorker.ts)<br/>create/reuse worktree · inject HOTSHEET_WORKER_ID (HS-9676)"]
    wt["git worktree<br/>branch hotsheet/worker-N + follower .hotsheet pointer"]
    pty["worker PTY: claude /hotsheet-worker<br/>(spawned in the broker)"]
    wchan["worker's own Channel MCP server"]
    prep --> wt --> pty --> wchan
  end
  recon -->|"scale up"| prep
  recon -->|"graceful drain (never kill mid-ticket)"| pty

  wchan -->|"claim_next / renew / update / release (MCP → /api)"| srv["Main server /api + DB"]
  pty -->|"commit on hotsheet/worker-N, rebase onto target"| repo["Repo"]
  owner -->|"GET /api/workers/integratable → POST /api/workers/integrate"| repo
```

- Workers **self-claim** tickets via the claim/lease primitive (atomic `claim-next` with `SKIP LOCKED`) or are **dispatched** to by the owner; the lease id (`worker-1`) is injected as `HOTSHEET_WORKER_ID` so a reused worktree (`hotsheet-worker-1-12`) still claims under the right identity (HS-9676, `src/workerIdentity.ts`).
- Each worker runs its **own channel MCP server** against the owner data dir, so its permission prompts + tool calls surface in the owner's UI.
- Workers **never write the target branch** — they commit on `hotsheet/worker-N` and rebase to stay current; the owner integrates ready branches with the guarded `integrate` helper (optional in-merge gate).

---

## F. Data on disk

Nothing leaves the machine. Per-project state lives in `.hotsheet/`; cross-project + machine state in `~/.hotsheet/`.

```mermaid
flowchart LR
  subgraph p[".hotsheet/ — per project"]
    direction TB
    pdb["db/ — PGLite ticket cluster<br/>(+ db-corrupt-* / recovery variants)"]
    patt["attachments/ — file blobs"]
    pbk["backups/ · snapshot.tar.gz — 3-tier backups"]
    pset["settings.json · settings.local.json · secret.json"]
    pmd["worklist.md · open-tickets.md · ticket-drafts/"]
    ptel["telemetry/ — per-project OTLP PGLite cluster + jsonl"]
    pchan["channel-port · channel-ports.d/ · codex-app-server.json"]
    plock["hotsheet.lock · auth-devices.json · mcp.log · freeze.log"]
  end
  subgraph g["~/.hotsheet/ — global / machine"]
    direction TB
    gcfg["config.json · projects.json · instance.json"]
    gsock["pty-broker.sock (UDS) · pty-broker.log"]
    glog["startup.log · shutdown.log · server-stderr.log · watchdog-stack-*"]
    gdiag["diagnostics/ · plugins/ · plugin-config.json · last-update-check"]
  end
```

The **live DB** is `.hotsheet/db/` and is never on the (user-configurable) backup filesystem. `backupDir` / `dataDir` may point at cloud drives, so all access to them goes through the hardened `src/backupFs.ts` / streaming attachment paths (docs/7, CLAUDE.md). PGLite clusters are memory-bounded by an LRU + idle-close + pressure-aware policy (docs/128, 131).

---

## G. Telemetry ingest

Claude Code emits OpenTelemetry to the same Hono port; it lands in per-project telemetry clusters (docs/67).

```mermaid
flowchart LR
  ccli["Claude Code<br/>(spawned by a Hot Sheet terminal)"]
  env["env: CLAUDE_CODE_ENABLE_TELEMETRY=1<br/>OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:PORT<br/>(src/terminals/registry/otelEnv.ts)"]
  route["/v1/metrics · /logs · /traces<br/>(src/routes/otel.ts — protobuf/JSON)"]
  gate["row cap · unknown-project drop (§67.8)"]
  writers["otelWriters (src/db/otelWriters)"]
  tcl["per-project telemetry PGLite<br/>.hotsheet/telemetry/db"]
  dash["Analytics dashboards<br/>(docs/70, 71)"]

  ccli --> env --> route --> gate --> writers --> tcl --> dash
```

The OTLP `hotsheet_project` resource attribute (= project secret) maps a batch to its project's telemetry cluster; rows for unknown projects are dropped. Retention is a periodic sweep with per-table windows + a span row cap (docs/85). Dashboards read the clusters for cost/usage views.

---

## Shipped vs design status

| Component | Status |
|---|---|
| Tauri sidecar spawn of `cli.js` + supervisor | **SHIPPED** |
| Main server (Hono :4174) + `/ws/sync` + `/api/poll` + `/api/terminal/ws` | **SHIPPED** |
| Claude Channel MCP (stdio + localhost HTTP) | **SHIPPED** |
| PTY broker (detached, UDS) | **SHIPPED** — default ON (macOS/Linux); Windows OFF pending verify; packaged-beta path untested |
| Worker pool (worktree Claude PTYs + headless reconciler) | **SHIPPED**; server-driven launch + prompt/coordinator UX partly design (docs/100–102) |
| Drive: `claude-channel` | **SHIPPED** |
| Drive: `codex` app-server (UDS-WS + stdio fallback) | **SHIPPED** |
| Drive: `mcp-hooks` | **SHIPPED** for Antigravity; generalized selection pending |
| Drive: `acp` (OpenCode) | Design + spike done; driver code present |
| OTLP telemetry ingest → per-project PGLite | **SHIPPED** |
| Remote access over mTLS (client half) | Server SHIPPED; client half design (docs/112) |

---

*Anchor files:* `src-tauri/src/lib.rs`, `tauri.conf.json`, `src/cli.ts`, `src/server.ts`, `src/channel.ts`, `src/channel-config.ts`, `src/routes/{channel,wsSync,dashboard,otel}.ts`, `src/terminals/{websocket.ts,broker/*,registry/brokerMode.ts}`, `src/workers/{launchWorker,reconcilePool}.ts`, `src/workerIdentity.ts`, `src/agentTransport.ts`, `src/aiTools/registry.ts`, `src/codexAppServer.ts`, `src/codexDaemonTransport.ts`, `src/acp/acpDrive.ts`, `src/antigravityDrive.ts`, `src/db/{connection,otelWriters}.ts`.
