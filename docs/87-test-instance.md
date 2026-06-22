# 87. Isolated Test Instance

**Status: PARTIAL.** Foundation shipped (HS-8920 — `HOTSHEET_HOME` +
`globalHotsheetDir()`); the `--test` launcher + sandbox data-dir + default port
shipped (HS-8921); the visible "TEST" badge shipped (HS-8922). Optional keychain
namespacing (HS-8923) is deferred by decision.

## 87.0 Goal

Run a test copy of Hot Sheet that touches **none** of the real `~/.hotsheet`
global state and none of the user's real projects, and that can't collide with
the prod instance — so dogfooding a dev build never risks the real running copy.
Parent investigation: HS-8919.

The pieces:

| Concern | Mechanism | Ticket |
| --- | --- | --- |
| Relocate all global state | `HOTSHEET_HOME` env var + `globalHotsheetDir()` | HS-8920 (shipped) |
| Turnkey launcher (isolated home, sandbox data-dir, alt port) | `--test` flag | HS-8921 (shipped) |
| Unmistakable in-UI marker | "TEST" badge | HS-8922 (shipped) |
| Keep prod secrets unreadable | namespaced keychain service prefix | HS-8923 (deferred) |

## 87.1 `HOTSHEET_HOME` — relocating global state (HS-8920)

Every global path under `~/.hotsheet/` used to be resolved by its own
independent `join(homedir(), '.hotsheet', …)` call, so there was no single
switch to point them elsewhere. HS-8920 introduces one helper and one env var.

### The helper

`globalHotsheetDir()` (`src/global-dir.ts`, one primary export):

```ts
process.env.HOTSHEET_HOME?.trim() ? process.env.HOTSHEET_HOME : join(homedir(), '.hotsheet')
```

An empty or whitespace-only `HOTSHEET_HOME` is treated as **unset** (so an
accidentally-exported blank var can't silently relocate state).

### What routes through it

Every global resolver now derives its directory from `globalHotsheetDir()`:

- `src/global-config.ts` — `config.json` (global config)
- `src/project-list.ts` — `projects.json` (the project registry)
- `src/instance.ts` — `instance.json` (running-instance port/pid)
- `src/startup-log.ts` — `startup.log`
- `src/db/connection.ts` — `telemetry/` (central non-project telemetry store)
- `src/update-check.ts` — `last-update-check` (the daily npm-update-check stamp)
- `src/plugins/loader.ts` — `plugins/`, `dismissed-plugins.json`,
  `plugin-config.json`
- `src/routes/plugins.ts` — `plugins/` (install / uninstall)

So setting `HOTSHEET_HOME=/some/dir` makes a Hot Sheet process keep its entire
global footprint — registry, config, instance file, telemetry, plugins, update
stamp — under `/some/dir` instead of `~/.hotsheet`, and the real `~/.hotsheet`
is never read or written.

### Precedence with the pre-existing narrow overrides

Two per-file overrides predate this helper and keep working, taking precedence
over `HOTSHEET_HOME`:

- `HOTSHEET_STARTUP_LOG` (full path to the startup log)
- `HOTSHEET_TELEMETRY_DIR` (the central telemetry dir)

Resolution order for those two paths: **specific override → `HOTSHEET_HOME` →
`homedir()/.hotsheet`**.

## 87.1.1 The `--test` launcher (HS-8921)

`--test` is the turnkey flag that runs a fully-isolated instance. With it, Hot
Sheet can't touch real projects or real global state and can't collide with the
prod instance — so dogfooding a dev build never risks the real running copy.

`--test` applies these defaults, **each only when the user didn't pass the
explicit flag** (so `--port` / `--data-dir` / a pre-set `HOTSHEET_HOME` always
win, order-independent):

- **Isolated global dir:** if `HOTSHEET_HOME` is unset/blank, it's set to a
  *stable* `~/.hotsheet-test` (`testModeGlobalDir()` in `src/cli/args.ts`) — not
  a random temp dir, so the test instance's registry / config / telemetry stays
  inspectable across runs. Set **before** any `globalHotsheetDir()` consumer
  (see ordering note below).
- **Different default port:** `4274` (`TEST_MODE_PORT`) instead of `4174`, so a
  test instance and prod run side by side.
- **Sandbox data-dir:** `join(globalHotsheetDir(), 'sandbox-project',
  '.hotsheet')` — so launching `--test` from *inside a real project* never
  writes `.hotsheet/` into that real project (the key "doesn't edit my real
  projects" guarantee).
- **Process-global test flag:** `setTestMode(true)` (`src/test-mode.ts`,
  mirroring `src/demo-mode.ts`), read by the page shell to render the TEST badge
  (HS-8922). Exposed as `isTestMode()`.

**Ordering.** `cli.ts::main()` calls `maybeApplyTestModeHome(process.argv)` as
its very first line — before `initStartupLog()` and the event-loop watchdog — so
even the test instance's `startup.log` lands under `~/.hotsheet-test` and the
real `~/.hotsheet` is never written. `parseArgs` re-applies it idempotently and
fills in the rest of the defaults.

**`--replace` safety.** With the isolated `HOTSHEET_HOME`, `readInstanceFile()`
reads the test home's `instance.json`, so `--test --replace` can only ever
target a *prior test instance* — never prod.

**Convenience.**
- **Browser dev:** `npm run dev:test` → `npm run dev -- --test`.
- **Desktop (Tauri) dev:** `npm run tauri:dev:test` → `tauri dev --no-watch --
  -- --test`. The Tauri shell forwards `--test` to the sidecar
  (`collect_forwarded_server_args` in `src-tauri/src/lib.rs`); its own isolated
  `instance.json` keeps it from fighting the dev launch's default `--replace`.
  The **double `--` is required** and is exactly why the dedicated script exists:
  `tauri dev` treats args after the first `--` as runner (cargo) args and only
  args after a *second* `--` as binary args — a single `--` lands `--test` on
  `cargo run` and errors out (HS-8929).

## 87.1.2 The TEST badge (HS-8922)

So an isolated test window is never mistaken for the real one, the page shell
renders an unmistakable **TEST** badge in the top-left corner of the header
whenever the process is in test mode. The badge also shows the bound port (e.g.
`TEST :4274`) — the whole point being that it runs alongside prod, so the port
is the quickest disambiguator.

- **Render:** `src/routes/pages.tsx` renders a `.test-instance-badge` as the
  first `app-header` child, gated on `isTestMode()` (`src/test-mode.ts`). The
  port comes from the request's `Host` header (the actual port the client
  connected on), so it's always correct even if the bound port differs from the
  4274 default.
- **Style:** `src/client/styles.scss` `.test-instance-badge` — an amber pill
  (`#f59e0b`) with near-black bold uppercase text, a distinct color from the
  category/priority dots so it can't be confused with anything else.
- **Off when off:** absent entirely on a normal (non-`--test`) launch.

Tests: `src/routes/pages.test.tsx` (badge present + port / present without port /
absent when off), `src/cli.testMode.e2e.test.ts` (the served page from a real
`--test` instance contains the badge + bound port), `e2e/test-badge.spec.ts`
(absent in a real browser on a normal launch).

## 87.2 What is NOT relocated (on purpose)

- **OS keychain** — plugin secrets + API keys live under hardcoded
  `com.hotsheet.plugin.*` service names (`src/keychain.ts`), which are global. A
  test instance therefore shares the real keychain. Namespacing them under
  `HOTSHEET_HOME` is the deferred follow-up HS-8923 — file only, build only if a
  concrete need to keep prod secrets out of a test instance appears. (Note: the
  key *metadata* in `config.json` `keys` IS already isolated, since `config.json`
  moves with `HOTSHEET_HOME` — a relocated instance simply starts with an empty
  key set.)
- **`~/.claude/`** — stays shared so real Claude auth keeps working in
  terminals.

## 87.2.1 Keychain namespacing (HS-8923 — deferred by decision)

**Status: Design only, not built. Build only if a concrete need appears.** When
HS-8919 was scoped the user explicitly chose the `HOTSHEET_HOME` + `--test` +
badge cut and left keychain namespacing out of the first pass.

**The gap.** Even with an isolated `HOTSHEET_HOME` and `--test`, the OS keychain
stays shared: the service names in `src/keychain.ts` are hardcoded
`com.hotsheet.plugin.<pluginId>` (e.g. `com.hotsheet.plugin.keys`) and aren't
derived from the global dir. So a test instance reads/writes the **real** API-key
+ plugin secrets. For most testing this is fine — and arguably convenient (real
keys are available) — and it only matters if you want a test instance that
genuinely **cannot see or mutate** real secrets.

**Possible approach (when/if built).**
- When `HOTSHEET_HOME` is set (or `isTestMode()`), derive a namespaced service
  prefix, e.g. `com.hotsheet.test.<hash-of-HOTSHEET_HOME>.plugin.<pluginId>`, in
  `src/keychain.ts`.
- Keep prod unchanged (no namespace when running normally) so existing stored
  secrets keep resolving.
- Key *metadata* already lives in `config.json` `keys`, which is **already
  isolated** by `HOTSHEET_HOME` — so a namespaced test instance would simply
  start with its own (empty) key set until keys are added in it.
- Tests: unit-assert the service name is namespaced under test mode and unchanged
  in prod; assert prod secrets are unreadable from a namespaced test instance.

**Why deferred.** The user picked the scope without it. Revisit only if testing
surfaces a real need to keep prod secrets out of the test instance (or to avoid a
test run clobbering a real key value). Until then, treat a `--test` instance as
sharing the real keychain.

## 87.3 Per-project `.hotsheet/`

`HOTSHEET_HOME` relocates only **global** state. A project's own `.hotsheet/`
data dir (the PGLite DB, attachments, worklist) is selected by `--data-dir` /
the launch cwd, independent of `HOTSHEET_HOME`. The `--test` flag (HS-8921) adds
a sandbox data-dir default so a test launch from inside a real project doesn't
write `.hotsheet/` into that real project.
