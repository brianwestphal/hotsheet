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

## Conventions

- ESM modules (`"type": "module"` in package.json)
- Import paths use `.js` extension (TypeScript convention for ESM)
- No ORM — raw SQL queries via PGLite's `query()` method
- Ticket numbers use `HS-` prefix (e.g. `HS-1`, `HS-42`)
- Hono context variables typed via `AppEnv` in `src/types.ts`
- Server-rendered HTML for initial page load; client JS for interactivity
- Client CSS and JS are built separately and served as static files

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
- **Section numbering** — each document uses `N.X` section numbers matching its file number (e.g., `3-ticket-management.md` uses §3.1, §3.2, etc.)
- **Cross-references** — use relative markdown links between docs (e.g., `[3-ticket-management.md](3-ticket-management.md) §3.7`)

### Code Organization

- **One primary export per file** — each file should have one main exported function/concept, with supporting private (non-exported) functions as needed
- **Files should not be excessively long** — break up large files by concern into smaller, focused modules
- **Use sub-folders for specialization** — group related modules under descriptive directories (e.g., `sidebar/`, `diff/`, `annotations/`, `review/`)
- **SCSS uses partials** — split into `_partial.scss` files by concern, imported from a single entry point
- **Use TSX/SafeHtml for HTML building** — client-side code that builds HTML strings should use the JSX runtime (`.tsx` files) rather than manual string concatenation. Use `raw()` for pre-rendered HTML strings in JSX
- **Use `toElement()` instead of `document.createElement()`** — when creating DOM elements in client code, use the `toElement()` helper from `dom.ts` with JSX: `toElement(<div className="foo">bar</div>)`. Resolve JSX to DOM elements only at the last moment. Never use `document.createElement()` directly
