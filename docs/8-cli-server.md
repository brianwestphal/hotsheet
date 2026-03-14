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
| `--check-for-updates` | Check the npm registry for a newer version immediately |
| `--demo:<scenario>` | Launch with demo data (see §7.7) |
| `--help` | Display usage information |

### 8.3 Port Selection

- Default port: 4174.
- If the default port is in use, the application automatically tries ports 4174–4193 until an available port is found.
- If `--strict-port` is set, the application fails with an error instead of trying alternative ports.
- The actual port is communicated to the UI and used in markdown sync exports.

### 8.4 Startup Sequence

1. Parse CLI arguments.
2. Create the data directory if it doesn't exist.
3. Check and acquire the lock file.
4. Initialize the PGLite database and run schema migrations.
5. Load settings from the database.
6. Ensure `.hotsheet/` is in `.gitignore` (if in a git repo).
7. Generate/update AI tool skill files.
8. Start the Hono HTTP server.
9. Run auto-cleanup for stale tickets.
10. Start the automatic backup scheduler.
11. Trigger initial markdown sync.
12. Check for CLI updates (daily, via npm registry).
13. Open the browser (unless `--no-open`).

### 8.5 HTTP Server

- Built on the Hono framework with `@hono/node-server`.
- Serves the single-page HTML application, client JS bundle, and CSS.
- Provides a JSON REST API (see [9-api.md](9-api.md)).
- Serves attachment files with correct MIME types.

### 8.6 CLI Update Checking

- Once per day, checks the npm registry for a newer version of the `hotsheet` package.
- If an update is available, displays a colored banner in the terminal with the upgrade command.
- Auto-detects the user's package manager (npm, yarn, pnpm, bun) from the install path.
- Can be forced with `--check-for-updates`.

### 8.7 Demo Mode

Demo mode launches the application with pre-populated sample data, intended for screenshots, demonstrations, and feature exploration. Invoked via `--demo:<N>` where N is a scenario number (1–7).

#### Behavior
- Creates a temporary, isolated data directory in the OS temp folder (not inside the project).
- Skips lock file checks (no risk of collision).
- Skips gitignore checks (temp directory is outside any repo).
- Seeds the database with scenario-specific ticket data on startup.
- Cleans up stale temp preview directories from prior demo runs.
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

#### Scenario-Specific Settings
- Scenario 6 sets `detail_position` to `bottom` and `detail_height` to `280`.
- Scenario 7 sets `layout` to `columns`.

#### Demo Data Characteristics
- Tickets have realistic titles, detailed descriptions, and timestamped notes showing work progress.
- Dates are relative (e.g., "5 days ago") so demos always look current.
- Ticket numbers start at HS-1; the sequence is advanced past seeded data so new tickets don't collide.

## Non-Functional Requirements

### 8.8 Graceful Startup

- Port conflicts are handled gracefully with automatic fallback (unless strict mode).
- Stale lock files from crashed processes are cleaned up automatically.
- Schema migrations are idempotent and safe to re-run.
