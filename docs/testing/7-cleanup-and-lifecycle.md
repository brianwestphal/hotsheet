# Cleanup, Lock Files, Gitignore & CLI Testing

**Risk Level: Medium**

These are supporting systems that run at startup or in the background. Bugs tend to surface as startup failures, data loss from over-aggressive cleanup, or multiple instances corrupting the database.

## Auto-Cleanup

**What to test:** Only the right tickets are cleaned up, using correct thresholds.

- Reads `trash_cleanup_days` and `verified_cleanup_days` from database settings.
- Falls back to defaults (3 and 30) if settings are missing or unparseable.
- Calls `getTicketsForCleanup()` which selects verified tickets older than the verified threshold and deleted tickets older than the trash threshold.
- For each qualifying ticket, removes attachment files from disk, then hard-deletes the ticket.
- Tickets exactly at the threshold are NOT cleaned up (strict "older than" comparison).
- Tickets in other statuses (not_started, started, completed, backlog, archive) are never cleaned up regardless of age.

## Lock File Management

**What to test:** Mutual exclusion and stale lock recovery.

- `acquireLock()` creates a lock file containing `{ pid, startedAt }`.
- If a lock file exists and the PID is alive, startup exits with an error.
- If a lock file exists but the PID is dead (stale), the lock is removed and a new one is acquired.
- If the lock file contains corrupt JSON, it is treated as stale and replaced.
- On process exit (normal, SIGINT, SIGTERM), the lock file is removed.
- The lock file is not created in demo mode.

## Gitignore Management

**What to test:** Safe, idempotent gitignore modification.

- `isGitRepo()` returns true for a directory inside a git repository, false otherwise.
- `isHotsheetGitignored()` returns true if `.hotsheet/` appears in any `.gitignore` in the repo.
- `ensureGitignore()` appends `.hotsheet/` to the root `.gitignore` if not already present.
- If `.gitignore` doesn't exist, it is created.
- Calling `ensureGitignore()` twice does not add a duplicate entry.
- A trailing newline is ensured before appending.
- Not called in demo mode.

## CLI Argument Parsing

**What to test:** All arguments are parsed correctly with proper validation.

- `--port 8080` sets the port to 8080.
- `--port` without a value, or with a non-numeric value, produces an error.
- `--data-dir ~/custom` resolves to the correct absolute path.
- `--no-open` prevents the browser from opening.
- `--strict-port` causes the app to exit if the port is in use (instead of trying alternatives).
- `--demo:3` enables demo mode with scenario 3.
- `--check-for-updates` triggers an immediate update check.
- `--help` prints usage and exits.
- No arguments uses defaults (port 4174, data-dir .hotsheet/).

## Port Selection

**What to test:** Fallback logic when the default port is unavailable.

- If port 4174 is available, it is used.
- If port 4174 is in use, ports 4175–4193 are tried in order.
- The first available port in the range is used.
- If all ports 4174–4193 are in use, the app exits with an error.
- With `--strict-port`, no fallback is attempted.

## CLI Update Checking

**What to test:** Daily check against npm registry.

- Checks the npm registry for the latest version of the `hotsheet` package.
- Only checks once per day (stores the last check date in `~/.hotsheet/last-update-check`).
- `--check-for-updates` forces a check regardless of the last check date.
- If a newer version is available, prints an upgrade banner with the correct package manager command.
- Auto-detects the package manager (npm, yarn, pnpm, bun) from the binary path.
- Network failures are handled silently (no crash).

## Demo Mode

**What to test:** Isolation and data seeding.

- Demo mode creates a temp directory outside the project.
- Lock file and gitignore checks are skipped.
- The database is seeded with the correct scenario data.
- All 7 scenarios (1–7) produce valid ticket data.
- An invalid scenario number (e.g., 8) is handled gracefully.
- Scenario-specific settings (e.g., scenario 6 sets bottom detail panel) are applied.
- The ticket sequence is advanced past seeded data so new tickets don't collide.
