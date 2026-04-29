# 48. Git Status Tracker (Sidebar Indicator)

HS-7598. Surface the project's git state — branch, dirty working tree, commits ahead/behind upstream — as a passive indicator in the Hot Sheet sidebar. The user often needs to know "do I have changes that need committing? do I need to push?" while bouncing between tickets and code; today they have to drop into a terminal and run `git status` to find out.

> **Status:** Shipped (Phases 1 + 2 + 3). Phase 1 (HS-7954): `src/git/status.ts` + `src/git/watcher.ts` (500 ms cache + `fs.watch` on `.git/index` + `.git/HEAD`) + `GET /api/git/status` + sidebar chip. Phase 2 (HS-7955): `getGitStatus` populates `upstream` / `ahead` / `behind`; new `runGitFetch` + `POST /api/git/fetch` endpoint; chip extended with `↑N ↓M` glyphs + two-line tooltip including `last fetched N minutes ago` via pure `formatRelativeTime`. Phase 3 (HS-7956): chip click toggles a non-modal popover (`src/client/gitStatusPopover.tsx`) anchored under the chip with branch line (`main → origin/main` / `main (no upstream)` / `(detached: <SHA>)`), ahead/behind line (when upstream), per-bucket counters (clickable to expand into per-file lists fetched from the new `?files=true` query param backed by `getGitStatusFiles` + pure `bucketPorcelainFiles` using `git status --porcelain=v1 -z`), and a `Last fetched … / Fetch now` row that re-renders on success. File rows click → reveal-in-finder via new `POST /api/git/reveal` (joined against git root + path-traversal guarded). Right-click on file row → "Copy path" context menu. 47 unit tests across `status.test.ts` (15: 10 for `bucketPorcelain` + 5 for `bucketPorcelainFiles` -z parsing / 200-cap truncation / spaces in paths) + `gitStatusChip.test.ts` (24) + `gitStatusPopover.test.ts` (8: branch line + ahead/behind line formatting).

## 48.1 Built-in plugin or core feature?

The originating ticket asked: *"maybe this should be a built-in plugin?"* The answer is **core feature, auto-detected**, for these reasons:

- **Hot Sheet is for developers, and developers' projects are git repos.** Almost every Hot Sheet `dataDir` will be inside a git working tree. Making git tracking opt-in via a plugin install creates friction for the 95% case to no benefit.
- **The plugin system (§18) is built around ticketing-backend integrations** — pull/push/conflict-resolve/comment sync. Git status tracking has none of that surface; bolting it onto the same lifecycle is awkward.
- **Existing helpers already exist in core.** `src/gitignore.ts` has `isGitRepo`, `getGitRoot`, and the `.hotsheet/` gitignore-check codepath. Adding a `src/git/status.ts` next to it follows the existing organisation rather than carving out a new boundary.
- **Auto-detection is the right escape hatch.** If `isGitRepo(projectRoot)` returns `false`, the entire feature stays silent — no chip, no API calls, no errors. Non-git projects pay zero cost. This delivers the plugin's "opt out for free" value without the plugin's setup overhead.
- **A user who genuinely doesn't want it** gets a `git_tracking_enabled` boolean in Settings → General to suppress (§48.6.1).

The "built-in plugin" framing is also slightly misleading: the existing plugin system is for *user-installed* plugins shipped under `plugins/<name>/`. There's no precedent for a plugin that's force-loaded with the binary. So "built-in plugin" effectively *is* "always-on core feature" — the wrapper is just paperwork.

## 48.2 Scope

**In scope.**
- Sidebar chip showing branch + dirty/clean state.
- Counts of commits ahead / behind upstream tracking branch.
- Counts of staged / unstaged / untracked files.
- Auto-refresh on filesystem change (working-tree mutations) + on-demand refresh via a click.
- Manual "fetch" button to refresh the ahead/behind numbers (which only change after `git fetch`).
- Auto-detection — silently no-op when the project root isn't a git repo.

**Out of scope.**
- **Commit / stage / push / pull / branch-switch UI.** Hot Sheet stays read-only with respect to the git index. The user runs git commands in the terminal (or their IDE); Hot Sheet just *shows* the resulting state. Adding write operations expands the security surface (auth credentials, signed commits, hooks) far beyond this ticket.
- **Inline diff viewer.** Defer to potential future work; the embedded terminal (§22) already gives the user `git diff`.
- **Multi-worktree / submodule traversal.** Hot Sheet's `dataDir` lives at one git root; we don't recurse into submodule trees or sibling worktrees. If `git rev-parse --show-toplevel` returns a different path than expected (worktree linked elsewhere), we still operate on the toplevel result and surface it accurately.
- **Stash management.** Same rationale as the commit / push cut-out.
- **GitHub / GitLab / Bitbucket-specific surfacing** (PR status, CI badges). The GitHub plugin (`plugins/github-issues/`) is the right home for those if the user wants them.
- **Background `git fetch` cadence by default.** Auto-fetch is opt-in (§48.6.1) — running `git fetch` against an authenticated remote on a timer is a network and credential-prompt hazard we don't take on by default.

## 48.3 Server-side

### 48.3.1 New module: `src/git/status.ts`

```ts
export interface GitStatus {
  branch: string;              // current branch name, or detached HEAD's short SHA
  detached: boolean;           // true if HEAD is detached
  upstream: string | null;     // "origin/main" if tracking, null otherwise
  ahead: number;               // commits in HEAD not in upstream (0 if no upstream)
  behind: number;              // commits in upstream not in HEAD (0 if no upstream)
  staged: number;              // staged file count (pre-commit)
  unstaged: number;            // unstaged file count (modified files in working tree)
  untracked: number;           // untracked file count
  conflicted: number;          // unresolved-merge file count
  lastFetchedAt: number | null; // ms epoch of last successful fetch (Hot-Sheet-initiated)
}

export async function getGitStatus(projectRoot: string): Promise<GitStatus | null>;
```

Returns `null` when `isGitRepo(projectRoot)` is false. Otherwise spawns a small handful of `git` invocations (no shell, args-array form):

- `git symbolic-ref --short HEAD` → branch (falls back to `git rev-parse --short HEAD` for detached state).
- `git rev-parse --abbrev-ref --symbolic-full-name @{u}` → upstream (silent failure → null + ahead/behind = 0).
- `git rev-list --count @{u}..HEAD` + `git rev-list --count HEAD..@{u}` → ahead / behind (skipped if no upstream).
- `git status --porcelain=v1 --no-renames` → bucketed counts: staged from index column, unstaged from worktree column, untracked from `??`, conflicted from `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD`.

Every spawn has a 2-second timeout. A timed-out or errored sub-call yields conservative defaults (the field reads `0` or `null`) rather than failing the whole status fetch — partial information is more useful than no chip at all.

### 48.3.2 New routes: `src/routes/git.ts`

```
GET  /api/git/status          → GitStatus | null (auto-detected)
POST /api/git/fetch           → { ok: boolean, lastFetchedAt: number, error?: string }
```

`GET /api/git/status` is cheap enough to call on every poll cycle (~50ms even on a busy repo). `POST /api/git/fetch` runs `git fetch --quiet --no-write-fetch-head` against the upstream of the current branch (no-op if no upstream); 30-second timeout; non-blocking response.

A new `git_status` event is added to `command_log` when the user clicks "Fetch" — both the trigger and the result (success / failure) are logged for audit. `git fetch`'s stderr (which is what carries useful errors like "auth failed" or "no upstream") is preserved in the log entry's detail field.

### 48.3.3 Watching

The server watches `<gitRoot>/.git/index` and `<gitRoot>/.git/HEAD` (chokidar). When either changes, it bumps a per-project `gitChangeVersion` integer and notifies the existing `/api/poll` long-poll waiters. Clients fetch `/api/git/status` and re-render.

Watching `.git/index` catches stages / commits / unstages. Watching `.git/HEAD` catches branch switches and detached-HEAD transitions. Watching `.git/refs/remotes/` would catch background fetches done by other tooling (IDE, terminal `git fetch`), but `chokidar` plus `git`'s ref-packing can be flaky here — defer until Phase 2 demands it.

A noisy editor that touches `.git/index.lock` should NOT trigger a re-render. The watcher filters to exact filenames (`index`, `HEAD`) and ignores tmp/lock siblings.

### 48.3.4 Performance + bounded fan-out

`getGitStatus` results are cached for 500ms per project. Multiple clients hitting `/api/git/status` within that window share the same result. Beyond 500ms, the next request re-runs `git`. This bounds load when (e.g.) a tab refresh + a watcher event + a manual click all fire within the same tick.

`git` is spawned with `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` so that an unexpected credential prompt never blocks the server, and so that read-only status calls never compete for `.git/index.lock` with the user's active terminal.

## 48.4 Client-side

### 48.4.1 Sidebar placement

A `<div id="sidebar-git-chip" className="sidebar-git-chip">` row rendered ABOVE the channel play button in `src/routes/pages.tsx`. Originally HS-7954 placed it between `#channel-commands-container` and the Views section with bordered chrome and tinted backgrounds; HS-7975 moved it above the play button and restyled it as a borderless full-width sidebar row that highlights only on hover. When git tracking is disabled OR the project isn't a git repo, the row is `display: none`.

Layout (HS-7975): full sidebar width, padding `4px 12px`, no border, transparent background. The branch label `flex: 1`, the count pill is `margin-left: auto` so it right-aligns. The tint classes (`is-clean`, `is-dirty`, `is-conflicted`, `is-ahead`, `is-behind`) colour the text + count pill only — the row chrome is plain unless hovered.

Layout:
```
[ branch icon ] main  • +3 −1  • 5
                       ↑   ↑    ↑
                  ahead/behind   uncommitted total (staged+unstaged+untracked+conflicted)
```

Tints (left-to-right precedence: conflict > behind > ahead > dirty > clean):
- **Red** when `conflicted > 0` (you have a merge in progress that needs resolving)
- **Amber** when `behind > 0` (your branch is behind upstream; pull recommended)
- **Blue** when `ahead > 0` (you have commits to push)
- **Yellow** when `staged + unstaged + untracked > 0` (you have local changes)
- **Muted / green** when everything's zero (clean + up-to-date)

Hovering the chip shows a tooltip with the full breakdown ("3 staged, 1 unstaged, 1 untracked, 0 conflicts; 3 ahead, 1 behind origin/main; last fetched 4 minutes ago").

### 48.4.2 Click → expanded panel (Phase 3)

Clicking the chip slides open a small popover anchored under it:

```
┌─────────────────────────────────────────┐
│ main → origin/main                      │
│                                          │
│   3 ahead • 1 behind                     │
│                                          │
│ Working tree                             │
│   3 staged                               │
│   1 unstaged                             │
│   1 untracked                            │
│                                          │
└─────────────────────────────────────────┘
```

The popover is non-modal (per the §12.10 popup pattern). The popover is read-only — the previous "Last fetched … / Fetch now" row was removed in HS-7974 at the user's request (the API endpoint stays, no UI surfaces it). Phase 3 may add a clickable per-bucket file list (staged → list of paths; click to copy or reveal in finder), but this is incremental — the v1 expanded panel just shows counts.

### 48.4.3 Polling

The chip subscribes to the existing `/api/poll` long-poll's version stream. When the server bumps `gitChangeVersion`, the client refetches `/api/git/status` and re-renders. No dedicated git long-poll endpoint — git events ride on the existing version channel to keep the client connection count constant.

On tab focus (`window.addEventListener('focus', …)`) the client also refetches once, since the user often alt-tabs from a terminal back to Hot Sheet immediately after running `git commit` and expects to see the change.

**Project switch (HS-7993).** `app.tsx::reloadAppState` calls `refreshGitStatusChip()` on every project switch — pre-fix the chip kept showing the previous project's branch + dirty count until the next poll-version bump or `window.focus`, which the user reported as "doesn't seem to update when switching projects". To make the swap feel instant rather than wait on the round-trip, the chip keeps a per-project `Map<projectSecret, GitStatusJson | null>` cache: on every refresh the secret is compared against `lastStatusSecret`, and on mismatch the cached value for the new project (or null on first visit) is rendered synchronously before the fetch lands. The `pure pickDisplayStatusOnProjectSwitch(newSecret, cache)` helper (exported for tests) encapsulates the cache-vs-null decision. In-flight requests are coalesced per-project (`inFlightByKey: Map<key, Promise>`) — sharing a promise across projects would resolve the new request with the old project's response. The mid-flight project-switch race is handled by stamping the cache with the secret captured at request-fire time and only re-rendering when the fetch completes for what's still the active project.

### 48.4.4 Tauri-safe interactions

- The chip is rendered server-side in `pages.tsx`; the click handler lives in client code.
- The fetch endpoint (`POST /api/git/fetch`) stays available but the popover no longer surfaces a button that calls it (HS-7974).
- Phase 3's "Reveal in Finder" for a file path goes through the existing `openInFileManager` Tauri command (per §5).

### 48.4.5 No git on PATH

If `getGitStatus` cannot find a `git` binary at all (PATH lookup fails), the chip stays hidden. The server logs a one-time warning. Defensive fallback rather than a noisy error — Hot Sheet can be installed by non-developers (e.g. via the desktop app on a fresh laptop) and the missing-`git` case is realistic.

## 48.5 Settings

New keys in `<dataDir>/settings.json` (per `src/db/settings.ts`):

| Key | Default | Description |
|---|---|---|
| `git_tracking_enabled` | `true` | Master switch. When `false`, the chip never renders and `/api/git/status` returns `null`. |
| `git_auto_fetch_interval_ms` | `0` | Background fetch cadence. `0` = never (default). Recommended values: `300000` (5min), `1800000` (30min). The fetch only runs while Hot Sheet is in the foreground — no background-tab auto-fetch. |
| `git_chip_show_clean` | `true` | When `false`, the chip hides itself when the repo is clean + up-to-date. Power-user opt-in for less visual noise. |

Settings → **Git Status** sub-section (under General) exposes the three knobs.

## 48.6 Settings dialog wiring

A new "Git Status" tab in the Settings dialog (or a sub-section under General — UX TBD during HS-7954 implementation):

- Toggle: Enable git tracking [on by default if a git repo is detected]
- Toggle: Hide chip when clean
- Number input: Auto-fetch interval (minutes); 0 = never

Per the existing settings convention ([2-data-storage.md](2-data-storage.md)), the keys live in file-based project settings — no DB row.

## 48.7 Open questions

- **Should Hot Sheet's own writes affect the dirty count?** Hot Sheet writes `.hotsheet/worklist.md`, `.hotsheet/open-tickets.md`, etc. These are gitignored by default (§2 + `src/gitignore.ts`), so they don't show up in `git status` and don't affect the chip. Worth a regression test on the HS-7954 implementation.
- **Should the chip be per-project (i.e. live inside a project tab) or app-global?** Today's sidebar already lives inside a project context (the active project's tabs and stats render in the same column). The chip naturally inherits this — when the user switches projects, the chip refreshes with the new project's git state. Multi-project view (if it ever ships) needs to revisit.
- **Auto-fetch credentials.** If the user enables auto-fetch and the upstream needs SSH key unlock or HTTPS prompts, the fetch will fail silently. We log the stderr to `command_log` (per §48.3.2). A more elaborate "credential helper status" indicator is conceivable but out of scope.
- **Phase 3 file-list interactions.** Should clicking a staged file open it in $EDITOR? Open in the embedded terminal? Open in Tauri-routed `code` command? Decide during HS-7956 implementation based on what the user actually reaches for.

## 48.8 Implementation sequencing

Three phased tickets, each ships independently:

- **HS-7954 — Phase 1: branch + dirty.** Server: `src/git/status.ts` minus ahead/behind; `GET /api/git/status`; chokidar watcher on `.git/index` + `.git/HEAD`; settings keys; gitignore-aware filtering. Client: sidebar chip with branch + total-uncommitted count; muted/yellow tinting; tooltip with breakdown. No fetch button, no expanded panel. Most of the architecture lands here; remaining tickets are pure additions.
- **HS-7955 — Phase 2: ahead/behind + fetch.** Server: extend `getGitStatus` with upstream + ahead + behind; `POST /api/git/fetch`; `command_log` entry on fetch; auto-fetch timer if interval > 0. Client: extend chip with ahead/behind glyphs + amber/blue tints; "Fetch now" button (initially in tooltip; expanded popover lands in HS-7956); tab-focus-triggered refetch.
- **HS-7956 — Phase 3: expanded panel.** Click-to-open popover with full breakdown + per-bucket file lists + "Fetch now" + Phase 3 file-row interactions (click → reveal in finder via `openInFileManager`).

Each implementation ticket should:

1. Update [docs/ai/code-summary.md](ai/code-summary.md): new `src/git/` directory, new `src/routes/git.ts`, new client module, new settings keys, new `command_log` event type.
2. Update [docs/ai/requirements-summary.md](ai/requirements-summary.md): flip §48 entry from Design → Partial (after Phase 1) → Partial (after Phase 2) → Shipped (after Phase 3).
3. Update this doc with implementation notes per the existing pattern (e.g. "**HS-7954 implementation:** new file at `src/git/status.ts` …").

## 48.9 Related

- §1 Overview — local-first developer focus.
- §2 Data & storage — settings.json schema home for the new keys.
- §5 Attachments — `openInFileManager` Tauri command Phase 3 reuses.
- §9 API — REST endpoint reference (add `/api/git/status` and `/api/git/fetch`).
- §14 Commands log — receives `git_status` events.
- §22 Terminal — alternative path the user has today (drop into terminal, run `git status`).
- §29 OSC 7 CWD tracking — terminal-toolbar chip already shows the shell's cwd; the sidebar git chip is the project-level companion.
