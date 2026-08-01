# Hot Sheet

## Project Overview

A lightweight, locally-running project management tool for developers. Launched from the CLI, it opens a browser-based UI where users create, categorize, and prioritize tickets with a fast bullet-list interface. Markdown worklists are automatically synced to `.hotsheet/` for consumption by AI tools like Claude Code.

## Tech Stack

- **Runtime**: Node.js 20+ · **Language**: TypeScript (strict mode)
- **Server**: Hono framework with `@hono/node-server`
- **Database**: PGLite (embedded PostgreSQL), raw SQL (no ORM) — data in `.hotsheet/`
- **Rendering**: kerf's JSX runtime (no React) — produces HTML strings via `SafeHtml`, shared by server and client
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
- (JSX comes straight from `kerfjs` — there is no local runtime module; see the JSX Runtime section)
- `src/types.ts` — shared types (Ticket, TicketCategory, TicketPriority, AppEnv)

**Client** (`src/client/`): `app.ts` (entry, binds UI), `state.ts` (shared state/settings), `dom.ts` (`toElement()` JSX→DOM), `api.tsx` (API helper, upload, network error popup), `ticketList.tsx` (list rendering), `dropdown.tsx` (context menus), `detail.tsx` (detail panel), `styles.scss` (all styles).

### JSX Runtime

**kerf's** JSX runtime instead of React — renders JSX to HTML strings via `SafeHtml`, shared server + client. Configured via `tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "kerfjs"`) plus the matching `esbuildOptions.jsxImportSource` in `tsup.config.ts` and `scripts/build-client.mjs`. Import `raw` / `SafeHtml` / `Fragment` / `isSafeHtml` from **`kerfjs`**; `jsx` / `jsxs` live on `kerfjs/jsx-runtime` (the compiler's entry).

History worth knowing: this used to be a hand-rolled `src/jsx-runtime.ts` (~230 lines incl. a camelCase→kebab SVG alias table). **HS-9450** replaced its body with a re-export of kerf's, and **HS-9454** deleted the file and the `#jsx` alias entirely. The swap bought kerf's XSS hardening (attribute-name validation, `on*` rejection, `javascript:`/`data:` URL screening) and real typed JSX intrinsics — the old `IntrinsicElements` was `[elemName: string]: Record<string, unknown>`, so every tag and attribute typechecked vacuously. Equivalence is pinned by `src/jsxRuntimeCorpus.test.ts` (the §62 corpus: written against the old runtime, required to pass verbatim against kerf's).

One consequence to know about: custom elements / untyped attributes need declaration merging into `'kerfjs/jsx-runtime'` (`src/jsx-augment.d.ts`).

**Enumerated vs boolean attributes.** `draggable`, `spellCheck` and `contentEditable` are *enumerated* attributes — write the keyword string (`draggable="true"`, `spellcheck="false"`), never a boolean. kerf 4.0 types them that way, so the boolean form no longer compiles; before that it did, and it rendered markup meaning the opposite. The old `DRAGGABLE_TRUE` workaround (`src/client/attrs.ts`) is gone as of HS-9373. Real boolean attributes — `hidden`, `checked`, `disabled`, `autofocus` — are unchanged.

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
- **`npm run lint` covers `src/`, `plugins/`, `e2e/`, `eslint-rules/` and `eslint.config.mjs` — the whole repo, with no exemptions.** Until HS-9523 the script was `eslint src/`, so `plugins/` was never gated at all and had accumulated 10 `await res.json() as Y` violations of the §"Type assertions" rule in the one module that talks to a third-party API. `eslint-rules/lintScope.test.mjs` fails if a directory holding lintable source is neither in the script nor listed as a deliberate exemption, and `KNOWN_UNGATED` is now **empty** — so the scope cannot silently narrow again.
- **`e2e/` gets a REDUCED `no-restricted-syntax` set** (`E2E_SPEC_RULES` / `E2E_HELPER_RULES` in `eslint.config.mjs`, HS-9533), composed by SUBTRACTING from `CORE_RULES` so a guard added later reaches specs automatically. Three are subtracted and the reasons are recorded beside the composition: `innerHTML` (every site is inside `page.evaluate`, i.e. the browser, where `toElement` does not exist), tool-id literals (a spec naming `'codex'` is test *data*, not a branch), and the wire-boundary rule **in `*.spec.ts` only** (the "upstream" is the server under test, so a stale cast makes the test fail — the outcome you want). It stays ON for e2e *helpers*, where a wrong shape propagates into every spec instead of failing one assertion.
- **`e2e/` type-checks clean** via `npx tsc -p e2e/tsconfig.json --noEmit` (HS-9533 took it from 6 errors to 0). It is not part of the root `tsc --noEmit`, which still covers `src/**` only.
- **Do NOT run `eslint --fix` blindly on `e2e/`.** It strips `as HTMLElement` from `querySelector` calls inside `page.evaluate` — and those assertions are load-bearing: `querySelector<E>` infers `E` from the *contextual type*, so the assertion is what supplies it. Removing it makes inference fall back to `Element` and `tsc` fails. The fix is an annotation (`const x: HTMLElement | null = el.querySelector(...)`), not deletion. Diff `tsc` output around any `--fix`.
- **Each plugin needs its own `tsconfig.json`** — the ESLint project service resolves types per-file from the nearest one, and a plugin without it isn't type-checked *or* type-aware-linted (it silently degrades to `any`, which is where most of the HS-9523 findings came from). Include `"lib": ["ES2022", "DOM"]` and `"types": ["node"]`: plugins run in the Hot Sheet Node process and call `fetch`.
- **Plugin tests** (`plugins/*/src/*.test.ts`) run only when explicitly targeted (`npx vitest run plugins/*/src/*.test.ts`) or via `npm run test:all-including-plugins`. NOT in `npm test`.

## Git

- **Commit as needed — no need to ask first.** Commit your own work whenever it reaches a sensible checkpoint (a completed ticket, a green build) with a clear message; you don't need to ask permission to commit. Prefer logically-scoped commits over one giant catch-all. Don't sweep unrelated pending changes into a commit; commit only what your task touched.
- **NEVER `git push` without the user's explicit permission.** Local commits are fine; publishing them is not — wait for an explicit "push" instruction. Strict, non-negotiable.
- **Drafting commit messages / release notes — use [gitgist](https://github.com/brianwestphal/gitgist)** (a devDependency; invoke via `npx gitgist`). For a commit message from staged work: `npx gitgist --staged --commit-message`. For release notes over a range: `npx gitgist <last_tag>..HEAD`. `scripts/release.sh` (`step_release_notes`) already uses it for the changelog/tag body, and `scripts/release-beta-auto.sh` uses it with a `--no-ai` deterministic fallback rung. Note: gitgist shells out to the signed-in `claude` CLI — a nested `claude` call — so when *you* are running inside a Claude session, prefer drafting the message/notes yourself (gitgist is the canonical tool for the user's own runs). Since **1.2.0** (HS-9456) release notes are **diff-grounded** — gitgist reads the range's actual code diff and treats it as the authority, so a feature buried under `chore:` still gets described and claims the code doesn't support get dropped; `--no-diff` returns to the old commit-messages-only behavior.

  **`gitgist.config.json`** at the repo root (HS-9457) pins the repo-level settings so every invocation — `release.sh`, `release-beta-auto.sh`, a hand-run `npx gitgist` — behaves the same. Explicit flags still win; `--no-config` ignores it. Three keys: `provider: claude-cli` (was `auto`, which resolved here anyway — but a CI run with only `$ANTHROPIC_API_KEY` and no signed-in CLI now **fails instead of falling back**, deliberate since notes are drafted locally); `linkCommits: true` (every release-note bullet cites its commit — ignored for `--commit-message`, so drafted commit messages are unaffected); and `exclude` for `docs/ai/*` + `.hotsheet/settings.json`, the two biggest non-code churn sources, so they don't consume the diff budget.

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

### Spreading an array into a call (`f(...arr)`)

`f(...arr)` passes every element as a separate **argument**, and argument count is bounded by the call stack. Past the bound V8 throws `RangeError: Maximum call stack size exceeded` — the same message runaway recursion gives, which is why this is so hard to read: there is no recursion in the trace, and the line has usually worked for months. It starts failing only when the data crosses the limit, and then it fails *every* time. Measured on this project's Node (22.14/arm64): fine at 100k, throws at 125k.

**For any array that can grow unbounded** — telemetry spans/events, tickets, sync records, anything read from a file or table — use the helpers in `src/utils/largeArray.ts` instead: `pushAll(target, source)`, `maxOf(values)`, `minOf(values)`. Spreading a fixed-size constant (`sections.push(...HEADER_LINES)`) is fine and stays.

This is HS-9451: `readAllOtelJsonl` accumulated day files with `out.push(...day)`, so once a day's spans crossed ~100k the prompt drill-down 500'd every time. `otelJsonlStore.test.ts` pins it with a 130k-row day file.

### Synchronous child processes (`execFileSync` / `execSync` / `spawnSync`)

These block the calling thread inside **native code** (`SyncProcessRunner::Spawn` → `uv_run`), so a child that never exits is not a slow call — it is a thread that never runs again. On a startup path that is a server that never finishes booting; in a vitest worker it is a suite where every test passed but no reporter, summary, or even `--reporter=hanging-process` dump can ever run.

**Every such call needs BOTH `timeout` AND `killSignal: 'SIGKILL'`.** The second one is not belt-and-braces: `timeout` is enforced by *sending* `killSignal`, which **defaults to SIGTERM**, and a child that ignores SIGTERM leaves the call blocked forever anyway.

This is HS-9391 — `enrich-path.ts` probed PATH with `execFileSync(shell, ['-ilc', …], { timeout: 2000 })`. The probe is an **interactive** shell, interactive shells ignore SIGTERM, so the timeout fired, the signal was discarded, and the call hung. It wedged the full test suite intermittently for a week and leaked immortal orphan shells on the dev machine (17 found, oldest 4d18h). Measured: the stuck shell survived SIGTERM, died on SIGKILL, and the held-up run printed its summary instantly.

The `no-restricted-syntax` ESLint rule (HS-9510) flags a sync child-process call missing either property. **It applies to test files too** (HS-9511) — HS-9391's entire *symptom* was a wedged test suite, and a wedge is harder to diagnose from a test than from production code, because the natural first assumption is that the test is merely slow. Where a hang is plausible, also make the child fail fast rather than wait (`GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0` for git), so the timeout is the backstop rather than the mechanism.

### Filesystem access on a user-configured path (`backupDir`)

Anything under **`backupDir`** goes through **`src/backupFs.ts`** (`backupFsFor(root)`) — never `existsSync`/`readFileSync`/… and never bare `fs.promises`. `backupDir` is user-configurable and users point it at iCloud Drive / Google Drive / a network share, which is the obvious thing to do with a backup folder. On macOS that is a **File Provider extension**: every operation is an XPC round-trip to a vendor daemon, it can block for an **unbounded** time, and there is **no kernel-level timeout**.

Two rules, and the second is the one that is easy to get wrong:

1. **Sync `fs` blocks the event loop** until the daemon answers, which may be never.
2. **Async `fs` alone is not the fix.** `fs.promises` runs on libuv's threadpool — **four threads by default**, shared with every other file/DNS/zlib user in the process. Four wedged backup reads starve *all* file I/O app-wide. So `backupFs` also adds a concurrency gate (2 of the 4 threads), a per-operation deadline, and a per-root circuit breaker that fails fast **without touching the filesystem** while open.

Callers must treat unavailability as a **normal outcome**, not an error to propagate: skip the tick, leave state alone, retry later (`tolerateOutage`). Backups are best-effort by construction — the live DB is `<dataDir>/db` and is never on the backup filesystem. Two directions to be careful about: an unreadable manifest set must never be read as "no blobs are live" (the GC would delete real backups), and a read must happen **before** anything is torn down (`restoreBackup` used to delete `db/` and only then read the tarball).

This is HS-9527. `readManifest`'s `readFileSync(path, 'utf-8')` against a Google Drive `backupDir` measured **686 ms per 134 KB manifest** and **19.9 s for the 29-manifest startup scan** — on an idle machine. It blocked the loop past the §45 watchdog's 60 s threshold and the server was SIGKILLed four times on 2026-07-31. The trigger was work that did not need doing at all: `reanalyzeMissingManifests` built a cross-reference index eagerly, then discarded it unused because nothing needed rebuilding. Both the guard and that laziness are covered by an ESLint `no-restricted-syntax` selector banning sync `fs` in `src/backup.ts` / `src/backupFs.ts` / `src/attachmentBackup.ts` (**test files included** — a sync call there is fast against a temp dir and only wedges against the user's real cloud folder) and by a regression test asserting **zero** manifest reads in the steady state. Full design: `docs/7-backup-restore.md` §7.10.

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

**Spike results are sub-docs, not new areas.** A spike belonging to doc `N` is named `N-<parent>-<topic>-spike.md` and listed inside `N`'s reading-order entry rather than taking a number of its own — it is a companion to a doc, not a functional area. `45-pglite-robustness-fsync-spike.md` and `45-pglite-robustness-checkpoint-spike.md` are the existing pair (HS-9545; maintainer decision 2026-08-01). Deliberate, so a doc-index audit does not read the shared number as a collision. The reading-order list itself stays in strict numeric order.

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
45. `45-pglite-robustness.md` — cleaner-shutdown design (`gracefulShutdown` helper). Two companion spike results share its number: `45-pglite-robustness-checkpoint-spike.md` (HS-7933, §45.6 checkpoint-tuning feasibility) and `45-pglite-robustness-fsync-spike.md` (HS-7932, §45.5 `fsync` round-trip verification).
46. `46-service-client-decoupling.md` — service/client decoupling design spike (WebSocket push)
47. `47-richer-permission-overlay.md` — permission popup diff preview + per-project allow-list
48. `48-git-status-tracker.md` — sidebar chip: branch + dirty count + ahead/behind
49. `49-reader-mode.md` — reader-mode overlay for notes + Details
50. `50-upgrade-nudge.md` — throttled npm→Tauri upgrade nudge overlay
51. `51-shell-history.md` — per-(project, terminal) shell history scoping
53. `53-streaming-shell-output.md` — REMOVED (HS-9185): live streaming of shell-command output as it arrives was dropped; shell commands still run and their FINAL output lands in the Commands Log on completion. Tombstone kept to avoid renumbering.
54. `54-terminal-checkout.md` — global terminal checkout / xterm stack
55. `55-ticket-cross-references.md` — clickable `HS-NNNN` refs → stacking modal
56. `56-magnified-grid-nav.md` — Shift+Cmd/Ctrl+Arrow magnified-tile navigation
57. `57-shell-command-button-spinner.md` — running shell-command button spinner + stop
59. `59-reader-note-navigation.md` — reader-mode prev/next note navigation
60. `60-reactivity-primitive.md` — fine-grained reactivity primitive (`kerfjs`, on `^4.1.0` since HS-9373; kerf 3.0 no longer infers dev mode, so its diagnostics are opt-in by importing `kerfjs/dev` — the client bundle deliberately doesn't, `vitest.setup.ts` does. 4.0 made `draggable`/`spellCheck`/`contentEditable` enumerated-only and stopped dropping inert `javascript:void(0)` hrefs, retiring two Hot Sheet workarounds)
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
98. `98-worker-batching-policy.md` — worker freshness "aggressiveness" knob: batch small/related tickets per branch, pay the rebase/install/gate overhead once per batch boundary; default batch small/related + isolate large/risky (design only, HS-9064)
99. `99-worker-worktree-refresh.md` — deterministic worker-side `refreshWorktree` helper (clean-tree guard → rebase → conditional reinstall → optional cache clear) at the loop boundary; mirror of HS-9048's owner-side `integrate.ts` (design only, HS-9063)
100. `100-server-driven-worker-launch.md` — move worker-pool launch choreography server-side so `setPoolTarget` scales the pool with no owner UI open (server reconcile loop + server-owned terminal lifecycle + client adoption) (design only, HS-9062)
101. `101-prompt-based-worker-management.md` — prompt box in the worker-pool panel ("parallelize all tickets tagged X") routed through the channel to the main agent → query/size/partition/dispatch via the MCP tools, with a partition-editor preview (design only, HS-9061)
102. `102-per-worker-git-state-and-review.md` — per-worker git state (ahead/behind + dirty) on pool tiles + a Glassbox worktree/branch target selector to review a worker's branch before integrating; main stays the owner-surface default (design only, HS-9060)
103. `103-command-button-target-picker.md` — opt-in command-button target picker (Run on → Main / worker-N / All workers) via long-press/chevron; default click stays main; worker targets gated for maintenance/idempotent commands (design only, HS-9059)
104. `104-worker-worktree-auto-approve.md` — pre-approve a worker worktree's MCP server + skills by writing the worktree's `settings.local.json` at create time; fixes the `registerChannelAt` allow-rule gap; residual workspace-trust prompt documented (core shipped HS-9085; design HS-9058)
105. `105-worktree-node-modules-provisioning.md` — provision `node_modules` into worker worktrees (CoW clone → symlink → `npm ci` + lock-diff reconcile) as one shared helper (createWorktree + §99 refresh) + a per-project worktree-setup hook (design only, HS-9057)
106. `106-integration-helpers-ready-signal-and-gates.md` — HS-9048 follow-ups: explicit per-worker "branch ready" signal (event-driven owner integrate loop, fallback scan kept) + optional in-helper gate-running with rollback (design only, HS-9053)
107. `107-custom-views-local-customization.md` — per-machine local custom views via the `custom_views` delta infra: sidebar local-by-default add + layer-implied edit, a Settings "Views" tab, and shared↔local move (design only, HS-9017)
108. `108-custom-commands-local-customization.md` — per-machine local customization of the `custom_commands` group TREE: tree-aware delta (`src/settingsCommandDelta.ts` — hide/override/added/childAdded + orphan survival), stable-id backfill, scope-aware editor (origin tags, hide-shared, child-into-shared-group), and top-level shared↔local move (SHIPPED, HS-9014)
109. `109-multi-client-terminals.md` — multi-client terminals via an **active-device** model: only the active device renders terminals live, all others show the §54 borrowed-terminal placeholder (one live renderer per PTY → one size → no resize thrash); per-project active-device heartbeat lease + claim-on-sustained-interaction + take-control affordance (design only, HS-9167; decomposed into HS-9189..9192)
110. `110-ai-review-notes-inducement.md` — Hot Sheet's cross-tool role in Glassbox's AI-authored review notes (its `docs/20`): **induce** the agents Hot Sheet drives to emit line-anchored `.pr-notes/` notes by injecting Glassbox's canonical `glassbox note instructions` text (don't fork the wording) into the worklist/skill, gated by an opt-in model + ticket-id threading (design only, HS-8838; open decision: the gating model §110.4)
111. `111-review-proof-artifacts.md` — READ side of §110: surface a ticket's Glassbox `.pr-notes/` proof artifacts (screenshots, test output) in its detail panel. Decided (HS-9223, 2026-07-02): **direct SARIF read**, **light list → click-to-expand rich**, **presence-gated** (not tied to the `aiReviewNotes` toggle). Phase 1 reader shipped (`src/reviewNotes/prNotesReader.ts`, word-boundary ticket match = no false matches); API + client detail-panel section = follow-up
112. `112-remote-client-connection.md` — CLIENT half of the §94 mTLS remote-access epic (HS-9193, design): connect the client to a *remote* Hot Sheet server (URL/QR → mTLS handshake → enumerate projects → mount as a tab). Server side fully shipped; purely additive client work — add `origin` to `ProjectInfo`, make the four same-origin URL builders origin-aware, a machine-global `~/.hotsheet/remotes.json` store, connection UX, multi-select enumeration, per-project connectivity state. Decomposed into HS-9302 (foundation: remote-ProjectInfo + transport) → HS-9303 (connection UX) → HS-9304 (enumeration+multi-select) → HS-9305 (connectivity) + HS-9306 (investigation: Tauri client-cert presentation → HS-9307 Rust-proxy scaffold + HS-9309). Open decisions in §112.9. Prereq for HS-9164/9160
113. `113-multi-ai-tool-support.md` — EPIC umbrella (HS-8932): support AI tools beyond Claude (Codex/Gemini/OpenCode/Goose critical; Cursor/Windsurf/Copilot context-only). Key taxonomy: **A** = CLI agents Hot Sheet drives via **ACP** (play/permission/busy — HS-8007 investigation, spike HS-8008 → `docs/114`); **B** = editor tools Hot Sheet only supplies rules/instructions to (skills.ts + HS-8916, shipped). Per-project **`ai_tool` setting** (HS-8009, shipped end-to-end incl. `{{aiCommand}}` resolution + skills selectivity HS-9311 + busy labels HS-9313) routes command resolution / skills / ACP agent / Commands Log labels. Open decisions §113.5; subsumes HS-8006/8003/8943
114. `114-acp-channel.md` — the **ACP** drive transport (one of two — see §115), for **ACP-native** Tier-A agents (OpenCode/Goose/Kiro/Codex-via-adapter; docs/113 §113.2 A2). Design (HS-9310). An **ACP client** (`src/acp/client.ts`, greenfield; pure `acpMapping.ts` core shipped) parallels the Claude channel: `session/prompt` = play, `session/update` = busy, `stopReason` = done, `session/request_permission` = the **option-driven** §47 overlay (agent supplies `PermissionOption[]`). MCP rides ACP unchanged. **⚠ Gemini CLI (old reference) is decommissioned → OpenCode is the lead ACP agent; Antigravity is NOT ACP (it's §115).**
115. `115-mcp-hooks-agent-channel.md` — the **MCP+hooks** drive transport (the other of two), for **MCP-native** Tier-A agents on the Claude rails (docs/113 §113.2 A1). **SHIPPED for Antigravity (HS-9319→9328):** `ai_tool='antigravity'`→`agy` (`resolveCommand`), the global cwd-resolving MCP-config writer (`src/antigravity.ts`), the `agy --print` play drive + busy heartbeats (`src/antigravityDrive.ts`), the opt-in PreToolUse→§47 permission hook (`src/antigravityPermissionHook*.ts`), AGENTS.md instructions + `.agents/skills` worklist routine. **SHIPPED for Codex (HS-9369 + HS-9359, §115.6a):** the second registry agent — `codex exec --json` one-shot drive (`src/codexDrive.ts`, event-driven + interval heartbeats off the captured JSONL contract) + `codex mcp add`-mediated TOML config write (`src/codex.ts`) + the opt-in `codex_interactive_permissions` §47 overlay (`.codex/hooks.json` PreToolUse/PermissionRequest hooks → `src/codexPermissionHook.ts`; hotsheet's own MCP calls auto-allowed; decisions must exit 0), live-validated. Maintainer decision (HS-9310): **pick ACP vs MCP per agent by the protocol it speaks.** Remaining §115.7: the shared three-way transport-selection picker + persistent (`-i`) mode.
116. `116-blocked-reason.md` — free-text `blocked_reason` field (a nullable "what is this waiting on" note, prose + `HS-NNNN` refs, AI-settable via `hotsheet_update_ticket` + a detail-panel editor) + row-border indicators: dark-gray `.blocked` (non-empty reason) and purple `.feedback-needed` (last note `FEEDBACK NEEDED`), precedence feedback > blocked > up-next. Orthogonal to the structured `ticket_blocked_by` gate (§90.6). SHIPPED (HS-9336).
117. `117-agent-backend-transport.md` — per-agent drive-transport capability table (`src/agentTransport.ts` `resolveAgentTransport`/`resolveProjectTransport`): `ai_tool` → `mcp-hooks` (docs/115, Antigravity) / `acp` (docs/114, OpenCode et al., via `isAcpDrivenTool`) / `claude-channel` (default). `triggerChannel` consults it (one switch) instead of two hard-coded gates; a new agent no longer touches `triggerChannel`. Capability table + auto-routing SHIPPED (HS-9331); Settings picker (HS-9338) + MCP-hooks generalization (HS-9339) are follow-ups.
118. `118-adapter-mode-tool-config.md` — adapter-mode per-tool config generators (HS-9366, SHIPPED): when the canonical Claude source exists (`CLAUDE.md` + `.claude/skills`), AGENTS-family tools (Antigravity/Codex) get a THIN-ADAPTER `AGENTS.md` section + `.agents/skills` adapters referencing the canonical files instead of duplicated content (the video-studio model); full-content fallback without a canonical source; grandfathered full-section files keep full mode (retirement = L3). Also adds **Codex** to instruction + skills generation; HS-9374 extends it to **Gemini CLI** (`GEMINI.md` + `.gemini/skills`, verified on 0.49.0) and fixes **OpenCode** to canonical-refresh (it reads `.claude/skills` directly — adapters would duplicate names); goose deferred to HS-9347. Foundational for HS-9367 (auto-prepare on `ai_tool` switch).
119. `119-tool-switch-config-prep.md` — prepare the selected tool's config on an `ai_tool` switch (HS-9367, SHIPPED): `src/toolPrep.ts` status (`getToolPrepStatus` — instruction file adapter-aware + main skill artifact version check) + one-click `prepareToolConfig`; ask-first prep dialog on the dropdown change (`src/client/toolPrepNudge.tsx`, reusing the §86 nudge surface) + the same drift check on project open (once per project/session, per-tool dismissal); explicit-tool projects skip the generic "Add to CLAUDE.md" prompt. `auto` never prompts.
120. `120-agents-md-adapter-retirement.md` — retire grandfathered full-section AGENTS.md duplicates (HS-9375, SHIPPED): `planAdapterConversion` classifies per file — **lossless** (all specifics unfilled → auto-converted in `writeInstructionsForTool`: strip + adapter), **migratable** (filled specifics whose CLAUDE.md counterpart is unfilled → ask-first via the §119 prep dialog; `convertToolFileToAdapter` migrates the filled blocks INTO CLAUDE.md first), **conflict** (differs from a filled CLAUDE.md block → never auto-converted; merge flow = HS-9378). Safety invariant: conversion only deletes scaffold or CLAUDE.md-preserved content.
121. `121-codex-app-server-drive.md` — Codex persistent drive via its `app-server` JSON-RPC protocol (HS-9381 design → HS-9382 spike → HS-9383 core + HS-9384 toggle/gating + HS-9385 Commands Log transcript + HS-9388 daemon transport + HS-9395 MCP-elicitation fix SHIPPED 2026-07-23): the drive prefers the SHARED codex daemon (`codexDaemonTransport.ts` UDS-WS, start-if-absent, stdio-child fallback) so external codex UIs — incl. `codex resume <threadId> --remote unix://<sock>` in a terminal — watch the driven thread LIVE; per-thread MCP override pins `--data-dir` + the drive marker; play/custom commands = `turn/start` into a persisted thread (queue+coalesce; manual-only reset), approvals + MCP tool-call elicitations → §47 overlay ACP-bridge-style (hotsheet's own MCP server auto-accepted), `codex_turn` transcript entries; Experimental toggle default ON, disabled = hide play + codex prompt buttons (supersedes the §115.6a exec drive). Remaining: HS-9394 (spawn Hot Sheet codex terminals pre-attached to the driven thread), phase-2 transcript pane.
122. `122-code-review-section.md` — "Code Review" detail-panel section (HS-9389 proposal): ONE aggregate Open-in-Glassbox reviewing all of a ticket's changes. Server discovery SHIPPED (HS-9392): `GET /api/tickets/:number/commits` — subject-line-only `HS-NNNN` matching (body mentions are cross-references), linear grouping by rev-list positions (`oldest^..newest` per group), earliest→latest span + unrelated count, `integration_branch` ref-labeled groups, tip-keyed cache. Client rename + button/chooser = HS-9393.
123. `123-codex-terminal-attach.md` — **HISTORICAL** (superseded by docs/129 model-B; the code was deleted in HS-9430, 2026-07-27) — codex terminals joined the project's DRIVEN app-server thread (HS-9394): `pickAiCommand` consults `codexTerminalAttachCommand` → `codex resume <threadId> --remote 'unix://<sock>'` when drive enabled + persisted rollout exists on disk + daemon transport in play (live stdio session vetoes); plain `codex` fallback otherwise. Interplay live-verified: codex queues concurrent turns, TUI drafts survive driven turns, TUI-typed turns share the thread + transcript. HS-9396 (SHIPPED): daemon pre-started ahead of need (project registration / `ai_tool` switch / drive re-enable → `prestartCodexDaemonIfNeeded` → `ensureCodexDaemonRunning`); no thread warming needed. HS-9397 (shipped, then DELETED by HS-9430): the "↻ Rejoin codex" header pill for launch-vs-attach drift — model-B removed the drift class, so the pill and the whole attach it keyed off are gone. Still live from this doc: the daemon pre-start (now gated on model-B, no rollout requirement) and `rolloutPath` persistence.
124. `124-in-development-gates.md` — **In Development** feature gates: Settings → Experimental toggles that keep half-built features (parallel agent workers, each non-Claude AI tool, remote access) OFF by default and out of the UI. Local-only by two mechanisms (a `dev_` prefix routed to the local layer by `defaultScope`, plus explicit local-layer writes); fail-closed reads; the `ai_tool` dropdown hides gated tools EXCEPT one the project already uses. Adding a gate = one entry in `src/devFeatures.ts`. Companion to `docs/feature-health.md`.
125. `125-project-scoped-client-state.md` — **investigation (HS-9409)** into the nine-bug "per-project client state survived a project switch" class (HS-8451/8053/8062/7993/8737/8738/9406/9407 + four found by the audit). Confirms the safe caches are the ones **keyed by project secret**, not the ones reset in `reloadAppState`. Recommends three layers: a `projectScoped<T>()` primitive (HS-9416), self-registration + one generic A→B→A isolation test, and an ESLint backstop (HS-9417) modeled on the §62 `innerHTML` allowlist. **Read before adding module-level mutable state to `src/client/**`.**
126. `126-project-scoped-primitive.md` — **`projectScoped<T>()`** (HS-9416, SHIPPED), the per-project client-state primitive that closes the docs/125 leak class: `const x = projectScoped(() => 0, 'label')` / `x.get()` / `x.set(v)`, keyed by project secret, read at access time from `projectsStore`, evicted centrally by `clearPerProjectSessionState`. `projectScopedIsolation.test.ts` walks EVERY registered cell A→B→A and **discovers adopting modules by grep, not a list**. **Adding module-level mutable state to `src/client/**`? Read §126.2** — and §126.5 for the subtle case (state describing a shared DOM node is global with a composite `secret::id` key, NOT scoped; scoping it caused a second bug during HS-9416).
127. `127-telemetry-wal-management.md` — **telemetry cluster WAL management** (HS-9426/9427, out of the HS-9420 OOM diagnosis): keeps each per-project telemetry PGLite cluster's `pg_wal/` bounded and reclaims the bloat already on existing installs. The disk-side companion to §128, which bounds memory.
128. `128-cluster-cache-bounding.md` — **bounded PGLite cluster cache** (HS-9420, SHIPPED): closes the 2026-07-24 server OOM crash loop where the unbounded `databases` Map pinned every project + telemetry cluster's ~180 MB WASM heap forever (~3.2 GB `external` vs a ~4.1 GB V8 ceiling; invisible in RSS). Policy in `src/db/clusterEviction.ts` (pure + unit-tested), handles in `connection.ts`: **LRU cap** (`maxOpen` 10) + **idle-close** sweep (`idleMs` 10 min, `unref`'d 60 s timer) + **headroom guard** (evict before opening when `external` nears the ceiling). Hard invariant: never evict a cluster with an in-flight query (the query-instrumentation proxy is now ALWAYS applied to track `beginClusterQuery`/`endClusterQuery`) or within the 30 s recency guard; `defaultDbPath` always pinned. Env-tunable (§128.5). **§128.5.6–7 are the load-bearing part and the standing rule:** closing a cluster frees nothing on its own (a WASM heap lives in `external`, which creates no heap pressure), so `db/forceGc.ts` forces the collection — with **two** `gc()` calls, since one measurably frees nothing. And a forced collection can't reclaim what something still holds: **never retain a `PGlite` past one operation** — hold a §128.3.2 pin for the operation, and store the `dataDir` (resolve via `getDbForDir` at use) for anything longer. `ProjectContext.db` broke that rule and pinned ~191 MB per registered project forever (HS-9483 → fixed in HS-9485, which also released `backup.ts`'s preview cluster per-request). Complements the HS-9426/9427 telemetry-WAL work ([127](docs/127-telemetry-wal-management.md)) — that bounds disk, this bounds memory.
129. `129-codex-model-b-terminal-hosting.md` — **codex model-B** (SHIPPED: Phases 1+2 HS-9428/9429/9431, default ON HS-9430, adoption fix HS-9438, Phase 3 chase-retirement HS-9430): flips the codex drive/terminal relationship so the **terminal owns a live daemon thread** (`codex --remote -C <projectDir>`) and the **drive discovers it by cwd** (`thread/loaded/list` → `thread/read` per id → `pickThreadForCwd`) + `turn/start`s on it — the Claude feel, killing the model-A "terminal chases the drive's thread" cold-start race (HS-9403). **§129.3a is the key protocol lesson (HS-9438):** on the real daemon `thread/resume` is BOTH the cold-load AND the `turn/*`/`item/*` event subscription, and it FAILS (`no rollout found`) for a fresh `--remote` session that hasn't completed a turn — so the drive adopts a discovered thread *without* depending on resume, derives that first turn's lifecycle from `thread/status/changed`, and re-checks discovery each turn (late-opened terminal + subscription upgrade). **Phase 3 (HS-9430) deleted the chase** — `codexTerminalAttachCommand` / `codexReattach` / the "↻ Rejoin codex" chip / `SessionState.resolvedCommand` are gone, and the gate that briefly replaced it (`codexModelBTerminals`) was itself REMOVED in HS-9513 — model-B is unconditional, with `HOTSHEET_CODEX_DISCOVER_THREAD=0|1` as the only escape hatch. model-A survives ONLY as the drive-side headless fallback (nothing discoverable → the drive owns its thread). **§129.9–10 (HS-9440) pin the MEASURED multi-client protocol facts** — read them before touching approval or turn-lifecycle handling: status changes are broadcast to every connection, **approvals route by SUBSCRIPTION not by who started the turn** (so an unsubscribed drive's own turn prompts only in the TUI; two subscribed clients are BOTH asked with one id), waiting-on-approval is `active`, a concurrent `turn/start` is absorbed into the running turn, and a fresh thread becomes resumable ~1 s into its first turn. Verified live vs codex-cli 0.145.0. Companion to docs/121 (drive) + docs/123 (the attach it superseded and deleted — now historical; its §123.4 approval claim was measured WRONG and is corrected in place). Open decisions §129.7.
130. `130-promised-file-drops.md` — **promised-file drops** (HS-9466): why dragging an unsaved macOS screen capture fails (the drag carries an `NSFilePromise`, so the browser hands over a `File` with a plausible `size` but no backing store, and `fetch` only discovers it mid-body → truncated multipart → `400 Malformed upload body` → the generic HS-9455 crash popup). **SHIPPED — the drag works (HS-9465 → HS-9466, verified 2026-07-29).** `dropFiles.ts::screenDroppedFiles` **materializes** every dropped file (full `arrayBuffer()`) and uploads those bytes, so a truncated body is structurally impossible; unreadable files are named with a ⌘V pointer, a mixed drop still attaches the good files, and nothing leaves a litter ticket. **The read turned out to FULFILL the promise, not just detect it** — `fetch` streams a `File` lazily and gets nothing, but a full read is a different request the OS honors (§130.3.2). So the planned native `NSFilePromiseReceiver` route (§130.5) was **never built and is not needed**, and the fix works in the browser too. Standing lesson: "no web API can *explicitly* fulfill an `NSFilePromise`" is true and does NOT mean the bytes are unreachable — try the read before costing out native work.
131. `131-system-memory-pressure.md` — **system memory pressure** (HS-9469, SHIPPED): the docs/128 cluster budget also honors the MACHINE's pressure, not just this process's heap headroom (it was blind to a machine swapping because of Xcode/VMs/a browser). `systemMemoryPressure.ts` reports `normal|warn|critical` from the kernel's own verdict — macOS `kern.memorystatus_vm_pressure_level`, Linux PSI `/proc/pressure/memory` `some avg10` (stall time, not free bytes), free-ratio fallback elsewhere. **`os.freemem()` is deliberately NOT the implementation** — measured on this machine: 0.9 GB free of 32 GB (2.8%) while the kernel said `normal`, so a naive ratio would shrink the cache on a healthy machine. Sampled (15 s TTL, never awaited on the eviction path) with ASYMMETRIC hysteresis: increases adopted immediately, decreases must survive 3 calmer samples (following every dip would cause churn). Applied as a CEILING on the process budget (`warn` halves the room above the floors, `critical` drops to them); a failed probe reports `normal` so a broken probe never shrinks the cache.
132. `132-ai-tool-plugin-interface.md` — **AI-tool plugin interface** (HS-9482, design; DECIDED 2026-07-29): a **NEW plugin interface specific to AI-tool integration** — not docs/18's `TicketingBackend`, not loaded by its loader — making every tool, **including Claude**, one `AiToolPlugin` implementation instead of ~12 scattered per-tool tables and `if (tool === …)` branches (the dropdown `<option>` list, `AI_INSTRUCTION_TOOLS`, `TOOLS`/`ADAPTER_FAMILY`, `DEV_FEATURES`, `agentDisplayName`, `CLI_AGENTS`/`AGENT_BINARIES`, `skillArtifactRelPath`, the `ensureSkillsForDir` if-chain, `mcpHooksAgents`, `resolveAcpAgentCommand`, `agentTransport`, the `FileSettings` zod fields, and the hand-written per-tool settings UI). **§132.1.1 is the urgent part:** five GENERIC modules (`terminals/eagerSpawn.ts`, `terminals/registry/lifecycle.ts`, `terminals/resolveCommand.ts`, `routes/settings.ts`, `routes/channel.ts`) import `codexAppServer.js` **by name**. Shape: identity + **optional capability objects** (`instructions`/`skills`/`command`/`drive`/`permissions`/`mcp`) where **absence = unsupported**, plus declared `preferences`; standing rule **no tool-id branch outside `src/aiTools/<id>.ts`** (ESLint-enforceable like the §62 and docs/125 backstops). **§132.9 is the load-bearing half — the host carries the machinery so a plugin stays thin:** §132.9.1 a toolkit of built-in mechanisms (rule of thumb — *if two plugins would write the same code it belongs in the toolkit*; the merge-safe hooks-file helper was written TWICE, in `ensureAntigravityHooks` + `ensureCodexHooks` — **since extracted to `src/aiTools/hooksFile.ts::ensureHooksFile` by HS-9506, along with the permission bridge to `aiTools/permissionHook.ts`; see §132.11.8, whose finding was that most of the toolkit already existed and was merely filed under one tool**), §132.9.2 reuse of docs/18's config-UI renderer behind a new storage adapter (its three storage couplings vs. AI-tool settings living in `FileSettings` with docs/95 layer routing), §132.9.3 registration stays in-tree but the surface is kept loader-ready. Migration is additive, one concern per phase — HS-9490…9497, Claude last, conformance suite + ESLint backstop at the end.
133. `133-ai-tool-availability.md` — **AI-tool availability + enablement** (HS-9517, SHIPPED): AI tools are OPT-IN like docs/18's bundled plugins. Two separate questions — **availability** (`AiToolPlugin.maturity`: `stable`/`beta`/`unreleased`, a property of the INTEGRATION, same on every machine) and **enablement** (per-project `ai_tool_enabled:<id>`, mirroring `plugin_enabled:{id}`, default OFF). **Claude alone is enabled by default** and cannot be switched off (it is the fallback transport, so the picker can never be empty); **Codex ships as `beta`**; Antigravity/OpenCode/Gemini/Goose are `unreleased` and hidden behind the single `dev_unreleased_ai_tools` gate that replaced the five `dev_tool_*` ones. Availability is checked INDEPENDENTLY of enablement so a copied settings row can't smuggle in an unreleased tool, and the picker always offers the tool a project ALREADY uses (the HS-9411 rule — never silently switch a working project).

Other docs: `docs/tauri-architecture.md` (Tauri v2 sidecar, launch/build/CI signing), `docs/tauri-setup.md` (build prereqs, signing keys, release workflow), `docs/dependency-security.md` (npm + cargo audit posture, Dependabot, triage), `docs/plugin-development-guide.md` (AI-focused plugin-building guide — **keep up to date** whenever the plugin system changes, so an AI can build a working plugin without reading source), `docs/demo-plan.md` (story-driven demo script for showing Hot Sheet + Glassbox to potential users), `docs/feature-health.md` (**does each feature actually work?** — per-feature Solid / Shaking out / Underbaked / Incomplete / Unknown, a point-in-time snapshot regenerated by the `/feature-health` skill. Distinct from `docs/ai/requirements-summary.md`, which tracks whether a feature was *built*; this one tracks whether it's *verified*. Read it before promising a feature works).

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

<!-- hotsheet:begin section=testing-philosophy v=2 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Coverage is a floor, not a ceiling**: 100% line/branch coverage shows every line *ran*, not that every *behavior* — or every *sequence* of behaviors — is *asserted*. It is structurally blind to a **missing state transition**: a bug living in an untested interaction sails through a green 100% report because the individual lines still get hit by isolated, single-operation tests.
- **Transition-matrix testing for stateful modules**: for anything with modes / multiple code paths / a cache / a state machine, enumerate the states AND the transitions between them, then write tests that walk realistic multi-step sequences crossing state boundaries — not just each operation from a clean initial state.
- **Adversarial pass on stateful changes**: when adding or altering a stateful code path, deliberately try to break it with out-of-order / interleaved / repeated / empty-then-refill sequences; pin any that would have failed as permanent regression tests.
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
