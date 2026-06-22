# 8. CLI & Server

## Functional Requirements

### 8.1 CLI Entry Point

The application is launched from the command line via the `hotsheet` command (installed globally via npm).

### 8.2 CLI Arguments

| Argument | Description |
|----------|-------------|
| `--port <number>` | Run on a specific port (default: 4174) |
| `--data-dir <path>` | Store data in a custom directory (default: `.hotsheet/`) |
| `--no-open` | Don't open the browser on startup (used by Tauri sidecar) |
| `--strict-port` | Fail if the specified port is already in use (used by Tauri dev) |
| `--replace` | Shut down any running Hot Sheet instance before starting a fresh one (used by `npm run tauri:dev`; see §8.4) |
| `--close` | Unregister the current project from the running instance and exit |
| `--list` | List all projects registered with the running instance and exit |
| `--test` | Run a fully-isolated test instance (see §8.8.1): own `~/.hotsheet-test` global state, sandbox project data-dir, default port `4274`, TEST badge — never touches the real instance/projects |
| `--check-for-updates` | Check the npm registry for a newer version immediately |
| `--demo:<scenario>` | Launch with demo data (see §8.8) |
| `--help` | Display usage information |

### 8.3 Port Selection

- Default port: 4174.
- If the specified port is in use, the application tries up to 20 consecutive ports starting from the specified port (default 4174, so 4174–4193 by default).
- If `--strict-port` is set, the application fails with an error instead of trying alternative ports.
- The actual port is communicated to the UI and used in markdown sync exports.

### 8.4 Multi-Project Instance Management

Only one Hot Sheet server runs at a time. Subsequent invocations from other project directories join the running instance instead of starting a new server.

- **Instance file**: `~/.hotsheet/instance.json` stores `{ port, pid }` for the running server.
- **On startup** (non-demo mode): the CLI checks the instance file. If a responsive server is found, the CLI registers the current project via `POST /api/projects/register`, opens the browser, and exits.
- **On server start**: the instance file is written with the actual port and PID.
- **On server exit** (SIGTERM/SIGINT/exit): the instance file is removed if the PID matches.
- **`--close`**: reads the instance file, finds the project's secret from its `settings.json`, and calls `DELETE /api/projects/:secret` to unregister the project. Cannot unregister the last remaining project.
- **`--list`**: reads the instance file and calls `GET /api/projects` to display all registered projects with their ticket counts.
- **`--replace`**: if a running instance is detected, `POST /api/shutdown` to it (localhost same-origin mutation exemption, so no secret is required), poll the port until it stops responding (10 s timeout), then fall through to fresh startup. If no running instance is found, behaves identically to normal startup. The Tauri dev build (`cfg(debug_assertions)`) passes this flag automatically so `npm run tauri:dev` always starts a clean server instead of joining an existing one.
- **Demo mode** skips instance detection entirely and always starts a fresh server.

### 8.4.1 Request Routing via AsyncLocalStorage

The server uses Node.js `AsyncLocalStorage` to route each HTTP request to the correct project's database. Middleware resolves the project context from the `X-Hotsheet-Secret` header or `?project=` query parameter and stores it in the async context for the duration of the request. All existing DB query functions work unchanged — they call `getDb()` which checks the async context first.

### 8.4.2 Project Tab Persistence

Project tabs are persisted to `~/.hotsheet/projects.json` and restored on restart, so the server remembers which projects were registered across restarts.

### 8.5 Startup Sequence

1. Parse CLI arguments.
2. Handle `--close` or `--list` if specified (communicate with running instance and exit).
3. Check for CLI updates (daily, via npm registry).
4. Check for a running instance (`~/.hotsheet/instance.json`). If found and responsive, register the current project and exit.
5. Resolve the data directory (temp directory for demo mode).
6. Ensure the `.hotsheet/` data directory exists.
7. Acquire the lock file (non-demo only).
8. Ensure `.hotsheet/` is in `.gitignore` (if in a git repo, non-demo only).
9. Initialize the PGLite database and run schema migrations.
10. Run auto-cleanup for old verified/deleted tickets and their attachment files (synchronous, blocking).
11. Start the Hono HTTP server.
12. Bump process priority to macOS QoS class `user-interactive` (HS-8308 — best-effort, macOS only; see §8.10).
13. Trigger initial markdown sync.
14. Generate/update AI tool skill files.
15. Start the automatic backup scheduler.
16. Restore previous projects from `~/.hotsheet/projects.json`.
17. Migrate global config (one-time migration from DB).
18. Clean up stale channel servers.
19. Set up skills and channel config for all projects.
20. Install Claude Code heartbeat hooks (if channel enabled).
21. Write the instance file (`~/.hotsheet/instance.json`).
22. Open the browser (unless `--no-open`).

### 8.6 HTTP Server

- Built on the Hono framework with `@hono/node-server`.
- Serves the single-page HTML application, client JS bundle, and CSS.
- Provides a JSON REST API (see [9-api.md](9-api.md)).
- Serves attachment files with correct MIME types.

### 8.7 CLI Update Checking

- Once per day, checks the npm registry for a newer version of the `hotsheet` package.
- If an update is available, displays a colored banner in the terminal with the upgrade command.
- Auto-detects the user's package manager (npm, yarn, pnpm, bun) from the install path.
- Can be forced with `--check-for-updates`.

### 8.8 Demo Mode

Demo mode launches the application with pre-populated sample data, intended for screenshots, demonstrations, and feature exploration. Invoked via `--demo:<N>` where N is a scenario number (1–14).

#### Behavior
- Creates a temporary, isolated data directory in the OS temp folder (not inside the project).
- Sets `appName` to "Hot Sheet Demo" for a clean title/tab display.
- Skips lock file checks (no risk of collision).
- Skips gitignore checks (temp directory is outside any repo).
- Seeds the database with scenario-specific ticket data on startup.
- The demo instance is fully functional — tickets can be created, edited, and deleted — but data is ephemeral.
- **Forces the DOM terminal renderer** (HS-8612): `src/cli.ts` calls `setDemoMode(true)` (`src/demo-mode.ts`) before the server starts, and the page `<head>` stamps `window.__HOTSHEET_DEMO__`, which `shouldUseWebglRenderer()` reads to skip WebGL. This keeps the live `<span>`-per-cell terminal tree intact for domotion-svg capture (see [22-terminal.md](22-terminal.md) §22.21). Applies regardless of the user's "Use software rendering" setting.

#### Scenarios

Each scenario uses realistic e-commerce project data with a mix of categories, priorities, and statuses:

| # | Label | Purpose |
|---|-------|---------|
| 1 | Main UI | All tickets with detail panel — full variety of categories, priorities, statuses, up_next, notes |
| 2 | Quick Entry | Few tickets — demonstrates bullet-list quick entry via the draft row |
| 3 | Sidebar Filtering | Many categories represented — demonstrates category/priority filtering |
| 4 | AI Worklist | Up Next tickets with progress notes — demonstrates the AI-facing worklist view |
| 5 | Batch Operations | Many similar tickets — demonstrates multi-select and batch toolbar |
| 6 | Detail Panel Bottom | Rich notes with timestamps — detail panel set to bottom orientation, reduced height |
| 7 | Column View | Tickets spread across statuses — layout pre-set to column/kanban view |
| 8 | Dashboard | Stats and charts |
| 9 | Claude Channel | AI integration with custom commands |
| 10 | Multi-Project Tabs | Multiple projects in one window — registers additional projects with independent ticket data |
| 11 | Embedded Terminal | Drawer terminal with named tabs and canned PTY output (Dev Server, Tests, Claude) |
| 12 | Terminal Dashboard | Multi-project dashboard — primary project plus Mobile App + API Platform, each with its own terminals; click the `square-terminal` toolbar button to enter the grid |
| 13 | Telemetry | Cross-project Claude Code cost tracking — primary plus Mobile App + API Platform with seeded `otel_metrics`; click the header `line-chart` button to enter the cross-project stats page |
| 14 | Announcer | A/V narration of project work — clicks the header **Listen** button to open the transcript PIP over the hero board; the announcer endpoints are mocked client-side by `scripts/capture-demos.ts` with a curated reel (emphasis + a code-diff visual) since the real PIP needs an Anthropic key / on-device provider that can't be seeded headlessly |

#### Scenario-Specific Settings
- **Scenarios 1, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14** set `layout` to `columns` (HS-8430). Column view is the more visually compelling + representative mode, so it's the default for the marketing-screenshot scenarios. Scenarios 2 and 6 stay in list view because list view IS what they demonstrate (bullet-list quick entry / bottom detail panel respectively). Scenario 8 (Dashboard) overrides the layout entirely with its own view, so the setting is omitted.
- Scenario 6 sets `detail_position` to `bottom` and `detail_height` to `280`.
- Scenario 10 creates and registers two additional projects ("Mobile App" and "API Platform") with their own ticket data, demonstrating the tabbed multi-project interface.
- Scenario 11 sets `drawer_open=true`, `drawer_expanded=true`, `drawer_active_tab=terminal:dev-server`, plus three configured terminals (Dev Server, Tests, Claude) with canned PTY output so the embedded-terminal screenshot has visible content.
- Scenario 12 reuses scenario 11's primary-project terminals AND registers Mobile App + API Platform from scenario 10, with each extra project carrying its own 2-terminal config (Metro + logcat for Mobile App; API Server + pg log for API Platform). The dashboard-open flag is in-memory only (§25), so the screenshot workflow is "launch demo:12, click the square-terminal toolbar button, capture the grid".
- Scenario 13 enables `telemetry_enabled` on the primary plus the two extra projects (Mobile App + API Platform) and seeds ~30 days of `otel_metrics` cost rows per project into the shared telemetry DB (HS-8682). The cross-project stats page is reached via the header `line-chart` button (visible only when telemetry is enabled on at least one project), so the screenshot workflow is "launch demo:13, click the button, capture the page".
- Scenario 14 (Announcer) needs no server-side announcer settings — the transcript PIP is gated on an API key / on-device provider that can't be reproduced headlessly, so `scripts/capture-demos.ts` mocks the `/api/announcer/*` read endpoints client-side (the same hermetic pattern as `e2e/announcer.spec.ts`) with a hand-authored reel and stubs the Web Speech API so playback parks on the lead, code-diff-carrying entry. It reuses the hero (`SCENARIO_1`) tickets for the board behind the PIP.

#### Demo Data Characteristics
- Tickets have realistic titles, detailed descriptions, and timestamped notes showing work progress.
- Dates are relative (e.g., "5 days ago") so demos always look current.
- Ticket numbers start at HS-1; the sequence is advanced past seeded data so new tickets don't collide.

### 8.8.1 Test Instance (`--test`, HS-8921)

`--test` runs a fully-isolated instance for dogfooding a dev build without
risking the real running copy. It applies these defaults, **each only when the
user didn't pass the explicit flag** (`--port` / `--data-dir` / a pre-set
`HOTSHEET_HOME` always win, order-independent):

- Sets `HOTSHEET_HOME` to a stable `~/.hotsheet-test` (when unset/blank) so ALL
  global state (registry, config, instance file, telemetry, startup log,
  plugins) is isolated — see [87-test-instance.md](87-test-instance.md).
- Defaults the port to `4274` so the test instance and prod (`4174`) coexist.
- Defaults the data-dir to a sandbox project under the isolated home
  (`<HOTSHEET_HOME>/sandbox-project/.hotsheet`), so launching `--test` from
  inside a real project never writes `.hotsheet/` into it.
- Flags the process as test mode (`src/test-mode.ts::setTestMode`) for the TEST
  badge (HS-8922).

`HOTSHEET_HOME` is applied at the very top of `main()`
(`maybeApplyTestModeHome`), before the startup log opens, so even diagnostics
land in the isolated home. Because `instance.json` is isolated, `--test
--replace` can only target a prior test instance, never prod. Convenience: `npm
run dev:test`; the Tauri shell forwards `--test` to the sidecar. Full contract +
the "what is / isn't isolated" table live in
[87-test-instance.md](87-test-instance.md).

## Non-Functional Requirements

### 8.9 Graceful Startup

- Port conflicts are handled gracefully with automatic fallback (unless strict mode).
- Stale lock files from crashed processes are cleaned up automatically.
- Schema migrations are idempotent and safe to re-run.

### 8.10 Process Priority (HS-8308)

On macOS, the Node server shells out to `taskpolicy -p $$ -c user-interactive` immediately after the HTTP server starts. `taskpolicy(8)` is bundled with macOS and does not require sudo; it bumps the process's Quality of Service class to `user-interactive` — the highest user-space tier and what Terminal.app implicitly runs with. Without the bump, a Node sidecar inherits the parent's QoS (typically `user-initiated` or lower) and keystroke handling competes with sibling processes for CPU under heavy load (e.g. `npm test` running inside the embedded terminal).

Behaviour:

- **Best-effort**. `bumpProcessPriorityBestEffort()` in `src/processPriority.ts` runs `taskpolicy` via `spawnSync` with a 2 s timeout. Non-zero exits, missing binary, or spawn errors log a single `[priority] …` warning and the server continues.
- **macOS only**. `shouldBumpProcessPriority(process.platform)` short-circuits on Linux + Windows. Linux equivalent (`nice -n -10`) requires `CAP_SYS_NICE` / root; Windows would need a native-module shim for `SetPriorityClass`. Both are out of scope.
- **Always-on** when the platform gate passes — no env-var opt-out. The `user-interactive` class is the safe ceiling for an interactive UI server; lowering it would re-introduce the lag the bump exists to fix.
- **Logged on success** as `Process priority: macOS QoS class set to user-interactive` in the boot output, paralleling the existing `Data directory: …` line.

Testing: pure helpers `shouldBumpProcessPriority(platform)` + `buildTaskpolicyArgs(pid, qosClass?)` are unit-tested in `src/processPriority.test.ts` (8 cases — platform gate × 6, argv builder × 4 incl. default-class constant pin). The actual `spawnSync` call is exercised in real macOS boots; mocking it adds no fidelity over the pure helpers.

### 8.11 Self-Diagnosing Launch / Startup Log (HS-8704)

The installed (Tauri) beta app could hang forever on the "Starting Hot Sheet…" splash, and the hang reproduced **only** on a GUI launch (`open -a 'Hot Sheet'` / Dock / Spotlight) — launching the binary straight from a terminal worked. The difference is the controlling terminal: a GUI launch gives the process none, so every `console.error` phase marker the sidecar emitted went to a pipe nobody was reading, and the Tauri shell's own `eprintln\!` markers vanished too. There was no record of *where* startup stalled.

The fix persists the launch timeline to a file that survives a GUI launch:

- **Module:** `src/startup-log.ts` (Node sidecar) + `src-tauri/src/lib.rs::startup_log` (Tauri shell). Both append to the SAME file, so the two processes interleave by ISO timestamp into one timeline.
- **Location:** `~/.hotsheet/startup.log`. Overridable with the `HOTSHEET_STARTUP_LOG` env var (full path) for support escalations and tests.
- **Header per launch:** timestamp, pid, platform, Node version, argv, cwd, and whether stderr is a TTY (the GUI-launch tell).
- **Phase markers:** `main()` calls `startupMark(phase)` at each milestone (parsed args → update check → existing-instance handling → init-project sub-phases incl. the DB-init prime suspect → server started → post-startup sub-phases → finished). Each marker is mirrored to stderr (so terminal launches + the live Tauri sidecar-stderr reader are unchanged) **and** the log, and updates a current-phase tracker.
- **Escalating watchdog:** `createStartupWatchdog(...)` replaces the old single 10 s one-shot. It fires at 10 s / 20 s / 30 s, then every 30 s, each time **naming the phase startup is stuck in** and stamping the durable log — so a wedged launch points straight at the culprit. Pure factory (timers + clock injected) like `createSignalHandler`.
- **Fatal errors:** the top-level `main().catch` writes `[startup] FATAL: <message>` to the log right after the last phase marker, so a crash (vs. a hang) is equally visible.
- **Size cap:** ~1 MB; the file is truncated on `initStartupLog` when it exceeds the cap, so it can't grow without bound across launches.
- **Best-effort:** any filesystem error silently disables file logging — diagnostics can never themselves break startup.

The cross-language "leave the splash" handshake (the `running at ` / `running instance on port ` stdout substrings the Tauri shell greps for) is separately pinned by `src/launchReadinessContract.test.ts`; the startup-log behaviors are unit-tested in `src/startup-log.test.ts`.
