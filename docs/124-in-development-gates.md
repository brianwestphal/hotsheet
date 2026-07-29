# 124. In Development feature gates

HS-9411. A Settings → Experimental section that keeps half-built features **off by default** and out
of the UI until a user opts in per machine.

Companion to [`feature-health.md`](feature-health.md): that doc records which features are
Underbaked / Incomplete / Unknown; this one is the mechanism that stops those features from being
reachable by accident.

## 124.1 The section

Settings → Experimental → **In Development**, with two notes above the list:

> ⚠ The following features are in active development and are disabled by default. They are likely
> incomplete and/or not well tested — **enable them at your own risk.**

> **Local to this machine.** These toggles live in `settings.local.json` (gitignored) — they apply to
> this project on this machine only and are never committed or shared with your team.

The checkbox rows are rendered client-side from the shared `DEV_FEATURES` list
(`src/devFeatures.ts`) by `src/client/inDevelopmentSettings.tsx`, so **adding a gate is a one-file
change**. Each row is a label plus a hint saying what enabling it exposes *and what is unfinished
about it*.

## 124.2 The gates

| Key | Label | Hides when off |
| --- | --- | --- |
| `dev_parallel_workers` | Parallel agent workers (git worktrees + worker pool) | Sidebar worker-actions row, worker-pool + in-flight panels, the auto-worker-pool switch, and the "Run on…" command target chevron (docs/89, docs/91, docs/103) |
| `dev_tool_codex` | Codex | The `codex` option in the AI-tool dropdown (docs/121) |
| `dev_tool_antigravity` | Antigravity | Ditto for `antigravity` (docs/115) |
| `dev_tool_opencode` | OpenCode | Ditto for `opencode` (docs/114) |
| `dev_tool_gemini` | Gemini CLI | Ditto for `gemini` (docs/118 §118.4a — config generation only, no drive) |
| `dev_tool_goose` | Goose | Ditto for `goose` (deferred, HS-9347) |
| `dev_remote_access` | Remote access | The Settings → Remote Access tab (mint / QR-pair / revoke) and remote-project client surfaces (docs/94, docs/112) |

**Worktrees and the worker pool share one gate** (maintainer decision, HS-9411): the pool is unusable
without worktrees, and their incompleteness is the same incompleteness.

**Claude and the Tier-B editor tools (Cursor / Copilot / Windsurf) are NOT gated.** The editor tools
only receive generated rules/instructions — a shipped, tested path with no drive surface to hide.

## 124.3 Scope: local-only, by two independent mechanisms

1. **Server-side** — `defaultScope()` (`src/file-settings.ts`) routes the whole `dev_` **prefix** to
   the `local` layer, next to the existing `_nudge_dismissed` suffix rule. A new gate therefore
   *cannot* accidentally ship as a shared setting.
2. **Client-side** — `inDevelopmentSettings.tsx` writes with `updateFileSettingsLayer('local', …)`
   explicitly rather than `persistScopedSetting()`, which would target whichever layer the dialog's
   scope bar is currently showing.

The section is also tagged `data-scope-complex="local-only"`, so the §95 scope bar locks it in Shared
mode with the standard "Local only — switch to Local to edit" note.

## 124.4 Default-off must fail closed

Every read defaults to **false**:

- `isDevFeatureEnabled(resolved, key)` returns true only for an explicit boolean `true` — absent,
  `"true"` (string), `1`, and `null` are all off.
- `isDevEnabled(key)` in the client cache is `cache[key] === true`, so an un-hydrated cache (before
  the first settings load) reads as off rather than as on.

A gate that failed open would defeat the point of the section.

## 124.5 Gating mechanics

- **Declarative:** an element marks itself `data-dev-feature="<key>"` and `applyDevFeatureGates()`
  toggles its `hidden` attribute. A CSS rule `[data-dev-feature][hidden] { display: none !important }`
  is required — the UA's `[hidden] { display: none }` loses to any class rule that sets `display`
  (`.settings-tab { display: flex }` kept a gated tab visible while carrying `hidden=""`).
- **Imperative:** surfaces that already own their visibility (`channelUI.tsx`'s worker rows, which
  are also channel-gated; the command target chevron) call `isDevEnabled()` directly.
- **The declarative form only hides what OPTS IN, which is the failure mode of this design**
  (HS-9473). Two Codex-specific *global* settings — "Codex app-server drive" and "Codex terminals
  host the driven session" — shipped without `data-dev-feature`, so they stayed visible in a
  project with the Codex gate off. Nothing was broken: `applyDevFeatureGates` can only act on
  elements that ask it to, and no test of the *mechanism* can catch markup that never asks. A
  tool-specific setting being machine-global does not exempt it — global scope answers "where is
  the value stored", the gate answers "should this be reachable at all". `pages.test.tsx` now
  asserts the markup directly, including a class-level guard that fails on ANY settings field
  mentioning a gated tool that is neither `data-dev-feature`-gated nor revealed by the `ai_tool`
  selection.
- **Per-project hydration:** `hydrateDevFeatures(resolved)` **replaces** the cache on every
  `loadSettings()`, which runs on each project switch. Per HS-9407 this must never be a merge, or a
  gate enabled in one project would leak into the next.
- **Remote Access tab dead-end:** the dialog remembers the last active tab (HS-9126), so hiding the
  Remote Access tab while it is active also moves the selection back to General — otherwise Settings
  reopens to a hidden tab with a blank panel.

### `ai_tool` dropdown

`applyAiToolDevGating()` (`settingsDialog.tsx`) hides + disables the option for any gated tool whose
gate is off, **except** when the project's saved `ai_tool` already equals it. In that case the option
stays, suffixed `— in development`.

That exception is deliberate: hiding the selected option renders the `<select>` blank, and the next
change would silently rewrite a project that currently works. A project already driving Codex keeps
driving Codex after upgrading into this feature.

**The tool gates act at the point of SELECTION, not at drive time — deliberately.** A gated tool that
a project is already set to keeps its play button, prompt commands, and permission overlay. Hiding
the drive surface *and* keeping the option would be self-contradictory: it would leave the project
nominally on Codex with no way to run anything, which is the "silently broken" outcome the exception
exists to prevent. This matters because `ai_tool` is a **shared** setting — a teammate can commit
`ai_tool: codex`, and a machine that never enabled the gate must still be able to work in that
project. What the gate actually prevents is *newly opting in* to a half-built tool by picking it from
the dropdown.

## 124.6 Graduating a feature

When a feature is genuinely done: delete its entry from `DEV_FEATURES`, remove its
`data-dev-feature` markers and `isDevEnabled` checks, and drop its row from §124.2. Stale
`dev_*` keys left in a user's `settings.local.json` are harmless — `defaultScope` still routes them
locally and nothing reads them.

Update [`feature-health.md`](feature-health.md) in the same change: a graduating feature should be
moving off its Underbaked / Unknown row, and if it isn't, it probably isn't graduating.

## 124.7 CLI

`--bind` and `--server remote-access` are annotated **[ALPHA]** in `hotsheet --help`
(`src/cli/args.ts`), pointing at docs/97 and `feature-health.md`. The CLI flags are NOT gated by
`dev_remote_access` — a client-side preference must never be able to weaken or alter a security
path, and a headless server host has no UI to toggle. See §124.8.

## 124.8 What the gates deliberately do NOT do

- **They never change server behavior.** Turning a gate off hides UI; it does not stop a worker
  already running, delete a worktree, disable an MCP server, or drop a persisted `ai_tool`.
- **They never touch mutual-TLS enforcement.** An exposed bind requires client certificates whether
  or not `dev_remote_access` is on. Putting a UI toggle in an authentication path would be a
  fail-open security bug (docs/94 §94.11).

## 124.9 Tests

- `src/devFeatures.test.ts` — registry invariants (every key `dev_`-prefixed AND routed local by
  `defaultScope`, unique keys, exactly the five gated tools), fail-closed `isDevFeatureEnabled`, and
  `isAiToolSelectable` including the already-selected exception and its case-insensitivity.
- `src/client/devFeatures.test.ts` — cache hydration (including the project-switch no-leak
  transition), per-tool independence, `applyDevFeatureGates` DOM behavior, and the Remote Access
  tab dead-end.
- `e2e/in-development-gates.spec.ts` — the real UI: all gates off by default, the Remote Access tab
  appearing/disappearing without a reload, persistence to `settings.local.json` and **not**
  `settings.json`, survival across a reload, dropdown filtering, the already-selected-tool
  exception, and worker rows staying hidden even with the channel enabled.
