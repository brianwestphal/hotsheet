# 6. Markdown Sync & AI Integration

## Functional Requirements

### 6.1 Worklist Export

- Tickets flagged as Up Next are exported to `.hotsheet/worklist.md`, sorted by priority.
- The file includes:
  - Workflow instructions with curl examples for updating ticket status via the API.
  - Ticket creation instructions with curl examples.
  - Feedback request instructions (`FEEDBACK NEEDED:` and `IMMEDIATE FEEDBACK NEEDED:` note prefixes) — see [21-feedback.md](21-feedback.md).
  - Per-ticket details: ID, type, priority, status, title, details, notes (with timestamps), and attachment list.
  - A category descriptions reference.
  - Guidance that status updates and completion notes are required.
- Updated on a 500ms debounce after any ticket change.

### 6.2 Auto-Prioritize Mode

When the "Auto-prioritize tickets" setting is enabled (default: on) and the Up Next list is empty, the worklist includes an "Auto-Prioritize" section instead of "No items in the Up Next list." This instructs the AI to:

1. Read `.hotsheet/open-tickets.md` to evaluate all open tickets.
2. Choose the most important ticket(s) based on priority, urgency, and dependencies.
3. Mark them as Up Next via the API.
4. Then proceed to work through them normally.

This allows the AI to self-direct when no explicit priorities have been set by the user. The setting is stored as `auto_order` in the database settings table.

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

### 6.5 Copy AI Prompt

- The sidebar includes a "Copy AI prompt" button that copies a short prompt (e.g., "Read .hotsheet/worklist.md for current work items.") to the clipboard.
- Intended for pasting into AI tools that don't support skills/rules natively.

### 6.6 AI Tool Skill Generation

The application detects installed AI tools and generates skill/rule files that allow those tools to interact with Hot Sheet. Files are only regenerated when the skill version changes.

Skill installation is checked proactively at multiple points:
- **App launch**: Initial check during server startup.
- **Project tab switch**: When switching to a different project tab, skills are ensured for that project.
- **Channel enable**: When toggling Claude Channel integration on, skills are checked before the channel can be used.
- **Play button / action buttons**: Before triggering Claude or running shell commands, skills are verified.
- **`POST /api/ensure-skills`**: Dedicated endpoint that checks and updates skills, returning `{ updated: boolean }`.

#### Claude Code (`.claude/`)
- Creates skill files in `.claude/skills/`: a main `hotsheet` skill (read worklist and work through items) and per-category ticket creation skills (hs-bug, hs-feature, hs-task, hs-issue, hs-investigation, hs-requirement-change).
- Configures permissions in `.claude/settings.json` with curl access patterns covering ports 4170-4189.
- Each skill has YAML frontmatter (name, description, allowed-tools).

#### Cursor (`.cursor/`)
- Creates rule files in `.cursor/rules/`: `hotsheet.mdc` (main) and per-category `.mdc` files.
- Uses Cursor's `.mdc` format with YAML frontmatter (description, alwaysApply: false).

#### GitHub Copilot (`.github/`)
- Creates prompt files in `.github/prompts/`: `hotsheet.prompt.md` (main) and per-category `.prompt.md` files.
- Only generated if `.github/prompts/` or `.github/copilot-instructions.md` already exists.
- Uses YAML frontmatter (description).

#### Windsurf (`.windsurf/`)
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

- Skill files use a port range pattern (4170-4189) rather than a specific port, so they remain valid across port changes.
