# 6. Markdown Sync & AI Integration

## Functional Requirements

### 6.1 Worklist Export

- Tickets flagged as Up Next are exported to `.hotsheet/worklist.md`, sorted by priority.
- The file includes:
  - Workflow instructions with curl examples for updating ticket status via the API.
  - Ticket creation instructions with curl examples.
  - Feedback request instructions (`FEEDBACK NEEDED:` and `IMMEDIATE FEEDBACK NEEDED:` note prefixes) — see [21-feedback.md](21-feedback.md).
  - **Note formatting guidance** (HS-7828) telling the AI that notes render as Markdown in the Hot Sheet UI and to use real Markdown structure (paragraph breaks, bullet lists, **bold**, `inline code`, `### Headings`) instead of walls of plain text. Notes longer than ~6 lines should lead with a `**TL;DR:**` line so a reader scanning the notes column gets the high bit immediately. Includes an example shape (TL;DR + Root cause + Fix + Tests sections) and a practical tip to write longer JSON payloads to a temp file and use `curl --data-binary @/tmp/notes.json` rather than inlining (avoids shell-escaping pain on backticks, dollar signs, quotes).
  - Per-ticket details: ID, type, priority, status, title, details, notes (with timestamps), and attachment list.
  - A category descriptions reference.
  - Guidance that status updates and completion notes are required.
  - **Optional per-project preamble** (HS-8917) — see §6.1.1.
- Updated on a 500ms debounce after any ticket change.

#### 6.1.1 Worklist preamble (limited customization)

From the HS-8914 investigation: the worklist is mostly a **protocol document** the channel / `/hotsheet` skill / MCP tools depend on (status-update + signal-done commands, the `FEEDBACK NEEDED:` prefixes, the per-ticket block format), so the template itself is **not** user-replaceable — mangling it would silently break the auto-loop. Durable "how to work on this project" guidance belongs in `CLAUDE.md` instead (see [86-ai-assistant-setup.md](86-ai-assistant-setup.md)).

What **is** customizable is an additive, free-text **preamble**: the `worklist_preamble` string setting (`<dataDir>/settings.json`, edited via Settings → General) is injected under a `## Project Notes` heading near the top of `worklist.md` — after the intro line, **before** the protocol sections — so it can't corrupt the contract. It's omitted entirely when unset/blank. Rendered by the pure `buildPreambleSection` in `src/sync/markdown.ts`; the `/file-settings` PATCH handler calls `scheduleAllSync` when the key changes so the worklist regenerates immediately. Intro-line override, optional-section toggles, and full template replacement were considered and deliberately deferred (HS-8914).

### 6.2 Auto-Prioritize Mode

When the "Auto-prioritize tickets" setting is enabled (default: on) and the Up Next list is empty, the worklist includes an "Auto-Prioritize" section instead of "No items in the Up Next list." This instructs the AI to:

1. Read `.hotsheet/open-tickets.md` to evaluate all open tickets.
2. Choose the most important ticket(s) based on priority, urgency, and dependencies.
3. Mark them as Up Next via the API.
4. Then proceed to work through them normally.

This allows the AI to self-direct when no explicit priorities have been set by the user. The setting is stored as `auto_order` in the file-based project settings (`<dataDir>/settings.json`, read via `src/db/settings.ts`) — per [2-data-storage.md](2-data-storage.md) §2.3 the DB settings table now holds only plugin keys.

### 6.3 Open Tickets Export

- All open tickets (not_started and started) are exported to `.hotsheet/open-tickets.md`, grouped by status.
- Includes ticket count and the same per-ticket format as the worklist.
- Updated on a 5-second debounce after any ticket change.

### 6.4 Sync Triggers

Both markdown files are regenerated on:
- Ticket creation, update, or deletion
- Status changes
- Category or priority changes
- Notes appended
- Attachments added or removed
- Batch operations

### 6.5 Copy AI Prompt (REMOVED in HS-8528)

> **HS-8528 (2026-05-22) — removed.** The sidebar "Copy AI prompt" button (`.sidebar-copy-prompt` + `#copy-prompt-btn`) is gone. AI tools now consume the worklist via the `hotsheet_*` MCP tools (Phase 1/2 — HS-8346 / HS-8347) or by reading `.hotsheet/worklist.md` directly. The one-shot copy-to-clipboard surface is no longer necessary. The `GET /api/worklist-info` endpoint that backed it is still alive on the wire — its `skillCreated` flag drives the §6.6 skills-banner trigger via `initSkillsBanner` (formerly `bindCopyPrompt`) — but its `prompt` field is no longer consumed by any client surface and could be dropped in a future cleanup.

### 6.6 AI Tool Skill Generation

The application detects installed AI tools and generates skill/rule files that allow those tools to interact with Hot Sheet. Files are only regenerated when the skill version changes.

**HS-8486 (2026-05-22) — detection gate changed from "AI tool's project folder exists" to "AI tool's CLI is installed on PATH."** Pre-fix the user's first launch of the AI tool ran without the Hot Sheet skill in scope: the dotfolder (`.claude` / `.cursor` / `.windsurf`) only existed AFTER the first launch, but Hot Sheet only installed skills when the dotfolder existed → race lost on first run. Post-fix `ensureSkillsForDir` probes `PATH` for the matching executable (`claude`, `cursor`, `windsurf`) and installs the skill if the binary is found, AS WELL AS the legacy folder-presence check (preserved as a fallback so projects in the old state stay covered). The Claude path also `mkdirSync`s `.claude` before writing settings — pre-fix `ensureClaudePermissions` assumed the folder existed because the legacy gate required it. **Copilot retains the folder-only gate** (no reliable executable name — GitHub Copilot lives as a VS Code extension, not a stand-alone CLI). **Also fixed in HS-8486:** `src/projects.ts::registerProject` was calling `ensureSkills()` (which uses `process.cwd()`) instead of `ensureSkillsForDir(projectRoot)` — wrong project root in the multi-project Tauri path where CWD is the binary's start dir, not the project being opened.

**HS-8706 (2026-06-02) — the SAME cwd bug, but on the primary-startup path, was the actual installed-app launch hang.** HS-8486 fixed `registerProject`'s Open-Folder path but left `src/cli.ts::startAndConfigure` (the primary launch) still calling `ensureSkills()` → `process.cwd()`. A Tauri GUI launch spawns the sidecar with `cwd = /`, so with `claude` on PATH the writer ran `mkdirSync('/.claude')` → `ENOENT` → the unhandled throw FATAL-exited the server moments after it began listening, leaving the "Starting Hot Sheet…" splash spinning forever. A direct-from-terminal launch worked only by accident — its CWD happened to be the project root. Fix: `startAndConfigure` now installs via `ensureSkillsForDir(resolve(dataDir).replace(/\/\.hotsheet\/?$/, ''))` (project root derived from `dataDir`, matching `registerProject`), AND the call is wrapped in `try/catch` so a skill-write failure degrades to a `[skills]` warning instead of ever aborting an already-listening server. Pinned by `src/launchReadinessContract.test.ts` (cli wiring) + `src/skills.test.ts` (cwd-independence + non-throwing behavior).

Skill installation is checked proactively at multiple points:
- **App launch**: Initial check during server startup.
- **Project registration**: When a new project is registered via `Open Folder` (HS-8486 — fixed to use the registered project's root rather than `process.cwd()`), so skills are installed as soon as the folder is selected.
- **Project tab switch**: When switching to a different project tab, skills are ensured for that project.
- **Channel enable**: When toggling Claude Channel integration on, skills are checked before the channel can be used.
- **Play button / action buttons**: Before triggering Claude or running shell commands, skills are verified.
- **`POST /api/ensure-skills`**: Dedicated endpoint that checks and updates skills, returning `{ updated: boolean }`.

#### Claude Code (`.claude/`)
- Gate (HS-8486): `claude` is on PATH OR `.claude/` already exists in the project root.
- Creates skill files in `.claude/skills/`: a main `hotsheet` skill (read worklist and work through items) and per-category ticket creation skills (hs-bug, hs-feature, hs-task, hs-issue, hs-investigation, hs-requirement-change).
- Configures permissions in `.claude/settings.json` with curl access patterns covering ports 4170-4199.
- Each skill has YAML frontmatter (name, description, allowed-tools).

#### Cursor (`.cursor/`)
- Gate (HS-8486): `cursor` is on PATH OR `.cursor/` already exists in the project root.
- Creates rule files in `.cursor/rules/`: `hotsheet.mdc` (main) and per-category `.mdc` files.
- Uses Cursor's `.mdc` format with YAML frontmatter (description, alwaysApply: false).

#### GitHub Copilot (`.github/`)
- Gate: `.github/prompts/` OR `.github/copilot-instructions.md` exists. **Folder-only** — Copilot has no reliable CLI to probe for (it lives as a VS Code extension), so the HS-8486 PATH-based detection doesn't apply here.
- Creates prompt files in `.github/prompts/`: `hotsheet.prompt.md` (main) and per-category `.prompt.md` files.
- Uses YAML frontmatter (description).

#### Windsurf (`.windsurf/`)
- Gate (HS-8486): `windsurf` is on PATH OR `.windsurf/` already exists in the project root.
- Creates rule files in `.windsurf/rules/`: `hotsheet.md` (main) and per-category `.md` files.
- Uses YAML frontmatter (trigger: manual, description).

#### Ticket Creation Skills
- All per-category skills parse user input for "next", "up next", or "do next" prefix to set `up_next: true`.
- Create tickets via curl POST to the local API.
- Report the created ticket number and title.

### 6.7 Skills Notification

- When skill files are created or updated, a one-time banner is shown in the UI advising the user to restart their AI tool.
- The banner is dismissable and only shown once per server session.

### 6.8 Version Tracking

- Generated skill files include a version comment (e.g., `<!-- hotsheet-skill-version: 2 -->`).
- Files are only regenerated when the embedded skill version is higher than the existing file's version.
- **HS-7992 → HS-8022 (removed).** A previous build added a per-project `hotsheet_skill_clear_context` toggle in Settings → General that prepended `/clear` to the main `/hotsheet` skill body, intended to make Claude Code clear its context before processing the worklist. **The mechanism never worked**: skill bodies are returned to the model as Skill tool *output*, not typed at the REPL prompt, so the Claude Code CLI never re-parsed the prefix as a slash command and the model itself cannot invoke slash commands. The Claude Code skill frontmatter spec (`name`, `description`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`) has no `clear-context` equivalent, and skill hooks fire shell commands rather than slash commands. HS-8022 removed the toggle, the `/clear` prefix logic in `mainSkillBody`, the regen-on-flip handler in `routes/settings.ts`, and the Settings → General checkbox; `regenerateMainSkill` is kept exported for any future explicit-user-action regen flow. **Workaround for users who want a fresh context per /hotsheet:** type `/clear` yourself before invoking the skill (or remap `/hotsheet` to a personal alias that does both).

### 6.9 API Secret & Port Recovery

When running multiple Hot Sheet instances, AI tools can accidentally connect to the wrong instance. A secret-based validation mechanism prevents this:

- **Secret generation**: At startup, a secret is generated and stored in `.hotsheet/settings.json` alongside the current `port`. The secret is a SHA-256 hash of the absolute settings.json path + a random value. A path hash is also stored; if the data directory moves, the secret is regenerated on next launch.
- **Secret in requests**: The worklist.md workflow instructions and all generated skill files include the secret as an `X-Hotsheet-Secret` header in curl commands. AI tools send this header with every API request.
- **Server validation**: Mutation requests (POST, PATCH, PUT, DELETE) **require** the correct secret header unless the request is from a browser (Origin or Referer header matches a `localhost` or `127.0.0.1` pattern). If the header is present but wrong, or absent on a non-browser mutation, the server returns HTTP 403 with recovery instructions. GET requests are allowed without the secret (for browser polling and status checks).
- **Port recovery**: Skill files and worklist.md instruct AI tools to re-read `.hotsheet/settings.json` when requests fail (connection refused or 403), as the port or secret may have changed.
- **Channel completion signal**: The `/channel/done` curl command embedded in channel triggers includes the secret header so it passes the middleware.

## Non-Functional Requirements

### 6.10 Debouncing

- Markdown sync is debounced to avoid excessive file writes during rapid changes (500ms for worklist, 5s for open-tickets).
- A `flushPendingSyncs()` function cancels pending debounced timeouts and immediately writes both files. Called before channel triggers so Claude always reads up-to-date data.

### 6.11 Portability

- Skill files use a port range pattern (4170-4199) rather than a specific port, so they remain valid across port changes.
