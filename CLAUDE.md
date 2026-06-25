# Hot Sheet

## Project Overview

A lightweight, locally-running project management tool for developers. Launched from the CLI, it opens a browser-based UI where users create, categorize, and prioritize tickets with a fast bullet-list interface. Markdown worklists are automatically synced to `.hotsheet/` for consumption by AI tools like Claude Code.

## Tech Stack

- **Runtime**: Node.js 20+ · **Language**: TypeScript (strict mode)
- **Server**: Hono framework with `@hono/node-server`
- **Database**: PGLite (embedded PostgreSQL), raw SQL (no ORM) — data in `.hotsheet/`
- **Rendering**: Custom JSX runtime (no React) — produces HTML strings via `SafeHtml`, shared by server and client
- **Build**: tsup (server CLI + client JS) + sass (SCSS → CSS) · **Dev**: tsx (client assets pre-built)

## Architecture

Single-entry CLI (`src/cli.ts`) that: (1) creates `.hotsheet/`, (2) initializes PGLite + runs schema migrations, (3) starts a Hono HTTP server on port 4174, (4) syncs markdown worklists, (5) runs cleanup for old trash/completed items.

### Key Files

- `src/cli.ts` — CLI entry point, arg parsing
- `src/server.ts` — Hono app setup, static file serving
- `src/routes/api.ts` — JSON API (tickets CRUD, batch ops, attachments, settings)
- `src/routes/pages.tsx` — Server-rendered HTML page · `src/components/layout.tsx` — layout shell
- `src/db/connection.ts` — PGLite setup + schema init · `src/db/queries.ts` — all DB operations
- `src/sync/markdown.ts` — syncs worklist.md and open-tickets.md on ticket changes
- `src/cleanup.ts` — auto-cleanup of old trash/completed tickets + orphaned attachments
- `src/gitignore.ts` — ensures `.hotsheet/` is gitignored
- `src/jsx-runtime.ts` — custom JSX runtime (shared by server + client)
- `src/types.ts` — shared types (Ticket, TicketCategory, TicketPriority, AppEnv)

**Client** (`src/client/`): `app.ts` (entry, binds UI), `state.ts` (shared state/settings), `dom.ts` (`toElement()` JSX→DOM), `api.tsx` (API helper, upload, network error popup), `ticketList.tsx` (list rendering), `dropdown.tsx` (context menus), `detail.tsx` (detail panel), `styles.scss` (all styles).

### JSX Runtime

Custom JSX runtime (`src/jsx-runtime.ts`) instead of React — renders JSX to HTML strings via `SafeHtml`, shared server + client. Configured via `tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "#jsx"`), the `package.json` imports map (`#jsx/jsx-runtime`), and a `tsup.config.ts` esbuild alias.

TSX components return `SafeHtml` (= `JSX.Element`). Use `raw()` to inject pre-escaped HTML; all string children are auto-escaped. In client code, convert to DOM with `toElement()`, or to string for `innerHTML` with `.toString()`.

### Database

Tables: `tickets` (title, details, category, priority, status, up_next), `attachments` (linked to tickets), `settings` (key-value config).

### Ticket Types

`issue`, `bug`, `feature`, `requirement_change`, `task`, `investigation`.

### Markdown Sync

Ticket changes trigger debounced syncs of `worklist.md` ("Up Next" tickets by priority, for AI tools) and `open-tickets.md` (all open tickets grouped by status).

## Build

```bash
npm run build          # tsup -> dist/cli.js + dist/client/app.js + dist/client/styles.css
npm run build:client   # client assets only (JS + CSS) into dist/client/
npm run dev            # build client assets, then run via tsx
```

Produces `dist/cli.js` (server ESM bundle w/ Node shebang; `@electric-sql/pglite`, `hono`, `@hono/node-server` kept external), `dist/client/app.js` (IIFE, minified, es2020), `dist/client/styles.css` (compiled + compressed from SCSS).

## Testing

```bash
npm test              # unit tests with coverage (vitest)
npm run test:watch    # unit tests in watch mode
npm run test:e2e      # E2E browser tests (Playwright)
npm run test:fast     # unit + fast E2E (skips GitHub plugin / live integration)
npm run test:e2e:fast # E2E only, skipping GitHub plugin / live integration
npm run test:e2e:docker # E2E in the CI Linux/Chromium container (needs Docker). Forwards args: -- e2e/foo.spec.ts
npm run test:all      # unified coverage: unit + E2E server + E2E browser, merged
npm run test:all-including-plugins  # test:all + plugin tests in coverage
npm run test:rust     # Rust unit tests for the Tauri crate (cargo test, src-tauri/) — needs the Rust toolchain
```

`npm test` (vitest) does NOT run the Rust tests — run `npm run test:rust` for `src-tauri/` (`#[cfg(test)]` modules in `src/lib.rs`, e.g. the per-platform TTS command construction). Platform-specific Rust (`#[cfg(target_os)]` branches) should be refactored to pure, platform-parameterized functions so every OS branch is testable on any host (see `build_tts_command` / `build_kill_command`).

`test:fast` / `test:e2e:fast` exclude tests needing GitHub API credentials (plugin sync, live integration) — these run in CI by default. The full `test:e2e` suite (live GitHub integration) runs locally only when credentials are configured.

## Code Quality Gates

- **Always fix lint and type errors before finishing.** Run `npx tsc --noEmit` and `npm run lint` — both must pass with zero errors. Fix as you go, don't batch.
- **Plugin tests** (`plugins/*/src/*.test.ts`) run only when explicitly targeted (`npx vitest run plugins/*/src/*.test.ts`) or via `npm run test:all-including-plugins`. NOT in `npm test`.

## Git

- **Commit as needed — no need to ask first.** Commit your own work whenever it reaches a sensible checkpoint (a completed ticket, a green build) with a clear message; you don't need to ask permission to commit. Prefer logically-scoped commits over one giant catch-all. Don't sweep unrelated pending changes into a commit; commit only what your task touched.
- **NEVER `git push` without the user's explicit permission.** Local commits are fine; publishing them is not — wait for an explicit "push" instruction. Strict, non-negotiable.
- **Drafting commit messages / release notes — use [gitgist](https://github.com/brianwestphal/gitgist)** (a devDependency; invoke via `npx gitgist`). For a commit message from staged work: `npx gitgist --staged --commit-message`. For release notes over a range: `npx gitgist <last_tag>..HEAD`. `release.sh` (`step_release_notes`) already uses it for the changelog/tag body. Note: gitgist's default `--provider auto` shells out to the signed-in `claude` CLI — a nested `claude` call — so when *you* are running inside a Claude session, prefer drafting the message/notes yourself (gitgist is the canonical tool for the user's own runs and for CI with `$ANTHROPIC_API_KEY`).

## Conventions

- ESM modules (`"type": "module"`); import paths use `.js` extension (TS ESM convention).
- No ORM — raw SQL via PGLite's `query()`.
- Ticket numbers use `HS-` prefix (e.g. `HS-1`). Hono context vars typed via `AppEnv` in `src/types.ts`.
- Server-rendered HTML for initial load; client JS for interactivity. Client CSS/JS built separately, served static.
- **`CHANNEL_VERSION`** (`src/channel.ts`) AND **`EXPECTED_CHANNEL_VERSION`** (`src/channel-config.ts`) — bump both integers together (they must match) whenever changing the channel server's HTTP API / MCP behavior (new endpoints, protocol changes, new MCP features). The main server warns the user to reconnect via `/mcp` on mismatch.

### Code search (prefer ast-grep for structure)

For **structural / syntax-aware** searches over source (`.ts` / `.tsx` / `.rs`), use **ast-grep** (the `ast-grep` skill, or the CLI: `ast-grep run --lang <ts|tsx|rust> -p '<pattern>' <path>`) rather than text grep — it matches the AST, so it skips comments/strings and catches multi-line/nested shapes. This is the same mindset as the project's AST-based `no-restricted-syntax` eslint rules (§ Type assertions / § Code Organization). Good fits here: `$A as $B` casts, `JSON.parse($X) as $T`, `innerHTML =`, `document.createElement`, inline `api<{…}>()` literals, Tauri-unsafe `window.confirm/open/prompt`, `process.platform` / `#[cfg(target_os)]` branches, specific call/JSX shapes, and codemod-style rewrites. **`--lang` matters: `tsx` ≠ `ts` ≠ `rust`** — pick per file extension.

Keep **text search** (ripgrep / the editor's grep / the Explore agent) for what it's best at: literal strings (e.g. `FEEDBACK NEEDED`), identifier/symbol lookups, **filenames**, and **non-code files** (markdown / JSON / logs) — there AST has nothing to match and text is simpler + faster.

### Ticket numbers in prose

Tickets are local to the maintainer's machine — `HS-NNNN` only resolves against the local `.hotsheet/` DB, which lives outside the repo. This rule applies to prose stored **outside** the DB (orientation doc, `docs/**`, code comments, commit messages, `docs/ai/**`); it does NOT apply to prose stored inside Hot Sheet (ticket details/notes/completion notes — readers there can click through).

For out-of-DB prose:
- **Never tell a reader to look in `.hotsheet/`** — it's local-only.
- **Mentioning a number is fine, but always pair it with a short self-contained summary** of what a fresh reader needs. ✅ `HS-8380 — client search filter mirrors the server's five-column ILIKE`; ❌ `Per HS-8380`.
- Add the summary opportunistically when editing prose with a bare number.

### Spelling and grammar (American English)

All prose for this project (comments, commit messages, completion notes, docs, AI summaries, user-visible strings) uses **American English**, in new writing AND existing text you edit. Common British→American swaps: `-ise/-isation`→`-ize/-ization` (optimise, organise, recognise, analyse, synchronise, customise, prioritise, standardise, emphasise, centralise), `behaviour`→`behavior`, `colour`→`color`, `practise`(v)→`practice`, `licence`(n)→`license`, `defence`→`defense`, `grey`→`gray`, `labelled/modelled/travelled`→single-l, `cancelled`→`canceled` (preferred), `whilst`→`while`, `amongst`→`among`. Fix opportunistically when editing a file for another reason — there's a dedicated sweep ticket for a full pass.

### Tauri-unsafe browser APIs (client code)

The app ships in Tauri's WKWebView, which silently no-ops several standard dialog/navigation APIs (they appear to "do nothing" in the desktop build). Playwright runs in Chromium where these work natively, so tests can pass while the real app is broken. **Never use these in client code (`src/client/**`, `plugins/*/src/**`)** — use the in-app equivalents:

- `window.confirm(...)` → `confirmDialog({message, ...})` from `src/client/confirm.tsx` (returns `Promise<boolean>`; supports `title`, `confirmLabel`, `cancelLabel`, `danger`).
- `window.alert(...)` → in-app toast/overlay (no generic helper yet — build inline or extend `confirm.tsx`).
- `window.prompt(...)` → in-app input overlay (pattern: `openEditor` in `terminalsSettings.tsx`).
- `window.open(url, ...)` → `invoke('open_external_url', { url })` via `getTauriInvoke()` from `src/client/tauriIntegration.tsx`; fall back to `window.open` only when `getTauriInvoke()` is null.
- File downloads via `<a download>` — unreliable; prefer a Tauri `save_file`-style command in Tauri.

**E2E tests for any prompt flow** must click the in-app overlay's buttons. Do NOT use Playwright's `page.on('dialog')` handler — it masks the exact Tauri-silent-no-op regression class this rule exists to catch.

### Type assertions (`as`) and runtime validation

The `as` operator is an unchecked assertion — the compiler trusts it and forgets to check at runtime, so an upstream shape change ships a runtime crash while everything still compiles (HS-8567).

**Default to NOT writing `as`.** Prefer, in order:
1. **`instanceof` / type predicate** for element/class identity (`if (el instanceof HTMLButtonElement)`).
2. **zod** when the value crosses a trust boundary (wire, file, DB JSON column). Schemas: `src/schemas.ts` (cross-cutting) or `src/routes/validation.ts` (server-only HTTP bodies). Use `parseJson(Schema, raw)` / `parseJsonOrNull(Schema, raw)` to replace `JSON.parse(x) as Foo`.
3. **`schema` param** on `api<T>(path, { schema })` / `apiWithSecret` / `apiUpload` for response validation (new code SHOULD pass one).
4. **Raw `fetch`**: `const raw: unknown = await res.json()` then `MySchema.safeParse(raw)`.

When you genuinely need `as`, require an **adjacent runtime check or comment** justifying it — the reader should verify the invariant without leaving the screen.

The `no-restricted-syntax` ESLint rule flags the three highest-risk patterns: `JSON.parse(x) as Y`, `res.json() as Y`, `await res.json() as Y` (`as unknown` is allowed — intentional erasure before a downstream check). NOT flagged but still subject to the preference: `as HTMLXxxElement` after `closest()`/`querySelector()`, `as Record<string, unknown>` (opportunistic migration welcome, not required). Pure type-level forms (`as const`, `as keyof X`) have no runtime concern.

**DB JSON column reads** — every `JSON.parse(row.someJsonColumn)` goes through a zod schema. Existing: `NotesArraySchema` (`tickets.notes`), `TagsArraySchema` (`tickets.tags`), `CategoryDefArraySchema` (`settings.categories`), `SnapshotDataSchema` (`daily_stats.data`), `PluginConflictDataSchema` (`sync_records.conflict_data`). Add new ones to `src/schemas.ts` with new JSON columns.

### Typed API layer (`src/api/`)

Each HTTP endpoint's wire shape (request + response) is defined ONCE as zod schemas in `src/api/<resource>.ts`, shared by client callers and server handlers — single source of truth. Each module exports schemas (+ inferred types) AND typed caller functions (e.g. `getGitStatus()`); `src/api/index.ts` aggregates them. `src/api/_runner.ts` is **server-safe** (imports only `zod`; fetch is done by a client-injected transport via `setApiTransport`/`setApiUploadTransport` at boot) and **must never import client-only DOM-touching modules**.

Migration is complete: every client call site goes through a typed caller; the raw `api()` / `apiWithSecret()` / `apiUpload()` helpers are now ONLY the transport target wired in `app.tsx`. **When adding an endpoint:** define request + response schema + typed caller in `src/api/<resource>.ts`, validate the request server-side against it, call the typed function from the client. Do NOT add inline `api<{…}>(path)` literals or call the raw helpers directly. **git** is the reference implementation. See `docs/9-api.md` §9.0.3.

### Requirements Documentation

The `docs/` folder holds numbered requirements documents — the source of truth for what the app does. **Keep them up to date** in the same change as the code (add/remove/modify a requirement → update its doc). **Create new docs** for major new functional areas (`N-area-name.md`), renumbering as needed. Each doc uses `N.X` section numbers; cross-reference with relative markdown links (e.g. `[3-ticket-management.md](3-ticket-management.md) §3.7`).

Reading order (high-level → specific) — full synthesized detail lives in `docs/ai/requirements-summary.md`:

1. `1-overview.md` — tech stack, architecture, non-functional requirements
2. `2-data-storage.md` — database, settings, lock file, gitignore
3. `3-ticket-management.md` — domain model, CRUD, statuses, batch ops
4. `4-user-interface.md` — views, layouts, detail panel, keyboard shortcuts
5. `5-attachments.md` — file upload, serving, reveal in finder
6. `6-markdown-sync.md` — worklist export, AI tool skill generation
7. `7-backup-restore.md` — auto-backup, preview, restore
8. `8-cli-server.md` — CLI args, startup, demo mode
9. `9-api.md` — REST API endpoint reference
10. `10-desktop-app.md` — Tauri wrapper, updater, CLI installer
12. `12-claude-channel.md` — Claude Channel integration, play button, auto mode
13. `13-app-icon.md` — REMOVED (HS-9011): dynamic app icon variants feature dropped; tombstone kept to avoid renumbering
14. `14-commands-log.md` — log viewer for channel + shell command history
15. `15-shell-commands.md` — shell command targets, execution API
16. `16-command-groups.md` — custom command groups, collapsible sidebar
17. `17-share.md` — share prompt, toolbar button, timing criteria
18. `18-plugins.md` — plugin system, sync engine, UI extensions, conflict resolution
19. `19-demo-plugin.md` — demo plugin exercising all plugin features
20. `20-secure-storage.md` — keychain integration for plugin secrets
21. `21-feedback.md` — feedback-needed notes, dialog, channel notification, tab indicator
22. `22-terminal.md` — embedded terminal in footer drawer (per-project PTY, tabs)
23. `23-terminal-titles-and-bell.md` — title-change escape sequences + bell indicator
24. `24-cross-project-bell.md` — cross-project bell surfacing
25. `25-terminal-dashboard.md` — full-window grid of every terminal, zoom/dedicated view
26. `26-shell-integration-osc133.md` — OSC 133 protocol design spike
27. `27-osc9-desktop-notifications.md` — OSC 9 shell-initiated toast messages
28. `28-osc8-hyperlinks.md` — OSC 8 clickable hyperlinks (Tauri-safe routing)
29. `29-osc7-cwd-tracking.md` — OSC 7 shell CWD tracking chip
30. `30-osc9-native-notifications.md` — OSC 9 native OS notifications (Tauri)
31. `31-osc133-copy-last-output.md` — copy-last-output toolbar button
32. `32-osc133-jump-and-popover.md` — jump shortcuts + hover popover
33. `33-osc133-ask-claude.md` — Ask Claude popover button → channel
34. `34-terminal-search.md` — terminal find widget
35. `35-terminal-themes.md` — terminal theme + font registry, per-terminal override
36. `36-drawer-terminal-grid.md` — per-project tile grid inside the drawer
37. `37-quit-confirm.md` — quit confirmation when terminals are running
38. `38-terminal-visibility.md` — persisted terminal visibility
39. `39-visibility-groupings.md` — named visibility configurations per project
40. `40-search-include-rows.md` — search "include archive + backlog" rows
41. `41-backup-json-cosave.md` — versioned JSON co-save next to each backup tarball
42. `42-repair-database.md` — Settings → Backups database repair (find backup, pg_resetwal)
43. `43-attachment-backups.md` — hash-addressed centralized attachment store + manifests
44. `44-wasm-pg-resetwal.md` — WASM pg_resetwal design spike (verdict: defer)
45. `45-pglite-robustness.md` — cleaner-shutdown design (`gracefulShutdown` helper)
46. `46-service-client-decoupling.md` — service/client decoupling design spike (WebSocket push)
47. `47-richer-permission-overlay.md` — permission popup diff preview + per-project allow-list
48. `48-git-status-tracker.md` — sidebar chip: branch + dirty count + ahead/behind
49. `49-reader-mode.md` — reader-mode overlay for notes + Details
50. `50-upgrade-nudge.md` — throttled npm→Tauri upgrade nudge overlay
51. `51-shell-history.md` — per-(project, terminal) shell history scoping
53. `53-streaming-shell-output.md` — streaming shell-command output buffer + UI
54. `54-terminal-checkout.md` — global terminal checkout / xterm stack
55. `55-ticket-cross-references.md` — clickable `HS-NNNN` refs → stacking modal
56. `56-magnified-grid-nav.md` — Shift+Cmd/Ctrl+Arrow magnified-tile navigation
57. `57-shell-command-button-spinner.md` — running shell-command button spinner + stop
59. `59-reader-note-navigation.md` — reader-mode prev/next note navigation
60. `60-reactivity-primitive.md` — fine-grained reactivity primitive (`kerfjs`)
61. `61-composable-stores.md` — composable testable stores (`defineStore`)
62. `62-unified-jsx-render-targets.md` — shared AST: `astToHtml` (server) + `astToDom` (client)
63. `63-mcp-tools.md` — MCP tool surface for AI agents (`tools/list` + `tools/call`)
64. `64-claude-allow-rule.md` — auto-allow MCP tools in `.claude/settings.local.json`
65. `65-read-latest-note-menu.md` — "Read Latest Note" context-menu item
66. `66-move-to-open-menu.md` — "Move to Open" context-menu item (backlog→open)
67. `67-telemetry.md` — Claude Code OpenTelemetry integration (opt-in, OTLP routes, cost UIs)
68. `68-telemetry-traces.md` — beta enhanced tracing + span-tree + waterfall
69. `69-telemetry-dashboard.md` — cross-project dashboard (superseded by §70 + §71)
70. `70-cross-project-stats.md` — header-bar cross-project stats page
71. `71-analytics-dashboard-telemetry.md` — per-project "Claude usage" dashboard sections
72. `72-snapshot-persistence.md` — memory-primary snapshot design spike (memory-primary track dropped; §73 chosen)
73. `73-snapshot-protection.md` — NodeFS live + atomic snapshot + auto-restore (shipped)
74. `74-clear-telemetry-data.md` — manual "Clear telemetry data" button + confirm
75. `75-background-work-scheduler.md` — load resilience: off-loop execution + central scheduler
76. `76-cross-project-ticket-drag.md` — drag tickets onto project tabs / "+" to copy (or Option-move) across projects
77. `77-paste-attachments.md` — paste files/images from the clipboard to create attachments
78. `78-announcer.md` — A/V narration of project work (Phase 1a server generation backbone shipped; client + later phases pending)
79. `79-api-keys.md` — global API-key registry (named Anthropic/Google-TTS keys; projects select by name)
80. `80-announcer-live-mode.md` — Announcer live mode (server generator loop, coalescing, off-unless-listening lease; Phase 2a shipped)
81. `81-announcer-local-provider.md` — Announcer local (Ollama / OpenAI-compatible) summarization provider — cross-platform on-device/free, model-detection dropdown
82. `82-announcer-mid-task-narration.md` — Announcer live mid-task narration off the §67 telemetry stream + AI importance rating/exclusion (15s debounce)
83. `83-command-button-long-press.md` — long-press a command button for a secondary action (shell → run in new terminal, shipped; Claude → make a ticket, designed)
84. `84-command-last-run.md` — hover a custom command button to see its last-run time (per-device, localStorage)
85. `85-telemetry-retention-bounding.md` — periodic 24h telemetry sweep + per-table windows (spans 7d) + ~500k span row cap (design; implementation in follow-ups)
86. `86-ai-assistant-setup.md` — recommended AI-assistant instruction sections in CLAUDE.md (versioned managed-section markers + self-healing per-project specifics; once-per-project nudge + Settings button)
87. `87-test-instance.md` — isolated test instance (`HOTSHEET_HOME` + `globalHotsheetDir()` + `--test` launcher + TEST badge shipped; keychain namespacing deferred)
88. `88-scheduled-sync.md` — scheduled periodic plugin auto-sync (per-project interval, incremental + ~hourly full reconcile; GitHub default 15 min)
89. `89-git-worktrees.md` — git worktrees + per-worktree AI agents sharing one Hot Sheet via a follower `.hotsheet/settings.json` pointer (Phase A redirect + Phase B create/list/remove + UI + Phase C per-worktree AI terminal/agent-wiring shipped; Phase D **designed** in §90 — durable worker pool + dynamic scaling, single-machine first — implementation gated on HS-8862/8863/8864/8865 + HS-8960/8961)
90. `90-distributed-execution.md` — distributed ticket execution design: claim/lease primitive (orthogonal `claimed_by`/lease columns, atomic `claim-next` via SKIP LOCKED, MCP tools), both coordination models (self-claim + dispatch), flat `blocked_by` gate, durable worker pool — the claim model worktree Phase D (§89) consumes (design only)
91. `91-worker-pool-scaling.md` — worker-pool dynamic scaling design: durable worktree worker slots, scale up / graceful drain (never kill mid-ticket), worker-pool panel (extends HS-8938), AI-suggested N (design only, gated on HS-8862/8863)
92. `92-coordinator-dispatch.md` — coordinator-dispatch UX design: owner drags Up Next tickets onto a worker tile (mirrors §76) or a "Dispatch to…" menu → claim-by-id on the worker's behalf; coexists with self-claim via the live lease; optional AI partition-into-chunks (design only, gated on HS-8862/8960/8864)
93. `93-websocket-push-sync.md` — WebSocket push (`/ws/sync`) design implementing §46.3: server event bus + ring/seq, `?since` catch-up + `resync`, heartbeat, client reducer + exponential-backoff reconnect + auto-fallback to `/api/poll` (additive — long-poll stays). Shipped end-to-end (HS-8978–8982); decomposed + gated on HS-7940
94. `94-strong-remote-auth.md` — strong remote-auth security architecture (HS-8985): threat model + **mTLS** (the TLS handshake IS the challenge-response — don't hand-roll crypto) + per-device client certs + per-project CA + ACLs. **Decided (2026-06-24):** in-process Node TLS, self-hosted scope; **localhost stays shared-secret, mTLS only when exposed**; `.p12` import + QR enrollment. Decomposed into HS-8992–8997 (CA → listener → enrollment → authz/revocation → QR → sign-off); design only, ready to schedule
95. `95-settings-sharing-classification.md` — per-setting sharing classification (personal/Local vs team/Shared vs machine/Global) + element-level per-layer editing for the complex editors (HS-9005, follow-up to the HS-9004 scope control). Maintainer-specified rules: categories shared-only; views/commands/terminals = hide-individual + add-local; auto-context = disable/override/add-local (no order override); allow-rules + Announcer = local-only. **Standing rule: complex/ambiguous settings are case-by-case — ask the maintainer, don't guess.** Design only — open classification decisions in §95.4
96. `96-request-hardening.md` — front-line input hardening before auth/handlers (auth-independent): per-route-class body-size caps (`requestGuards`), per-field schema bounds (`limits.ts`), exposed-only rate limit, the HS-8998 chunked-body 411 gap-close, and the OTLP per-request **row** cap (`OTLP_MAX_ROWS_PER_REQUEST`, `countOtlpRows` in `routes/otel.ts`). Shipped (HS-8986 / 8990 / 8998).
97. `97-self-hosting-mtls.md` — self-hosting deployment guide for exposing the server over mutual TLS (§94): the two tiers, `--bind` exposure, mint/install a client `.p12`, revoke a device, reverse-proxy + tunnel caveats. The operator-facing companion to §94.

Other docs: `docs/tauri-architecture.md` (Tauri v2 sidecar, launch/build/CI signing), `docs/tauri-setup.md` (build prereqs, signing keys, release workflow), `docs/dependency-security.md` (npm + cargo audit posture, Dependabot, triage), `docs/plugin-development-guide.md` (AI-focused plugin-building guide — **keep up to date** whenever the plugin system changes, so an AI can build a working plugin without reading source), `docs/demo-plan.md` (story-driven demo script for showing Hot Sheet + Glassbox to potential users).

### AI Summaries (`docs/ai/`)

Two synthesis docs to read at the start of a fresh session. **Maintained docs, not scratchpads** — keep in sync with reality (source doc/code wins on conflict). Prefer small targeted edits over rewrites.

- `docs/ai/code-summary.md` — codebase map (directory tree, API routes, DB schema, client bundle, plugins, channel/Tauri, build, tests, settings, "where do I look for X" index). **Update in the same change** when you: add a file/subdir under `src/`, add a route/endpoint, change the DB schema, add a command-log event type or channel endpoint (bump both channel versions), add a client module, add a tsup output, add/change a plugin UI location/preference type/`TicketingBackend` method, add a Tauri `#[tauri::command]`, add a `.hotsheet/` or `~/.hotsheet/` file, or add a setting key. See its §17 for the full trigger list.
- `docs/ai/requirements-summary.md` — synthesized view of every requirements doc with status markers (Shipped / Partial / Design only / Deferred) + dashboard. **Update in the same change** when you: add a requirements doc (also add to the Reading order above), ship a Design-only feature or defer/regress a Shipped one, supersede/rename a doc, or add a significant sub-phase. See its §15 for the full trigger list.

### Code Organization

- **One primary export per file**, with supporting private functions as needed. Break up excessively long files by concern. Use sub-folders for specialization (`sidebar/`, `diff/`, `review/`). SCSS uses `_partial.scss` files imported from one entry point.
- **Use TSX/SafeHtml for HTML building** (not string concatenation); `raw()` for pre-rendered HTML.
- **Use `toElement()` from `dom.ts`, never `document.createElement()`** — resolve JSX to DOM at the last moment. Intentional exceptions: `dom.ts::toElement` itself, `terminalCheckout.tsx` orphaned-xterm sink, `terminalFonts.ts` `<link>` injection, `terminalWebgl.ts` WebGL probe, `scrollbarPref.ts` scrollbar-width probe.
- **Don't write new `xxx.innerHTML = yyy` in client code** — `toElement` (routed through `kerfjs::toElement`, §62) handles SVG-namespace/entity/custom-attr correctness; raw `innerHTML` bypasses it. Use one of:
  1. **`morph(el, toElement(<jsx />))` / `morph(el, htmlString)`** (from `src/client/reactive.js`) — preferred for in-place updates where the user may be focused/scrolled/selecting. Reconciles the live tree, preserving focused inputs + selection, `[contenteditable]`, `<details/dialog open>`, and scroll. Honors `data-morph-skip`/`-skip-children`/`-preserve`. Needs listener delegation on `el` (per-element listeners can survive staleley — HS-8365).
  2. **`el.replaceChildren(toElement(<jsx />))`** — default when morph's preservation isn't relevant: wholly-different trees, lists with index-captured per-element listeners, or sites where the user can't be focused during rebuild.
  3. **`el.replaceChildren(toElement(<span>{raw(htmlString)}</span>))`** — escape hatch for raw-HTML (e.g. server-rendered markdown).

  The `no-restricted-syntax` ESLint rule (§62) flags new `innerHTML =` outside an allowlist in `eslint.config.mjs`. When you touch an allowlisted file, opportunistically migrate its `innerHTML` callsite and remove it from the allowlist. Test files are exempt.

<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

<!-- hotsheet:begin section=testing-philosophy v=1 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

- **Unit tests** (`src/**/*.test.ts`): vitest. Mock external deps (filesystem, network); use `setupTestDb`/`cleanupTestDb` from `test-helpers.ts` for DB tests.
- **E2E tests** (`e2e/*.spec.ts`): Playwright + Chromium against a real server with a temp data dir; minimize mocks.
- **Rust tests** (`src-tauri/`, `#[cfg(test)]` in `src/lib.rs`): `cargo test` — NOT run by `npm test`. Refactor `#[cfg(target_os)]` branches into pure, platform-parameterized functions so every OS branch is testable on any host.
- **Commands & full reference**: see [Testing](#testing) and [Code Quality Gates](#code-quality-gates) above — unit `npm test`, watch `npm run test:watch`, E2E `npm run test:e2e` (fast subset `test:e2e:fast`, Docker CI parity `test:e2e:docker`), merged coverage `npm run test:all` (with plugins `test:all-including-plugins`), Rust `npm run test:rust`. `test:fast`/`test:e2e:fast` skip GitHub-credentialed tests; plugin tests run only when targeted.
- **Quality gate**: `npx tsc --noEmit` and `npm run lint` must both pass with zero errors before finishing — fix as you go, don't batch.
- **Manual test plan**: `docs/manual-test-plan.md` for features that can't be reliably automated (drag-and-drop, Tauri desktop, Claude Channel UI, visual styling). Keep it current.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

- Requirements docs live in `docs/`, numbered `N-area-name.md` with `N.X` section numbers, cross-referenced via relative markdown links. The full reading order and per-doc summaries are in the **Requirements Documentation** subsection under [Conventions](#conventions) above; create new docs for major new functional areas (renumbering as needed).
- AI-summary files (read both at the start of a fresh session): `docs/ai/code-summary.md` (codebase map) and `docs/ai/requirements-summary.md` (status-marked synthesis — Shipped / Partial / Design only / Deferred). Both are maintained docs — update in the same change per their own trigger lists (`§17` and `§15` respectively).
- Other docs: `docs/tauri-architecture.md`, `docs/tauri-setup.md`, `docs/dependency-security.md`, `docs/plugin-development-guide.md`, `docs/demo-plan.md`.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
