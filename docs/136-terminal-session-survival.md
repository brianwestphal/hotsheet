# 136 — Terminal session survival across server restarts (PTY broker)

**Status: partial — survival engine SHIPPED behind a gate (HS-9662).** The broker + protocol + node client (phases 1a/1b) are built and unit-tested; wiring into the live registry + shutdown/quit semantics + Tauri + persistence + Windows (phases 2–5) are pending, gated behind `HOTSHEET_PTY_BROKER` (default OFF) and need real-app verification. Phase status in §136.7. Maintainer decision (2026-08-14): terminals **must survive an accidental server death and auto-restore as tabs** when Hot Sheet comes back online, while still being torn down on **explicit** user actions (close a terminal tab, close a project tab, quit the app).

## 136.1 Problem

When the node server process dies and comes back — OOM kill, the §45 watchdog's SIGKILL, a `--replace` relaunch, an uncaught crash, or the HS-9656 (docs/134 §134.6) bounded auto-restart — **every terminal and its running AI session is lost.** The app window survives and reconnects, but the terminals are gone, which makes the "recovery" hollow. Reported 2026-08-14 as highly disruptive; the acute trigger that day was memory pressure from running the demo capture on the live machine, but the loss happens on *any* server death.

The auto-restart (HS-9656) is **not** the cause: terminals are PTY child processes of the node server, so a server death takes them down whether or not anything restarts afterward. Before HS-9656 a death left a dead-server overlay and lost them just the same. So the fix is not "don't restart" — it is to make PTYs **outlive** an accidental node-server death.

## 136.2 Current architecture (why they die)

From the HS-9662 lifecycle audit (file:line anchors current as of 2026-08-14):

- **PTYs are ordinary children of the node server process.** The single spawn point is `defaultFactory` in `src/terminals/registry/lifecycle.ts` (`spawn as spawnPty` from `node-pty`, `sh -c "<command>"`), with **no `detached`/`setsid`** — so every PTY inherits the server's process group. When the server is SIGKILLed, the shells die on controlling-terminal loss / are reaped. Nothing re-parents them.
- **The live registry is in-memory only.** `sessions = new Map<string, SessionState>()` (`src/terminals/registry/sessionStore.ts`), keyed `` `${secret}::${terminalId}` ``. `SessionState` holds the `pty`, scrollback ring, cwd/bell/spinner state — none of it persisted.
- **Identity persistence is partial.** *Configured* terminals persist in `.hotsheet/settings.json` under `terminals` (`TerminalConfig {id,name,command,cwd?,lazy?}`, ordered = tab order; `src/terminals/config.ts`). ***Dynamic* terminals (`dyn-…`, worker pool, etc.) have zero disk persistence** — their configs live only in `dynamicConfigs = new Map()` (`src/routes/terminal.ts`). A crash loses that a dynamic terminal ever existed. **This is a gap the restore path must close.**
- **Every teardown routes through `teardownPty`** (`lifecycle.ts`: `killProcessTreeBestEffort(rootPid,'SIGTERM')` then `pty.kill('SIGHUP')`). Call sites, classified:
  - **Explicit — KEEP killing:** `/api/terminal/kill` (one terminal Stop/Force-quit), `/api/terminal/restart`, `/api/terminal/destroy` (close one terminal tab), `DELETE /api/projects/:secret` → `destroyProjectTerminals` (close a project tab). Worker reap (`reapWorker`) is server-driven-explicit.
  - **Teardown — must STOP killing (the whole point):** `destroyAllTerminals()` from the graceful pipeline (`src/lifecycle.ts` `destroyTerminals` step) **and** the synchronous `process.on('exit')` safety net (`cli.ts` `cleanupInstance`). These fire on *every* shutdown regardless of cause.
  - **Bypasses all handlers:** OOM/SIGKILL/watchdog — PTYs die purely as non-detached children in the server's process group.
- **The Tauri shell is a separate, longer-lived supervisor** (`src-tauri/src/lib.rs`): it spawns the node server as a sidecar and already **auto-restarts** it (`RestartBudget`, supervise loop, HS-9656). **Caveat:** on quit / project-switch it signals the server's *process group* (`libc::kill(-pid, SIGTERM)` in `RunEvent::Exit`, `confirm_quit`, `open_project`). Anything left in the node server's process group is swept by that group-kill.
- **The client already treats the server as the source of truth for which terminals exist.** On load / reconnect it calls `GET /api/terminal/list` (`{configured, dynamic, home}` with per-terminal `state`) and rebuilds tabs (`loadAndRenderTerminalTabs` → `ensureInstanceForEntry`), then attaches over the checkout WS (`/api/terminal/ws`), whose first frame is a `history` replay of server-held scrollback (docs/54). **This is exactly the surface auto-restore hooks into** — no new client discovery mechanism is needed if the new server can report the survived sessions from `/list` and replay their scrollback.

## 136.3 Design: a detached PTY broker

Move PTY ownership out of the node server into a **broker process that lives in its own process group** and outlives an accidental node death. The node server becomes a *client* of the broker; on restart it **re-adopts** the still-running sessions.

```
 Tauri shell (supervisor, long-lived)
   ├─ node server (sidecar)  ──control socket──▶  PTY broker (detached, own pgid)
   │    routes, DB, WS proxy                        owns node-pty processes
   │    (dies on OOM → auto-restart)                holds scrollback + dynamic identity
   └─ (on quit) explicitly signals BOTH            survives node death; reconnected on restart
```

- **Broker process.** Spawned with `detached: true` (→ `setsid`, its own session/process group) so it is **not** in the node server's process group. It therefore survives (a) the node server's SIGKILL/OOM and (b) Tauri's `kill(-pid)` of the *node* group. It owns all `node-pty` spawns and exposes a **control socket** (unix domain socket at a stable, instance-scoped path — see §136.6) with operations: `spawn`, `write`, `resize`, `kill` (explicit), `list` (live sessions + metadata), and an output `subscribe` stream. It holds the scrollback ring buffers and the **dynamic-terminal identity** (closing the §136.2 persistence gap — the broker is the SSOT for *live* terminals; settings.json remains the SSOT for *configured* ones).
- **Node server = broker client.** `defaultFactory` no longer calls `node-pty` directly; it asks the broker to spawn. `/api/terminal/ws` proxies bytes to/from the broker subscription. `/api/terminal/list` merges: settings.json `configured` + broker-reported live sessions (including survived dynamic ones). `teardownPty`'s **explicit** call sites send `kill` to the broker; the **shutdown** call sites (`destroyAllTerminals` from graceful + `process.on('exit')`) **no longer kill** — they just disconnect from the broker, leaving PTYs alive.
- **Lifecycle mapping:**
  - *Accidental node death* (OOM/SIGKILL/watchdog/crash/`--replace`): broker keeps running, PTYs + AI sessions alive. New node server boots → connects to the existing broker by the stable socket → re-adopts sessions → `/list` reports them → client rebuilds tabs and re-attaches with history replay. **Terminals + AI sessions restored automatically.**
  - *Explicit terminal-tab close* (`/api/terminal/kill|destroy`): node → broker `kill(sessionId)`.
  - *Explicit project-tab close* (`DELETE /api/projects/:secret`): node → broker `kill` for that project's sessions.
  - *Explicit app quit:* the broker is in its own process group, so Tauri's `kill(-pid)` of the node group does **not** reach it. Tauri must **explicitly** signal the broker to kill all PTYs and exit (new wiring in `confirm_quit` / `RunEvent::Exit`). The CLI (non-Tauri) graceful pipeline gets an equivalent explicit "quit broker" step distinct from the "detach from broker" step.
  - *Orphan safety:* the broker holds a **client lease / heartbeat**. If no node server (and, under Tauri, no supervisor) reconnects within a grace window, the broker self-exits and kills its PTYs — so a crashed Tauri can never leave immortal orphan shells (cf. the HS-9391 immortal-orphan class).

## 136.4 What survives vs. what does not

- **Survives:** an accidental **node-server** death (the common case — OOM, watchdog, crash, restart, `--replace`).
- **Does NOT survive (accepted scope):** death of the **broker itself**, or a machine reboot. The broker is small and stable (no DB, no WASM heaps, no request handling — the memory-heavy work that OOMs is all in the node server), so its death is far rarer. As defense-in-depth, dynamic terminal *identity* is also persisted to settings.json (§136.5) so that after a broker death the *tabs* can at least be re-listed (PTYs would respawn fresh, not restored). Full broker-death survival (detaching PTYs from the broker too) is explicitly out of scope — diminishing returns.

## 136.5 Persistence gap to close

Dynamic terminals (`dyn-…`, worker-pool) currently exist only in `dynamicConfigs` (memory). For restore to *list* them the identity must be durable. Two layers:
1. **Broker holds live dynamic identity** — the SSOT across a node restart (this is what makes auto-restore work without touching settings.json).
2. **Mirror dynamic configs into `.hotsheet/settings.json`** (a `dynamic_terminals` array, or extend `terminals` with an `origin: dynamic` marker) as defense so identity survives even a broker death. Keep the write debounced/coalesced.

## 136.6 Open questions

- **Broker ownership / spawn:** node spawns it detached-if-absent (works for CLI *and* Tauri, universal) vs. Tauri spawns it as a second sidecar (cleaner supervision, but Tauri-only). Leaning **node-spawns-detached-if-absent**, with Tauri learning the broker pid for the explicit quit-kill. Confirm the CLI/browser (non-Tauri) path also wants survival across a manual server restart (likely yes, low cost once the broker exists).
- **Instance isolation:** the socket path must be scoped per Hot Sheet instance so `HOTSHEET_HOME` test instances (docs/87) and multiple installs don't share a broker. Key it off the same identity used for the lock/instance.
- **Scrollback memory moves to the broker.** The broker now holds every terminal's ring buffer. Bound it (reuse the RingBuffer sizing) and note the shift relative to docs/128 (the node server's memory drops; the broker's is small + bounded).
- **Windows:** no `setsid`/process-groups; `node-pty` + a detached child + a named pipe (instead of a unix socket) — the separate-process survival model still holds, but signal/detach semantics need a platform branch (mirror the `build_kill_command`/`build_tts_command` pure-function pattern so both OS branches are testable on any host).
- **`--replace` race (observed 2026-08-14):** a relaunch left **two** servers bound to 4174 (old on IPv4, new on IPv6) with the API 404ing — the old instance didn't release the port before the new one bound. Independent of the broker, but it worsens restart disruption and should be fixed alongside (HS-9657 real-app verification territory): the new server must reliably evict the old (confirm the lock/`--replace` handshake actually kills + waits for port release). Filed as its own follow-up.

## 136.7 Phased implementation (→ follow-up tickets)

Gated behind `HOTSHEET_PTY_BROKER` (docs/124 dev-gate pattern), default OFF, so nothing changes on the critical terminal path until the maintainer verifies it in the real app (this class of change can't be verified headlessly — the terminal integration tests can log out the macOS session, and true survival needs the desktop app + killing the server; the HS-9657 real-app-verification precedent applies).

**1a. Control protocol — SHIPPED (commit a8ab82ea).** `src/terminals/broker/protocol.ts`: newline-delimited JSON frames, base64 binary, stable `secret::terminalId` sessionId. Pure; 10 unit tests.

**1b. Broker process + node client — SHIPPED (commit cb0b09a9).** `src/terminals/broker/ptyBroker.ts` (owns node-pty, scrollback, identity; `hello`→`welcome`+`history` re-adoption; client-lease self-exit; explicit kill/killPrefix/shutdown) + `src/terminals/broker/brokerClient.ts` (connect-or-spawn, proxy, stream, ping). 7 integration tests incl. a REAL self-exiting node-pty and the re-adoption+history path. **Additive — not yet wired into the registry.** Tests inject a no-op process-tree killer so fake-PTY pids are never signalled.

**2. Wire into the registry + startup re-adoption — PENDING (the survival feature).** Behind the gate: a `BrokerBackedPty implements PtyLike` (write/resize/kill proxy to the client; onData/onExit driven by a per-`sessionId` router) so the rest of `lifecycle.ts` (scrollback/OSC/bell handling) is unchanged; store `secret` on `SessionState` so the spawn path can form the sessionId; on node boot connect the broker, `list()`, and re-adopt each session (createSession + seed scrollback from `history` + attach a proxy pty); `/api/terminal/list` already drives the client tab rebuild. A broker entry script (`src/terminals/broker/main.ts`) + a tsup build target + a dev (tsx) spawn path + a per-instance socket path (§136.6 instance isolation).

**3. Shutdown/quit semantics — PENDING.** Under the gate: `destroyAllTerminals` (graceful `destroyTerminals` step + `process.on('exit')`) DISCONNECTS the client instead of killing (survival); the graceful pipeline additionally calls `shutdownBroker()` ONLY on an explicit quit (SIGTERM/SIGINT/`/api/shutdown`) so app-quit kills terminals but an OOM/`--replace` SIGKILL (no handler runs) leaves them alive. Explicit `/kill` `/destroy` `DELETE /api/projects/:secret` route to the broker. Because the broker is detached (own process group), Tauri's `kill(-pid)` of the node group does NOT reach it — the node graceful handler is what kills it on quit; verify Tauri escalation timing gives the handler time (docs/134), else add an explicit Tauri→broker kill.

**4. Dynamic-config persistence — PENDING** (§136.5) so restore lists dynamic + worker terminals (the broker already stores + echoes `meta`; also mirror to settings.json as broker-death defense).

**5. Windows parity + full test matrix — PENDING:** named pipe instead of unix socket + detach semantics; accidental-death survival test (spawn → SIGKILL the node server → new server re-adopts → session alive), explicit-close test, orphan-exit test, `--replace` port-release test.

## 136.8 Relationship to other work

- **HS-9656 / docs/134 §134.6** (bounded auto-restart) — the absorption layer; this doc makes that recovery *lossless* for terminals.
- **docs/54** (terminal checkout) — client-side render survival across page reloads; this is the orthogonal *server-process* survival. The checkout WS + `history` replay is the client surface auto-restore reuses.
- **docs/22** (terminal drawer), **docs/38/39** (visibility groupings) — configured-terminal identity + client tab state that the rebuilt tabs restore into.
- **docs/128 / docs/131** (cluster memory / system pressure) — reduce how *often* the node server dies (HS-9566 / §134.10); this doc removes the terminal cost *when* it does.
