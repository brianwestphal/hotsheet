# 1. Overview & Non-Functional Requirements

## 1.1 Technology Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode, ESM modules)
- **Server**: Hono framework with `@hono/node-server`
- **Database**: PGLite (embedded PostgreSQL via WASM) — raw SQL, no ORM
- **Desktop**: Tauri v2 (Rust-based native wrapper)
- **Rendering**: Custom JSX runtime producing HTML strings (`SafeHtml` class), shared by server and client
- **Build**: tsup (server), esbuild (client IIFE bundle), sass (SCSS → CSS)
- **Dev**: tsx for direct TypeScript execution

## 1.2 Architecture

- **Server-rendered initial page**: The server returns a complete HTML page; client JS adds interactivity.
- **Single-page application**: After initial load, all interactions are handled client-side via API calls.
- **Custom JSX runtime**: No React dependency. JSX compiles to `SafeHtml` instances. Client-side DOM creation uses `toElement()` helper.
- **ESM throughout**: All imports use `.js` extensions per TypeScript ESM convention.

## 1.3 Data Locality

- All data stays on the local machine.
- No cloud services, external databases, or remote APIs (except npm registry for update checks and GitHub for desktop app updates).
- The `.hotsheet/` directory contains everything: database, attachments, backups, settings, lock file, and markdown exports.

## 1.4 Performance

- The application should start and be usable within a few seconds.
- Long-polling for live updates minimizes unnecessary network traffic.
- Input debouncing prevents excessive API calls during rapid typing.
- Scroll position preservation avoids jarring re-renders.
- Markdown sync is debounced (500ms / 5s) to batch rapid changes.

## 1.5 Security

- File paths are never interpolated into shell commands; `execFile` is used with argument arrays.
- SQL queries use parameterized values (no string interpolation).
- HTML output is auto-escaped by the JSX runtime; `raw()` is used only for pre-sanitized content.
- Desktop app updates are cryptographically signed and verified.
- No authentication — the server is local-only and trusts all connections from localhost.

## 1.6 Reliability

- Lock file prevents database corruption from concurrent access.
- Safety backup before restore prevents data loss.
- Stale lock files are automatically cleaned up.
- Soft-delete with configurable retention before permanent removal.
- Three-tier backup system with automatic rotation.

## 1.7 Portability

- Runs on macOS, Linux, and Windows.
- CLI installable via npm (or yarn, pnpm, bun).
- Desktop app distributed as native packages per platform.
- Port auto-selection handles conflicts gracefully.

## 1.8 Build & Distribution

- **npm package**: `hotsheet` — installs globally, provides `hotsheet` CLI command.
- **Desktop app**: Tauri-built native binaries with auto-update support.
- **Build outputs**:
  - `dist/cli.js` — Server ESM bundle (external deps kept external)
  - `dist/client/app.global.js` — Client IIFE bundle (minified, es2020)
  - `dist/client/styles.css` — Compiled SCSS (compressed, no source maps)

## 1.9 Conventions

- One primary export per file.
- Files should not be excessively long — break by concern.
- Use sub-folders for related modules.
- SCSS uses partials imported from a single entry point.
- TSX/SafeHtml for HTML building (not manual string concatenation).
- `toElement()` instead of `document.createElement()`.
- No ORM — raw SQL via PGLite's `query()` method.
