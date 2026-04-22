# Hot Sheet

## Project Overview

A lightweight, locally-running project management tool for developers. Launched from the CLI, it opens a browser-based UI where users create, categorize, and prioritize tickets with a fast bullet-list interface. Markdown worklists are automatically synced to `.hotsheet/` for consumption by AI tools like Claude Code.

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode)
- **Server**: Hono framework with `@hono/node-server`
- **Database**: PGLite (embedded PostgreSQL) — data stored in `.hotsheet/`
- **Rendering**: Custom JSX runtime (no React) — produces HTML strings via `SafeHtml` class (shared by server and client)
- **Build**: tsup (server CLI + client JS bundles) + sass (SCSS → CSS)
- **Dev**: tsx for direct TypeScript execution (client assets pre-built)

## Architecture

The app is a single-entry CLI (`src/cli.ts`) that:
1. Creates the `.hotsheet/` data directory
2. Initializes PGLite and runs schema migrations
3. Starts a Hono HTTP server on port 4174
4. Syncs markdown worklists to `.hotsheet/worklist.md` and `.hotsheet/open-tickets.md`
5. Runs cleanup for old trash/completed items

### Key Files

- `src/cli.ts` — CLI entry point, arg parsing
- `src/server.ts` — Hono app setup, static file serving
- `src/routes/api.ts` — JSON API (tickets CRUD, batch operations, attachments, settings)
- `src/routes/pages.tsx` — Server-rendered HTML page
- `src/components/layout.tsx` — HTML layout shell
- `src/db/connection.ts` — PGLite setup and schema initialization (raw SQL, no ORM)
- `src/db/queries.ts` — All database operations
- `src/sync/markdown.ts` — Syncs worklist.md and open-tickets.md on ticket changes
- `src/cleanup.ts` — Auto-cleanup of old trash/completed tickets and orphaned attachments
- `src/gitignore.ts` — Ensures `.hotsheet/` is in `.gitignore`
- `src/jsx-runtime.ts` — Custom JSX runtime (HTML string generation, shared by server and client)
- `src/types.ts` — Shared types (Ticket, TicketCategory, TicketPriority, AppEnv)

### Client-Side Code

- `src/client/app.ts` — Entry point, binds all UI interactions
- `src/client/state.ts` — Shared state, types, settings
- `src/client/dom.ts` — `toElement()` helper for converting JSX to DOM elements
- `src/client/api.tsx` — API helper, file upload, network error popup
- `src/client/ticketList.tsx` — Ticket list rendering, row creation, data loading
- `src/client/dropdown.tsx` — Context menu dropdowns (category, priority)
- `src/client/detail.tsx` — Detail panel, resize, stats
- `src/client/styles.scss` — All styles in a single SCSS file

### JSX Runtime

The project uses a custom JSX runtime (`src/jsx-runtime.ts`) instead of React. It renders JSX to HTML strings via the `SafeHtml` class. This runtime is shared by both the server-side components and client-side modules. Configured via:
- `tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "#jsx"`
- `package.json` imports map: `"#jsx/jsx-runtime": "./src/jsx-runtime.ts"`
- `tsup.config.ts`: esbuild alias resolves `#jsx/jsx-runtime` at build time (both server and client configs)

When writing TSX components, they return `SafeHtml` (which is `JSX.Element`). Use `raw()` to inject pre-escaped HTML strings. All string children are auto-escaped. In client code, convert JSX to DOM elements with `toElement()` from `src/client/dom.ts`, or to string for `innerHTML` with `.toString()`.

### Database

Raw PGLite queries (no ORM). Tables:
- `tickets` — ticket records (title, details, category, priority, status, up_next)
- `attachments` — file attachments linked to tickets
- `settings` — key-value pairs for app configuration

### Ticket Types

- `issue` — General issues that need attention
- `bug` — Bugs that should be fixed in the codebase
- `feature` — New features to be implemented
- `requirement_change` — Changes to existing requirements
- `task` — General tasks to complete
- `investigation` — Items requiring research or analysis

### Markdown Sync

Ticket changes trigger debounced syncs of two markdown files:
- `worklist.md` — "Up Next" tickets sorted by priority, for AI tool consumption
- `open-tickets.md` — All open tickets grouped by status

## Build

```bash
npm run build          # tsup -> dist/cli.js + dist/client/app.js + dist/client/styles.css
npm run build:client   # Build only client assets (JS + CSS) into dist/client/
npm run dev            # Build client assets, then run via tsx
```

The build produces:
- `dist/cli.js` — Server ESM bundle with Node shebang. External deps (`@electric-sql/pglite`, `hono`, `@hono/node-server`) are kept external.
- `dist/client/app.js` — Client JS bundle (IIFE, minified, es2020 target)
- `dist/client/styles.css` — Compiled and compressed CSS from SCSS

## Testing

```bash
npm test              # Unit tests with coverage (vitest)
npm run test:watch    # Unit tests in watch mode
npm run test:e2e      # E2E browser tests (Playwright)
npm run test:fast     # Unit tests + fast E2E (skips GitHub plugin / live integration tests)
npm run test:e2e:fast # E2E only, skipping GitHub plugin / live integration tests
npm run test:all      # Unified coverage: unit + E2E server + E2E browser, merged report
npm run test:all-including-plugins  # Same as test:all but includes plugin tests in coverage
```

The `test:fast` and `test:e2e:fast` scripts exclude tests that require GitHub API credentials (plugin sync, live integration). These are the scripts that should run in CI (GitHub Actions) by default. The full `test:e2e` suite including live GitHub integration tests should only run locally when credentials are configured.

### Testing Philosophy

- **Double coverage**: Every feature should be covered by both unit tests AND E2E tests. Unit tests verify logic in isolation; E2E tests verify real user flows through the actual running application with minimal mocking.
- **Unit tests** (`src/**/*.test.ts`): Use vitest. Mock external dependencies (filesystem, network) but test real logic. Use `setupTestDb`/`cleanupTestDb` from `test-helpers.ts` for database tests.
- **E2E tests** (`e2e/*.spec.ts`): Use Playwright with Chromium. Start a real Hot Sheet server with a temp data directory. Test through the browser — create tickets, click buttons, verify UI state. Minimize mocks; the whole point is exercising the real stack.
- **Coverage target**: Maximize coverage from both test types. The `npm run test:all` script merges unit + E2E server + E2E browser coverage into a single report. Files showing low coverage should get both more unit tests AND more E2E test flows.
- **Coverage collection**: Unit coverage via `@vitest/coverage-v8`. E2E server coverage via `NODE_V8_COVERAGE` with `node --import tsx`. E2E browser coverage via Playwright's `page.coverage.startJSCoverage()`, source-mapped from the esbuild bundle back to individual `.tsx` files.
- **Manual test plan** (`docs/manual-test-plan.md`): Lists features that can't be reliably automated (drag-and-drop, platform-specific behavior, Tauri desktop, Claude Channel UI, visual styling). **Keep this document up to date** — when adding features that involve drag-and-drop, platform-specific behavior, real-time timing, or visual appearance that automated tests can't cover, add them to the manual test plan. When adding automated test coverage for a previously-manual item, remove it from the manual plan and note it in the "Automated Coverage Summary" section.

## Code Quality Gates

- **Always fix lint and type errors before finishing work.** Run `npx tsc --noEmit` and `npm run lint` before handing work back to the user. Both must pass with zero errors. Fix issues as you go rather than batching them up — if you introduce a lint or type error, fix it immediately.
- **Plugin tests** live in `plugins/*/src/*.test.ts` and are only run when explicitly targeted (`npx vitest run plugins/*/src/*.test.ts`) or via `npm run test:all-including-plugins`. They are NOT included in `npm test`.

## Git

- **NEVER create git commits unless the user explicitly asks.** Do not commit after completing work, do not commit as part of a workflow, do not commit "for convenience." Only run `git add` or `git commit` when the user says words like "commit this" or "make a commit." This is a strict, non-negotiable rule.

## Ticket-Driven Work

When the user gives you work directly via the CLI (not via MCP channel or Hot Sheet events), analyze the request and create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work. This keeps work visible, trackable, and consistent with the Hot Sheet workflow.

- **Do create tickets** for: feature implementation, bug fixes, refactoring, multi-step tasks, anything that involves changing code.
- **Don't create tickets** for: simple questions, git commits, quick lookups, trivial one-line changes.
- **When in doubt, create the tickets.** The overhead is minimal and the tracking value is high.
- Use the Hot Sheet API to create tickets, mark them as Up Next, then work through them normally (set status to "started", implement, set to "completed" with notes).
- **Always create follow-up tickets** for work that isn't completed in the current session: unfinished implementation steps, open design questions needing answers, known gaps discovered during work, features designed but not yet built (e.g., a requirements doc without implementation). Never leave follow-up work undocumented — if it's not in a ticket, it will be forgotten.

## Conventions

- ESM modules (`"type": "module"` in package.json)
- Import paths use `.js` extension (TypeScript convention for ESM)
- No ORM — raw SQL queries via PGLite's `query()` method
- Ticket numbers use `HS-` prefix (e.g. `HS-1`, `HS-42`)
- Hono context variables typed via `AppEnv` in `src/types.ts`
- Server-rendered HTML for initial page load; client JS for interactivity
- Client CSS and JS are built separately and served as static files
- **`CHANNEL_VERSION`** in `src/channel.ts` AND `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts` — bump both integers (they must match) when changing the channel server's capabilities (new endpoints, protocol changes, new MCP features). The main server compares the running server's version against the expected version and warns the user to reconnect via `/mcp` in Claude Code if they don't match. Always increment both when modifying `src/channel.ts` in ways that affect the HTTP API or MCP behavior.

### Tauri-unsafe browser APIs (client code)

The app ships in Tauri's WKWebView, which silently no-ops several standard browser dialog/navigation APIs. Calls appear to "do nothing" in the desktop build — and because Playwright runs in Chromium where these APIs work natively, tests can pass while the real app is broken. **Never use these in client code (`src/client/**`, `plugins/*/src/**`).** Use the in-app equivalents instead:

- `window.confirm(...)` → `confirmDialog({message, ...})` from `src/client/confirm.tsx`. Returns `Promise<boolean>`. Supports `title`, `confirmLabel`, `cancelLabel`, `danger`.
- `window.alert(...)` → render an in-app toast / overlay. There is no generic alert helper yet — build the UI inline, or extend `confirm.tsx` with a one-button variant.
- `window.prompt(...)` → build an in-app input overlay (pattern: see `openEditor` in `terminalsSettings.tsx`).
- `window.open(url, ...)` in Tauri → use `invoke('open_external_url', { url })` via `getTauriInvoke()` from `src/client/tauriIntegration.tsx`, and fall back to `window.open` only when `getTauriInvoke()` returns null.
- File downloads via `<a download>` — unreliable; prefer a Tauri `save_file`-style command when running in Tauri.

**When writing e2e tests for any prompt flow**, click the in-app overlay's buttons. Do **not** rely on Playwright's `page.on('dialog')` handler — that masks the exact Tauri-silent-no-op regression class this rule exists to catch. If an e2e test finds itself registering a native dialog handler for client code, that client code is the bug.

### Requirements Documentation

The `docs/` folder contains numbered requirements documents that describe the application's features and behavior. These are the source of truth for what the app does and should do.

- **Keep docs up to date** — when implementing a feature, fixing a bug, or changing behavior, update the relevant requirements document to reflect the change. If a requirement is added, removed, or modified in code, the corresponding doc must be updated in the same change.
- **Create new documents** — when a new major functional area is added that doesn't fit naturally into an existing document, create a new numbered document following the naming convention (`N-area-name.md`). Renumber subsequent files if needed to maintain a logical reading order.
- **Reading order** — documents are numbered for linear reading, from high-level overview to specific subsystems:
  1. `1-overview.md` — Tech stack, architecture, non-functional requirements
  2. `2-data-storage.md` — Database, settings, lock file, gitignore
  3. `3-ticket-management.md` — Core domain model, CRUD, statuses, batch ops
  4. `4-user-interface.md` — Views, layouts, detail panel, keyboard shortcuts
  5. `5-attachments.md` — File upload, serving, reveal in finder
  6. `6-markdown-sync.md` — Worklist export, AI tool skill generation
  7. `7-backup-restore.md` — Auto-backup, preview, restore
  8. `8-cli-server.md` — CLI args, startup, demo mode
  9. `9-api.md` — REST API endpoint reference
  10. `10-desktop-app.md` — Tauri wrapper, updater, CLI installer
  12. `12-claude-channel.md` — Claude Channel integration, play button, auto mode
  13. `13-app-icon.md` — Dynamic app icon variants, settings UI, cross-platform switching
  14. `14-commands-log.md` — Log viewer for Claude channel + shell command history
  15. `15-shell-commands.md` — Shell command targets for custom commands, execution API
  16. `16-command-groups.md` — Custom command groups, collapsible sidebar, outline settings editor
  17. `17-share.md` — Share prompt, toolbar button, timing criteria
  18. `18-plugins.md` — Plugin system, sync engine, UI extensions, conflict resolution
  19. `19-demo-plugin.md` — Demo plugin: exercises all plugin features (settings types, UI locations, labels, validation)
  20. `20-secure-storage.md` — Keychain integration for plugin secrets with file/DB fallback
  21. `21-feedback.md` — Feedback needed notes, dialog, auto-select, channel notification, tab indicator
  22. `22-terminal.md` — Embedded terminal in footer drawer (per-project PTY, tabs alongside Commands Log)
  23. `23-terminal-titles-and-bell.md` — Title-change escape sequences + bell-character indicator on terminal tabs
- `docs/tauri-architecture.md` — Tauri v2 sidecar model, launch flows, CLI launchers, build pipeline, CI/CD signing
- `docs/tauri-setup.md` — Tauri build prerequisites, updater signing keys, macOS code signing, release workflow
- `docs/plugin-development-guide.md` — AI-focused guide for building plugins (ticketing backends and non-ticketing plugins). **Keep this guide up to date** whenever the plugin system changes — new interfaces, new manifest fields, new PluginContext methods, new UI extension points, or changes to the sync engine behavior. An AI reading this guide should be able to build a working plugin without looking at the source code.
- **Section numbering** — each document uses `N.X` section numbers matching its file number (e.g., `3-ticket-management.md` uses §3.1, §3.2, etc.)
- **Cross-references** — use relative markdown links between docs (e.g., `[3-ticket-management.md](3-ticket-management.md) §3.7`)

### AI Summaries (`docs/ai/`)

Two synthesis docs live under `docs/ai/` — read them at the start of a fresh session to orient quickly without opening every file. **These are maintained docs, not scratchpads** — keep them in sync with reality.

- `docs/ai/code-summary.md` — codebase map (directory tree, API routes, DB schema, client bundle, plugin system, channel/Tauri, build, tests, settings, a "where do I look for X" reverse index).
- `docs/ai/requirements-summary.md` — synthesized view of every requirements doc with per-entry status markers (Shipped / Partial / Design only / Deferred) and an at-a-glance implementation dashboard.

**Update `docs/ai/code-summary.md` in the same change whenever** you: (1) add a file or subdirectory under `src/`, (2) add a route file or endpoint, (3) change the DB schema (`CREATE TABLE` / `ALTER TABLE` in `src/db/connection.ts`), (4) add a new command-log event type or channel endpoint (remember to bump `CHANNEL_VERSION` + `EXPECTED_CHANNEL_VERSION`), (5) add a client module under `src/client/`, (6) add a tsup bundle output, (7) add/change a plugin UI location, preference type, or `TicketingBackend` method, (8) add a Tauri `#[tauri::command]`, (9) add a new `.hotsheet/` or `~/.hotsheet/` file, (10) add a user- or plugin-facing setting key. See §17 of the code summary for the full trigger list.

**Update `docs/ai/requirements-summary.md` in the same change whenever** you: (1) add a new requirements doc under `docs/` (also add it to the Reading order above), (2) ship a Design-only feature or defer/regress a Shipped one (update both the entry and the dashboard in §14), (3) supersede or rename a doc, (4) add a significant new sub-phase or feature to an existing doc. See §15 of the requirements summary for the full trigger list.

Prefer small, targeted edits to either file over rewrites — they only earn their keep if they stay approachable. If the AI summary ever conflicts with the source doc or code, treat the source as authoritative and update the summary.

### Code Organization

- **One primary export per file** — each file should have one main exported function/concept, with supporting private (non-exported) functions as needed
- **Files should not be excessively long** — break up large files by concern into smaller, focused modules
- **Use sub-folders for specialization** — group related modules under descriptive directories (e.g., `sidebar/`, `diff/`, `annotations/`, `review/`)
- **SCSS uses partials** — split into `_partial.scss` files by concern, imported from a single entry point
- **Use TSX/SafeHtml for HTML building** — client-side code that builds HTML strings should use the JSX runtime (`.tsx` files) rather than manual string concatenation. Use `raw()` for pre-rendered HTML strings in JSX
- **Use `toElement()` instead of `document.createElement()`** — when creating DOM elements in client code, use the `toElement()` helper from `dom.ts` with JSX: `toElement(<div className="foo">bar</div>)`. Resolve JSX to DOM elements only at the last moment. Never use `document.createElement()` directly
