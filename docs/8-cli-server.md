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
| `--close` | Unregister the current project from the running instance and exit |
| `--list` | List all projects registered with the running instance and exit |
| `--check-for-updates` | Check the npm registry for a newer version immediately |
| `--demo:<scenario>` | Launch with demo data (see §8.8) |
| `--help` | Display usage information |

### 8.3 Port Selection

- Default port: 4174.
- If the default port is in use, the application automatically tries ports 4174–4193 until an available port is found.
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
10. Run auto-cleanup for stale tickets (synchronous, blocking).
11. Start the Hono HTTP server.
12. Trigger initial markdown sync.
13. Generate/update AI tool skill files.
14. Start the automatic backup scheduler.
15. Write the instance file (`~/.hotsheet/instance.json`).
16. Open the browser (unless `--no-open`).

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

Demo mode launches the application with pre-populated sample data, intended for screenshots, demonstrations, and feature exploration. Invoked via `--demo:<N>` where N is a scenario number (1–9).

#### Behavior
- Creates a temporary, isolated data directory in the OS temp folder (not inside the project).
- Skips lock file checks (no risk of collision).
- Skips gitignore checks (temp directory is outside any repo).
- Seeds the database with scenario-specific ticket data on startup.
- The demo instance is fully functional — tickets can be created, edited, and deleted — but data is ephemeral.

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

#### Scenario-Specific Settings
- Scenario 6 sets `detail_position` to `bottom` and `detail_height` to `280`.
- Scenario 7 sets `layout` to `columns`.

#### Demo Data Characteristics
- Tickets have realistic titles, detailed descriptions, and timestamped notes showing work progress.
- Dates are relative (e.g., "5 days ago") so demos always look current.
- Ticket numbers start at HS-1; the sequence is advanced past seeded data so new tickets don't collide.

## Non-Functional Requirements

### 8.9 Graceful Startup

- Port conflicts are handled gracefully with automatic fallback (unless strict mode).
- Stale lock files from crashed processes are cleaned up automatically.
- Schema migrations are idempotent and safe to re-run.
